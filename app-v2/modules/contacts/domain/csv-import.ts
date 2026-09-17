/**
 * CSV import — THE HIGHEST-RISK PIECE IN THIS MODULE.
 *
 * Per META_ERROR_TAXONOMY.md §3b: "Opt-out survives contact re-import —
 * matching by phone, never reset by CSV" and "a CSV re-import that
 * silently resets consent state re-spams everyone who opted out. Match on
 * phone number and preserve consent on import, always."
 *
 * This module is pure and side-effect free: it parses CSV text and turns
 * it, together with the caller's already-loaded list of existing contacts
 * for the account, into an `ImportPlan` — a description of what to create,
 * what to update, and what to reject, with NO further decisions left for
 * the caller to get wrong. In particular:
 *
 *   - Matching is by normalised phone (via `contact-dedup.ts`, which is
 *     itself built entirely on `packages/domain`'s `parsePhoneNumber` — no
 *     home-grown normalisation anywhere in this path).
 *   - An `ImportUpdateRow` NEVER carries a change to `consentState`,
 *     `optedOutAt`, `optOutSource`, `optOutEvidence`, `deliverabilityState`,
 *     `suppressedAt`, `suppressedReasonCode` or `suppressionStrikes` — those
 *     fields do not exist on the type at all, so a caller cannot
 *     accidentally apply them even by mistake. A `do_not_contact` column in
 *     the CSV is honoured ONLY for brand-new contacts
 *     (`ImportCreateRow.requestedDoNotContact`); for a contact that already
 *     exists it has no effect whatsoever, in any state — re-importing an
 *     opted-out (or any other) contact is always a total no-op on their
 *     consent, by construction, not by a runtime check that could be wrong.
 *   - Malformed rows (wrong column count), duplicate phone numbers within
 *     one file, and invalid phone numbers are all reported in `rejected`
 *     with a layman-safe reason (META_ERROR_TAXONOMY.md §4b) — never
 *     silently dropped.
 */
import { err, ok, type Result } from "@shared/result";
import { AppError } from "@shared/errors";
import type { CountryCode, PhoneNumber } from "../../../packages/domain/src/phone-number";
import type { ConsentState } from "../../../packages/domain/src/status/consent-state";
import { resolveDedupKey, type HasPhoneNumber } from "./contact-dedup";
import { validateCustomFieldValue } from "./custom-fields";

// ---------------------------------------------------------------------------
// CSV parsing (RFC4180-ish: quoted fields, embedded commas/newlines, "" escape)
// ---------------------------------------------------------------------------

/** One data row's raw cells, with the 1-based line number it came from (header is row 1). */
export interface RawCsvRow {
  readonly rowNumber: number;
  readonly cells: readonly string[];
}

export interface ParsedCsvTable {
  readonly header: readonly string[];
  readonly rows: readonly RawCsvRow[];
}

/**
 * Parses raw CSV text into rows of raw string cells. Handles a leading
 * UTF-8 BOM, `"`-quoted fields (with `""` as an escaped quote and embedded
 * commas/newlines inside quotes), and both `\n` and `\r\n` line endings.
 * Purely syntactic — no header interpretation, no validation.
 */
