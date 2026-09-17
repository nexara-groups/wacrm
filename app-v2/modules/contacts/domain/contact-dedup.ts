/**
 * Contact dedup — one contact per normalised E.164 phone number, per
 * account. See META_ERROR_TAXONOMY.md's PhoneNumber header:
 *
 *   "Contact dedup — two different spellings of the same number MUST
 *    normalise to the exact same string, or we silently create duplicate
 *    contacts."
 *
 * This module owns NO normalisation logic of its own — it is entirely
 * built on `parsePhoneNumber` / `tryParsePhoneNumber` / `phoneNumbersEqual`
 * from `packages/domain`, per the module's build instructions ("do not
 * write your own normalisation"). What lives here is purely the *matching*
 * and *grouping* logic that sits on top of that normalisation: given a raw
 * phone string, find the existing contact (if any) it denotes; given a set
 * of contacts, find which ones collide on phone.
 *
 * Pure — no I/O, no DB, no tenancy of its own. Callers are responsible for
 * having already scoped `contacts` to one account before calling in here;
 * dedup is meaningless across accounts (two different businesses can each
 * have a contact for the same real phone number).
 */
import { err, ok, type Result } from "@shared/result";
import { AppError } from "@shared/errors";
import {
  phoneNumbersEqual,
  tryParsePhoneNumber,
  type CountryCode,
  type PhoneNumber,
} from "../../../packages/domain/src/phone-number";

export interface HasPhoneNumber {
  readonly phoneNumber: PhoneNumber;
}

/**
 * Parses `raw` into the canonical dedup key (a `PhoneNumber`), returning a
 * `Result` instead of throwing — the shape every call site in this module
 * (CSV import, contact creation) wants, since an unparseable phone number
 * is an expected, per-row/per-request outcome, not a programmer error.
 *
 * The error message is layman-safe per META_ERROR_TAXONOMY.md §4b ("No
 * jargon ... Say what happened") — no "E.164", no regex/parse terminology.
 */
export function resolveDedupKey(
  raw: string,
  defaultCountry: CountryCode = "IN",
): Result<PhoneNumber> {
  const parsed = tryParsePhoneNumber(raw, defaultCountry);
  if (!parsed) {
    return err(
      AppError.validation(
        `"${raw}" doesn't look like a valid phone number. Check the country code and digits.`,
      ),
    );
  }
  return ok(parsed);
}

/**
 * Finds the contact (if any) in `contacts` whose normalised phone matches
 * `rawPhone` — the two-different-spellings guarantee in practice. `contacts`
 * must already be scoped to a single account by the caller.
 */
export function findContactByRawPhone<T extends HasPhoneNumber>(
  contacts: readonly T[],
  rawPhone: string,
  defaultCountry: CountryCode = "IN",
): T | undefined {
  const key = tryParsePhoneNumber(rawPhone, defaultCountry);
  if (!key) return undefined;
  return contacts.find((c) => c.phoneNumber === key);
}

/** Re-exported for callers that want the raw equality check without a contact list. */
export { phoneNumbersEqual };

export interface DedupGroup<T extends HasPhoneNumber> {
  readonly phone: PhoneNumber;
  /** The earliest entry in input order — treated as the surviving record. */
  readonly canonical: T;
  /** Every other entry sharing the same normalised phone, in input order. */
  readonly duplicates: readonly T[];
}

/**
 * Finds groups of contacts within `contacts` that collide on normalised
 * phone number. In steady state this should never find anything — the
 * `(account_id, phone)` unique index (see db/migrations/*/0007_contacts.sql)
 * prevents it at insert time — but it exists as a pure, testable audit
 * utility for legacy/imported data that predates the constraint, and as
 * the building block CSV import matching is built on.
 */
export function findDuplicateContacts<T extends HasPhoneNumber>(
  contacts: readonly T[],
): readonly DedupGroup<T>[] {
  const byPhone = new Map<PhoneNumber, T[]>();
  for (const contact of contacts) {
    const existing = byPhone.get(contact.phoneNumber);
    if (existing) {
      existing.push(contact);
    } else {
      byPhone.set(contact.phoneNumber, [contact]);
    }
  }

  const groups: DedupGroup<T>[] = [];
  for (const [phone, group] of byPhone) {
    if (group.length > 1) {
      const [canonical, ...duplicates] = group as [T, ...T[]];
      groups.push({ phone, canonical, duplicates });
    }
  }
  return groups;
}
