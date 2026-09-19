/**
 * The shared error envelope — META_ERROR_TAXONOMY.md §4b, "Two message
 * fields, not one": every failure carries a customer-facing `laymanMessage`
 * (no jargon, no codes) and an optional `operatorHint` (what to actually do
 * about it, for the account owner / platform console — may reference codes
 * and vendor terminology). Field names match the already-shipped
 * `Classification`/`MetaErrorCodeEntry` shape in
 * `modules/messaging-errors/domain/meta-error-classifier.ts` exactly, so a
 * classifier result can be spread straight into this envelope.
 */
import { z } from "zod";

export const errorEnvelopeSchema = z.object({
  /** A stable machine-readable code for programmatic handling — an `AppErrorCode`, a Meta error code string, or a domain-specific code. */
  code: z.string().min(1),
  /** Customer-facing copy. No Meta/vendor codes, no jargon (§4b writing rules). */
  laymanMessage: z.string().min(1),
  /** Operator/support-facing copy — what to actually do. Absent when there's nothing more to say than the layman message. */
  operatorHint: z.string().min(1).optional(),
  /** Per-field validation issues, when `code` is a validation failure. Keyed by field path. */
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  /** Correlates this error with server-side logs/traces, for support. */
  requestId: z.string().optional(),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
