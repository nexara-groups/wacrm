/**
 * PhoneNumber value object — E.164 normalisation and validation.
 *
 * This is load-bearing for two things:
 *   1. Contact dedup — two different spellings of the same number MUST
 *      normalise to the exact same string, or we silently create duplicate
 *      contacts.
 *   2. Consent matching on CSV re-import (META_ERROR_TAXONOMY.md §3b) — an
 *      opted-out contact must still be recognised as "the same number" no
 *      matter how the re-imported CSV happens to spell it, or we silently
 *      re-spam someone who asked to stop.
 *
 * Both guarantees rest entirely on normalisation being deterministic and
 * country-code-aware. In particular, an Indian number must never be
 * mangled: "9876543210", "09876543210", "+91 98765 43210" and
 * "091-98765-43210" must all collapse to "+919876543210".
 *
 * Deliberately does not attempt full libphonenumber-grade coverage of every
 * country's numbering plan — that is a vendor dependency this package may
 * not take. Instead: a small, explicit table of national significant number
 * (NSN) lengths and trunk prefixes for the countries WACRM is India-first
 * for plus a handful of others, and a strict structural E.164 check for
 * everything else (so already-E.164 input from any country round-trips
 * correctly even when we don't have its NSN length on file).
 */
import { AppError } from "@shared/errors";
import type { Brand } from "./brand";

export type PhoneNumber = Brand<string, "PhoneNumber">;

export type CountryCode = "IN" | "US" | "CA" | "GB" | "AE" | "AU" | "SG";

interface CountryDialInfo {
  /** Calling code digits, no leading "+". */
  readonly callingCode: string;
  /** Valid national significant number lengths (digits, excluding calling code/trunk prefix). */
  readonly nsnLengths: readonly number[];
  /** Domestic trunk prefix dialled before the NSN, if any (e.g. "0" in India/UK/Australia). */
  readonly trunkPrefix?: string;
  /**
   * Optional tighter numbering-plan check beyond length, applied to the NSN
   * once extracted. India's mobile numbers all start 6–9 (post-2003
   * numbering plan) — WhatsApp is a mobile product, so this catches
   * plausible-length-but-impossible numbers like "0000000000" instead of
   * silently accepting them as a "valid" Indian number.
   */
  readonly nsnPattern?: RegExp;
}

const COUNTRY_DIAL_INFO: Record<CountryCode, CountryDialInfo> = {
  IN: { callingCode: "91", nsnLengths: [10], trunkPrefix: "0", nsnPattern: /^[6-9]\d{9}$/ },
  US: { callingCode: "1", nsnLengths: [10] },
  CA: { callingCode: "1", nsnLengths: [10] },
  GB: { callingCode: "44", nsnLengths: [10], trunkPrefix: "0" },
  AE: { callingCode: "971", nsnLengths: [9], trunkPrefix: "0" },
  AU: { callingCode: "61", nsnLengths: [9], trunkPrefix: "0" },
  SG: { callingCode: "65", nsnLengths: [8] },
};

function matchesNumberingPlan(info: CountryDialInfo, nsn: string): boolean {
  if (!info.nsnLengths.includes(nsn.length)) return false;
  if (info.nsnPattern && !info.nsnPattern.test(nsn)) return false;
  return true;
}

// Calling codes sorted longest-first so a "+"-prefixed number is matched
// against the most specific (longest) known calling code before a shorter
// one that happens to be a prefix of it (e.g. "1" vs "971").
const KNOWN_CALLING_CODES = Array.from(
  new Set(Object.values(COUNTRY_DIAL_INFO).map((c) => c.callingCode)),
).sort((a, b) => b.length - a.length);

/** Structural E.164: "+" then 8–15 digits, first digit 1–9. */
const E164_STRUCTURE_RE = /^\+[1-9]\d{7,14}$/;

function stripFormatting(raw: string): string {
  // Keep a leading "+" and digits only; drop spaces, hyphens, dots, parens.
  const hasLeadingPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/[^\d]/g, "");
  return hasLeadingPlus ? `+${digits}` : digits;
}

