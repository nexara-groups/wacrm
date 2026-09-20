/**
 * Contacts — create, update, get, list (filter by tag, search, pagination),
 * delete, CSV import, and the suppression/consent view.
 *
 * See META_ERROR_TAXONOMY.md §3b/§4/§4b for the consent/deliverability
 * vocabulary and the "two message fields, not one" rule this reuses via
 * `errorEnvelopeSchema`.
 */
import { z } from "zod";
import {
  accountIdSchema,
  contactIdSchema,
  isoDateTimeSchema,
  phoneNumberSchema,
  rawPhoneNumberInputSchema,
} from "./common/ids";
import { apiResult } from "./common/response";
import { paginatedResponseSchema, paginationQuerySchema } from "./common/pagination";
import { consentStateSchema, countryCodeSchema, deliverabilityStateSchema, optOutScopeSchema, optOutSourceSchema } from "./common/vocab";

// ---------------------------------------------------------------------------
// The Contact resource
// ---------------------------------------------------------------------------

/**
 * NOTE (module-vs-contract disagreement): domain's `Contact` entity
 * (packages/domain/src/entities/contact.ts) has NO `tags` field at all, yet
 * this package's build brief explicitly requires "list ... filter by tag".
 * No `tags` concept exists anywhere in the phase-0 docs or in domain either
 * — it is pure contracts-side anticipation of a feature that has not been
 * designed upstream. Modelled here as a plain `string[]` (no dedicated
 * `TagId` brand exists to reuse) so the contract at least exists; the
 * persistence/domain design for tags remains undone.
 */