export function parseCsvRows(text: string): readonly (readonly string[])[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let touched = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      touched = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      touched = true;
    } else if (ch === "\r") {
      // handled on the paired \n (or ignored if bare)
      continue;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      touched = false;
    } else {
      field += ch;
      touched = true;
    }
  }
  if (touched || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** True when a raw row is a blank line (a common trailing-newline artifact), not real data. */
function isBlankRow(cells: readonly string[]): boolean {
  return cells.length === 0 || (cells.length === 1 && cells[0]!.trim().length === 0);
}

/**
 * Parses CSV text into a header row plus numbered data rows (blank lines
 * skipped, not counted as data). Fails only when the file has no header
 * row at all — everything else becomes a per-row rejection later.
 */
export function parseCsvTable(text: string): Result<ParsedCsvTable> {
  const allRows = parseCsvRows(text).filter((r) => !isBlankRow(r));
  const [header, ...rest] = allRows;
  if (!header) {
    return err(AppError.validation("This file is empty. Add a header row and at least one contact."));
  }
  const rows: RawCsvRow[] = rest.map((cells, idx) => ({ rowNumber: idx + 2, cells }));
  return ok({ header: header.map((h) => h.trim()), rows });
}

// ---------------------------------------------------------------------------
// Header interpretation
// ---------------------------------------------------------------------------

const HEADER_ALIASES = {
  phone: ["phone", "phone_number", "mobile", "whatsapp", "whatsapp_number"],
  name: ["name", "display_name", "full_name", "contact_name"],
  email: ["email", "email_address"],
  company: ["company", "organization", "organisation", "business"],
  doNotContact: ["do_not_contact", "dnd", "opt_out", "optout"],
  tags: ["tags", "tag"],
} as const;

function normalizeHeaderCell(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

export interface CustomFieldColumn {
  readonly index: number;
  readonly key: string;
  readonly label: string;
}

export interface HeaderMap {
  readonly phoneIndex: number | null;
  readonly nameIndex: number | null;
  readonly emailIndex: number | null;
  readonly companyIndex: number | null;
  readonly doNotContactIndex: number | null;
  readonly tagsIndex: number | null;
  readonly customFieldColumns: readonly CustomFieldColumn[];
}

function findIndex(normalized: readonly string[], aliases: readonly string[]): number | null {
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return null;
}

export function resolveHeaderMap(header: readonly string[]): HeaderMap {
  const normalized = header.map(normalizeHeaderCell);
  const phoneIndex = findIndex(normalized, HEADER_ALIASES.phone);
  const nameIndex = findIndex(normalized, HEADER_ALIASES.name);
  const emailIndex = findIndex(normalized, HEADER_ALIASES.email);
  const companyIndex = findIndex(normalized, HEADER_ALIASES.company);
  const doNotContactIndex = findIndex(normalized, HEADER_ALIASES.doNotContact);
  const tagsIndex = findIndex(normalized, HEADER_ALIASES.tags);

  const reserved = new Set(
    [phoneIndex, nameIndex, emailIndex, companyIndex, doNotContactIndex, tagsIndex].filter(
      (i): i is number => i !== null,
    ),
  );

  const customFieldColumns: CustomFieldColumn[] = [];
  normalized.forEach((_, index) => {
    if (reserved.has(index)) return;
    const label = header[index]!.trim();
    if (label.length === 0) return;
    customFieldColumns.push({ index, key: normalized[index]!, label });
  });

  return { phoneIndex, nameIndex, emailIndex, companyIndex, doNotContactIndex, tagsIndex, customFieldColumns };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface ImportRowRejection {
  readonly rowNumber: number;
  /** Layman-safe reason — no jargon, no internal codes (META_ERROR_TAXONOMY.md §4b). */
  readonly reason: string;
  readonly raw: readonly string[];
}

export interface ImportCreateRow {
  readonly rowNumber: number;
  readonly phone: PhoneNumber;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly company: string | null;
  readonly requestedDoNotContact: boolean;
  readonly tags: readonly string[];
  readonly customFields: ReadonlyMap<string, { readonly label: string; readonly raw: string }>;
}

export interface ContactProfilePatch {
  readonly displayName?: string | null;
  readonly email?: string | null;
  readonly company?: string | null;
}

/** The minimum shape an existing contact must have for import matching — reuses
 *  `Contact` fields from packages/domain rather than redefining them. */
export type ExistingImportContact = HasPhoneNumber & {
  readonly consentState: ConsentState;
};

/**
 * An update row for a contact that ALREADY EXISTS (matched by phone). Note
 * what this type does NOT have: any field named `consentState`,
 * `optedOutAt`, `optOutSource`, `optOutEvidence`, `deliverabilityState`,
 * `suppressedAt`, `suppressedReasonCode` or `suppressionStrikes` — those
 * are structurally absent, not merely left `undefined`. Per this module's
 * build instructions: "An import may only add contacts and update
 * non-consent fields (name, email, company, custom fields)." A `do_not_contact`
 * column in the CSV is honoured ONLY when the row creates a brand-new
 * contact (`ImportCreateRow.requestedDoNotContact`); for an existing
 * contact it is silently ignored — there is no code path in this module
 * that can turn it into a consent change on an existing row, by
 * construction, so a re-import can never touch consent for a contact that
 * already exists, regardless of that contact's current state.
 */
export interface ImportUpdateRow<T extends ExistingImportContact> {
  readonly rowNumber: number;
  readonly existing: T;
  readonly profileChanges: ContactProfilePatch;
  readonly tags: readonly string[];
  readonly customFields: ReadonlyMap<string, { readonly label: string; readonly raw: string }>;
}

export interface ImportPlan<T extends ExistingImportContact> {
  readonly toCreate: readonly ImportCreateRow[];
  readonly toUpdate: readonly ImportUpdateRow<T>[];
  readonly rejected: readonly ImportRowRejection[];
  readonly totalDataRows: number;
}

export interface PlanContactImportOptions {
  readonly defaultCountry?: CountryCode;
}

function cellAt(cells: readonly string[], index: number | null): string | null {
  if (index === null) return null;
  const value = cells[index];
  return value === undefined ? null : value.trim();
}

function nonEmpty(value: string | null): string | null {
  return value !== null && value.length > 0 ? value : null;
}

/**
 * Turns a parsed CSV table plus the caller's already-loaded existing
 * contacts (for one account — tenancy is the caller's responsibility, this
 * function has no notion of it) into an `ImportPlan`. Never throws.
 */
export function planContactImport<T extends ExistingImportContact>(
  table: ParsedCsvTable,
  existingContacts: readonly T[],
  options: PlanContactImportOptions = {},
): Result<ImportPlan<T>> {
  const headerMap = resolveHeaderMap(table.header);
  if (headerMap.phoneIndex === null) {
    return err(
      AppError.validation(
        "This file doesn't have a phone number column. Add one named \"phone\" and try again.",
      ),
    );
  }

  const defaultCountry = options.defaultCountry ?? "IN";
  const existingByPhone = new Map<PhoneNumber, T>();
  for (const contact of existingContacts) existingByPhone.set(contact.phoneNumber, contact);

  const seenInFile = new Map<PhoneNumber, number>(); // phone -> first row number
  const toCreate: ImportCreateRow[] = [];
  const toUpdate: ImportUpdateRow<T>[] = [];
  const rejected: ImportRowRejection[] = [];

  for (const row of table.rows) {
    if (row.cells.length !== table.header.length) {
      rejected.push({
        rowNumber: row.rowNumber,
        reason: `Row ${row.rowNumber} has ${row.cells.length} column${row.cells.length === 1 ? "" : "s"}, but the file's header has ${table.header.length}. This row was skipped.`,
        raw: row.cells,
      });
      continue;
    }

    const rawPhone = cellAt(row.cells, headerMap.phoneIndex);
    if (!rawPhone || rawPhone.length === 0) {
      rejected.push({
        rowNumber: row.rowNumber,
        reason: `Row ${row.rowNumber} has no phone number. This row was skipped.`,
        raw: row.cells,
      });
      continue;
    }

    const phoneResult = resolveDedupKey(rawPhone, defaultCountry);
    if (!phoneResult.ok) {
      rejected.push({
        rowNumber: row.rowNumber,
        reason: `Row ${row.rowNumber}: ${phoneResult.error.message}`,
        raw: row.cells,
      });
      continue;
    }
    const phone = phoneResult.value;

    const firstSeenAt = seenInFile.get(phone);
    if (firstSeenAt !== undefined) {
      rejected.push({
        rowNumber: row.rowNumber,
        reason: `Row ${row.rowNumber} has the same phone number as row ${firstSeenAt} in this file. Only the first was imported.`,
        raw: row.cells,
      });
      continue;
    }
    seenInFile.set(phone, row.rowNumber);

    const displayName = nonEmpty(cellAt(row.cells, headerMap.nameIndex));
    const email = nonEmpty(cellAt(row.cells, headerMap.emailIndex));
    const company = nonEmpty(cellAt(row.cells, headerMap.companyIndex));
    const tagsCell = cellAt(row.cells, headerMap.tagsIndex);
    const tags = tagsCell ? tagsCell.split(/[,;]/).map((t) => t.trim()).filter((t) => t.length > 0) : [];

    const dncCell = cellAt(row.cells, headerMap.doNotContactIndex);
    const dncResult =
      dncCell !== null
        ? validateCustomFieldValue({ type: "boolean", label: "do_not_contact", options: null }, dncCell)
        : null;
    const requestedDoNotContact = dncResult !== null && dncResult.ok ? dncResult.value.value : false;

    const customFields = new Map<string, { readonly label: string; readonly raw: string }>();
    for (const col of headerMap.customFieldColumns) {
      const value = cellAt(row.cells, col.index);
      if (value !== null && value.length > 0) {
        customFields.set(col.key, { label: col.label, raw: value });
      }
    }

    const existing = existingByPhone.get(phone);
    if (existing) {
      // `requestedDoNotContact` is deliberately NOT read here — see
      // `ImportUpdateRow`'s docstring. An existing contact's consent is
      // never touched by import, so the do_not_contact column only has an
      // effect for brand-new contacts below.
      toUpdate.push({
        rowNumber: row.rowNumber,
        existing,
        profileChanges: {
          ...(displayName !== null ? { displayName } : {}),
          ...(email !== null ? { email } : {}),
          ...(company !== null ? { company } : {}),
        },
        tags,
        customFields,
      });
    } else {
      toCreate.push({
        rowNumber: row.rowNumber,
        phone,
        displayName,
        email,
        company,
        requestedDoNotContact,
        tags,
        customFields,
      });
    }
  }

  return ok({ toCreate, toUpdate, rejected, totalDataRows: table.rows.length });
}