function invalid(raw: string): never {
  throw AppError.validation(`Not a valid phone number: ${JSON.stringify(raw)}`);
}

/**
 * Parses `raw` into a canonical E.164 `PhoneNumber`. `defaultCountry` is
 * used only when `raw` has no explicit "+" / "00" international prefix —
 * it never overrides an explicit country code already present in `raw`.
 *
 * Throws `AppError` (code `VALIDATION`) on anything that isn't a plausible
 * phone number.
 */
export function parsePhoneNumber(raw: string, defaultCountry: CountryCode = "IN"): PhoneNumber {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    invalid(raw);
  }

  let cleaned = stripFormatting(raw);

  // "00" international prefix (common outside the +country UI convention) -> "+".
  if (!cleaned.startsWith("+") && cleaned.startsWith("00")) {
    cleaned = `+${cleaned.slice(2)}`;
  }

  if (cleaned.startsWith("+")) {
    const digits = cleaned.slice(1);
    if (!E164_STRUCTURE_RE.test(cleaned)) {
      invalid(raw);
    }

    const matchedCode = KNOWN_CALLING_CODES.find((code) => digits.startsWith(code));
    if (matchedCode) {
      const info = Object.values(COUNTRY_DIAL_INFO).find((c) => c.callingCode === matchedCode);
      const nsn = digits.slice(matchedCode.length);
      if (info && !matchesNumberingPlan(info, nsn)) {
        // Known country, but the remainder doesn't match its numbering plan.
        invalid(raw);
      }
    }
    // Unknown calling code: accept on structural E.164 validity alone.
    return cleaned as PhoneNumber;
  }

  // No explicit country code — resolve against defaultCountry's numbering plan.
  const info = COUNTRY_DIAL_INFO[defaultCountry];
  const nationalDigits = cleaned;

  let nsn: string | undefined;

  if (matchesNumberingPlan(info, nationalDigits)) {
    // Bare national number, e.g. "9876543210".
    nsn = nationalDigits;
  } else if (
    info.trunkPrefix &&
    nationalDigits.startsWith(info.trunkPrefix) &&
    matchesNumberingPlan(info, nationalDigits.slice(info.trunkPrefix.length))
  ) {
    // Trunk-prefixed national number, e.g. "09876543210".
    nsn = nationalDigits.slice(info.trunkPrefix.length);
  } else if (
    nationalDigits.startsWith(info.callingCode) &&
    matchesNumberingPlan(info, nationalDigits.slice(info.callingCode.length))
  ) {
    // Calling code typed without the "+", e.g. "919876543210".
    nsn = nationalDigits.slice(info.callingCode.length);
  }

  if (!nsn) {
    invalid(raw);
  }

  const canonical = `+${info.callingCode}${nsn}`;
  if (!E164_STRUCTURE_RE.test(canonical)) {
    invalid(raw);
  }
  return canonical as PhoneNumber;
}

/** Safe (non-throwing) parse — returns `undefined` instead of throwing. */
export function tryParsePhoneNumber(
  raw: string,
  defaultCountry: CountryCode = "IN",
): PhoneNumber | undefined {
  try {
    return parsePhoneNumber(raw, defaultCountry);
  } catch {
    return undefined;
  }
}

export function isValidPhoneNumber(raw: string, defaultCountry: CountryCode = "IN"): boolean {
  return tryParsePhoneNumber(raw, defaultCountry) !== undefined;
}

/** Two inputs denote the same phone number iff they normalise to the same E.164 string. */
export function phoneNumbersEqual(
  a: string,
  b: string,
  defaultCountry: CountryCode = "IN",
): boolean {
  const pa = tryParsePhoneNumber(a, defaultCountry);
  const pb = tryParsePhoneNumber(b, defaultCountry);
  return pa !== undefined && pb !== undefined && pa === pb;
}

/** Identity helper for symmetry with the id types' `toString`-style usage. */
export function phoneNumberToE164(phone: PhoneNumber): string {
  return phone;
}