export const contactSchema = z.object({
  id: contactIdSchema,
  accountId: accountIdSchema,
  phoneNumber: phoneNumberSchema,
  displayName: z.string().min(1).max(200).nullable(),
  email: z.email().nullable(),
  tags: z.array(z.string().min(1).max(60)).default([]),

  consentState: consentStateSchema,
  optedOutAt: isoDateTimeSchema.nullable(),
  optOutSource: optOutSourceSchema.nullable(),
  optOutEvidence: z.string().min(1).nullable(),
  optOutScope: optOutScopeSchema,

  deliverabilityState: deliverabilityStateSchema,
  suppressedAt: isoDateTimeSchema.nullable(),
  suppressedReasonCode: z.string().min(1).nullable(),
  suppressionStrikes: z.number().int().min(0),

  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Contact = z.infer<typeof contactSchema>;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const createContactRequestSchema = z.object({
  phoneNumber: rawPhoneNumberInputSchema,
  defaultCountry: countryCodeSchema.default("IN"),
  displayName: z.string().min(1).max(200).optional(),
  email: z.email().optional(),
  tags: z.array(z.string().min(1).max(60)).max(50).optional(),
});
export type CreateContactRequest = z.infer<typeof createContactRequestSchema>;

export const createContactResponseSchema = apiResult({ contact: contactSchema });
export type CreateContactResponse = z.infer<typeof createContactResponseSchema>;

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export const updateContactRequestSchema = z.object({
  contactId: contactIdSchema,
  displayName: z.string().min(1).max(200).nullable().optional(),
  email: z.email().nullable().optional(),
  tags: z.array(z.string().min(1).max(60)).max(50).optional(),
});
export type UpdateContactRequest = z.infer<typeof updateContactRequestSchema>;

export const updateContactResponseSchema = apiResult({ contact: contactSchema });
export type UpdateContactResponse = z.infer<typeof updateContactResponseSchema>;

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

export const getContactRequestSchema = z.object({ contactId: contactIdSchema });
export type GetContactRequest = z.infer<typeof getContactRequestSchema>;

export const getContactResponseSchema = apiResult({ contact: contactSchema.nullable() });
export type GetContactResponse = z.infer<typeof getContactResponseSchema>;

// ---------------------------------------------------------------------------
// List — filter by tag, search, pagination
// ---------------------------------------------------------------------------

export const listContactsQuerySchema = paginationQuerySchema.extend({
  tag: z.string().min(1).optional(),
  search: z.string().min(1).max(200).optional(),
  consentState: consentStateSchema.optional(),
  deliverabilityState: deliverabilityStateSchema.optional(),
});
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;

export const listContactsResponseSchema = apiResult(paginatedResponseSchema(contactSchema).shape);
export type ListContactsResponse = z.infer<typeof listContactsResponseSchema>;

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export const deleteContactRequestSchema = z.object({ contactId: contactIdSchema });
export type DeleteContactRequest = z.infer<typeof deleteContactRequestSchema>;

export const deleteContactResponseSchema = apiResult({});
export type DeleteContactResponse = z.infer<typeof deleteContactResponseSchema>;

// ---------------------------------------------------------------------------
// CSV import — META_ERROR_TAXONOMY.md §3b: "Opt-out survives contact
// re-import (matched by phone, consent preserved)" — the import result MUST
// let the caller see exactly which rows were skipped and why, never a bare
// success count.
// ---------------------------------------------------------------------------

export const csvImportRowSchema = z.object({
  phoneNumber: z.string().min(1).max(64),
  displayName: z.string().min(1).max(200).optional(),
  email: z.string().min(1).max(320).optional(),
  tags: z.array(z.string().min(1).max(60)).optional(),
  /** Explicit Do-Not-Contact flag at import time — SEAT... no, META_ERROR_TAXONOMY.md §3b "Operator/importer marks Do-Not-Contact". */
  doNotContact: z.boolean().optional(),
});
export type CsvImportRow = z.infer<typeof csvImportRowSchema>;

export const importContactsRequestSchema = z.object({
  fileName: z.string().min(1).max(255).optional(),
  defaultCountry: countryCodeSchema.default("IN"),
  rows: z.array(csvImportRowSchema).min(1).max(50_000),
});
export type ImportContactsRequest = z.infer<typeof importContactsRequestSchema>;

/** Why one CSV row was rejected outright (never created/updated a contact). */
export const csvRowRejectionReasonSchema = z.enum([
  "invalid_phone_number",
  "invalid_email",
  "duplicate_in_file",
  "missing_required_field",
]);
export type CsvRowRejectionReason = z.infer<typeof csvRowRejectionReasonSchema>;

export const csvRowRejectionSchema = z.object({
  /** 1-based row number as it appeared in the source file, for the operator to find it. */
  rowNumber: z.number().int().min(1),
  reason: csvRowRejectionReasonSchema,
  /** Plain-English explanation for this row — same "no jargon" rule as errorEnvelopeSchema.laymanMessage (META_ERROR_TAXONOMY.md §4b). */
  message: z.string().min(1),
  raw: csvImportRowSchema.partial(),
});
export type CsvRowRejection = z.infer<typeof csvRowRejectionSchema>;

export const importContactsResultSchema = z.object({
  totalRows: z.number().int().min(0),
  createdCount: z.number().int().min(0),
  updatedCount: z.number().int().min(0),
  /** Rows matched to an existing, consent-suppressed number — never re-opted-in by an import (§3b). */
  consentPreservedCount: z.number().int().min(0),
  rejectedCount: z.number().int().min(0),
  rejections: z.array(csvRowRejectionSchema),
});
export type ImportContactsResult = z.infer<typeof importContactsResultSchema>;

export const importContactsResponseSchema = apiResult({ result: importContactsResultSchema });
export type ImportContactsResponse = z.infer<typeof importContactsResponseSchema>;

// ---------------------------------------------------------------------------
// Suppression / consent view — META_ERROR_TAXONOMY.md §3b + §4b "Contact
// detail: a status line with the reason and date". Deliberately keeps the
// "not clearable by any operator" invariant visible IN THE SHAPE, not just
// in prose: `canClearConsent` is typed `z.literal(false)`, so a server that
// tried to report it as clearable would fail its own response validation.
// ---------------------------------------------------------------------------

export const contactSuppressionViewSchema = z.object({
  contactId: contactIdSchema,

  consentState: consentStateSchema,
  /** Plain-English line for the surfaces listed in §4b, e.g. "This person asked to stop receiving messages. You can't message them until they contact you again." */
  consentStatusMessage: z.string().min(1).nullable(),
  optedOutAt: isoDateTimeSchema.nullable(),
  optOutSource: optOutSourceSchema.nullable(),
  optOutEvidence: z.string().min(1).nullable(),
  /** ALWAYS false: opt-out is "NOT clearable by any operator" (§3b) — a `do_not_contact` flag is the business's own flag and is cleared via a separate, ordinary contact-update path, not this suppression view. */
  canClearConsent: z.literal(false),

  deliverabilityState: deliverabilityStateSchema,
  /** e.g. "Can't receive WhatsApp messages — stopped sending on 14 Mar." (§4b). */
  deliverabilityStatusMessage: z.string().min(1).nullable(),
  suppressedAt: isoDateTimeSchema.nullable(),
  suppressedReasonCode: z.string().min(1).nullable(),
  suppressionStrikes: z.number().int().min(0),
  /** True only when `deliverabilityState === "suppressed"` — a technical suppression, reversible by an operator (§4 "Operator override"). */
  canClearSuppression: z.boolean(),
});
export type ContactSuppressionView = z.infer<typeof contactSuppressionViewSchema>;

export const getContactSuppressionViewRequestSchema = z.object({ contactId: contactIdSchema });
export type GetContactSuppressionViewRequest = z.infer<typeof getContactSuppressionViewRequestSchema>;

export const getContactSuppressionViewResponseSchema = apiResult({ view: contactSuppressionViewSchema });
export type GetContactSuppressionViewResponse = z.infer<typeof getContactSuppressionViewResponseSchema>;

/** §4 "Operator override" — clearing a TECHNICAL suppression only; requires a reason, which becomes the audit entry (§4: "who, when, why"). */
export const clearSuppressionRequestSchema = z.object({
  contactId: contactIdSchema,
  reason: z.string().min(1).max(2000),
});
export type ClearSuppressionRequest = z.infer<typeof clearSuppressionRequestSchema>;

export const clearSuppressionResponseSchema = apiResult({ view: contactSuppressionViewSchema });
export type ClearSuppressionResponse = z.infer<typeof clearSuppressionResponseSchema>;
