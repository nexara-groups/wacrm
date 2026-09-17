/**
 * Broadcasts — create, schedule, start/pause/resume/cancel, retry-failed,
 * audience preview, and the broadcast report.
 *
 * The audience preview and the report both express failures/skips GROUPED
 * BY REASON with a count and a plain-English label per group — never a flat
 * list — per META_ERROR_TAXONOMY.md §4b:
 *   "Audience preview: '3,142 recipients · 180 will be skipped (can't
 *    receive / opted out)'"
 *   "Broadcast report: failures grouped by reason ... '142 couldn't receive
 *    WhatsApp messages · 38 opted out · 12 need an approved template · 8
 *    will retry automatically'. Each group expandable to the contacts."
 */
import { z } from "zod";
import { accountIdSchema, broadcastIdSchema, contactIdSchema, isoDateTimeSchema, templateIdSchema, userIdSchema } from "./common/ids";
import { apiResult } from "./common/response";
import { paginatedResponseSchema, paginationQuerySchema } from "./common/pagination";
import { broadcastStatusSchema, dispositionSchema } from "./common/vocab";

// ---------------------------------------------------------------------------
// The Broadcast resource
// ---------------------------------------------------------------------------

export const broadcastSchema = z.object({
  id: broadcastIdSchema,
  accountId: accountIdSchema,
  name: z.string().min(1).max(200),
  templateId: templateIdSchema,
  status: broadcastStatusSchema,
  scheduledAt: isoDateTimeSchema.nullable(),
  createdBy: userIdSchema,
  totalRecipients: z.number().int().min(0),
  sentCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Broadcast = z.infer<typeof broadcastSchema>;

// ---------------------------------------------------------------------------
// Audience filter — shared by create + preview so "the number they see is
// the number that goes out" (§4b): both endpoints must accept exactly the
// same filter shape or that guarantee silently breaks.
// ---------------------------------------------------------------------------

export const audienceFilterSchema = z.object({
  tags: z.array(z.string().min(1).max(60)).optional(),
  search: z.string().min(1).max(200).optional(),
  /** Explicit contact ids, for a hand-picked audience instead of a filter. */
  contactIds: z.array(contactIdSchema).optional(),
});
export type AudienceFilter = z.infer<typeof audienceFilterSchema>;

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const createBroadcastRequestSchema = z.object({
  name: z.string().min(1).max(200),
  templateId: templateIdSchema,
  audienceFilter: audienceFilterSchema,
  /** Omitted/`null` = save as `draft`, send manually later. */
  scheduledAt: isoDateTimeSchema.nullable().optional(),
});
export type CreateBroadcastRequest = z.infer<typeof createBroadcastRequestSchema>;

export const createBroadcastResponseSchema = apiResult({ broadcast: broadcastSchema });
export type CreateBroadcastResponse = z.infer<typeof createBroadcastResponseSchema>;

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export const scheduleBroadcastRequestSchema = z.object({
  broadcastId: broadcastIdSchema,
  scheduledAt: isoDateTimeSchema,
});
export type ScheduleBroadcastRequest = z.infer<typeof scheduleBroadcastRequestSchema>;

export const scheduleBroadcastResponseSchema = apiResult({ broadcast: broadcastSchema });
export type ScheduleBroadcastResponse = z.infer<typeof scheduleBroadcastResponseSchema>;

// ---------------------------------------------------------------------------
// Lifecycle — start / pause / resume / cancel. One request/response shape
// each (mirrors domain's BroadcastStatus transitions: draft/scheduled ->
// sending -> sent|failed; "sent"/"failed" are terminal).
// ---------------------------------------------------------------------------

export const broadcastActionRequestSchema = z.object({ broadcastId: broadcastIdSchema });
export type BroadcastActionRequest = z.infer<typeof broadcastActionRequestSchema>;

export const broadcastActionResponseSchema = apiResult({ broadcast: broadcastSchema });
export type BroadcastActionResponse = z.infer<typeof broadcastActionResponseSchema>;

export const startBroadcastRequestSchema = broadcastActionRequestSchema;
export type StartBroadcastRequest = BroadcastActionRequest;
export const startBroadcastResponseSchema = broadcastActionResponseSchema;
export type StartBroadcastResponse = BroadcastActionResponse;

export const pauseBroadcastRequestSchema = broadcastActionRequestSchema;
export type PauseBroadcastRequest = BroadcastActionRequest;
export const pauseBroadcastResponseSchema = broadcastActionResponseSchema;
export type PauseBroadcastResponse = BroadcastActionResponse;

export const resumeBroadcastRequestSchema = broadcastActionRequestSchema;
export type ResumeBroadcastRequest = BroadcastActionRequest;
export const resumeBroadcastResponseSchema = broadcastActionResponseSchema;
export type ResumeBroadcastResponse = BroadcastActionResponse;

export const cancelBroadcastRequestSchema = broadcastActionRequestSchema;
export type CancelBroadcastRequest = BroadcastActionRequest;
export const cancelBroadcastResponseSchema = broadcastActionResponseSchema;
export type CancelBroadcastResponse = BroadcastActionResponse;

// ---------------------------------------------------------------------------
// Retry failed — META_ERROR_TAXONOMY.md §1 names the exact bug this fixes:
// "'Retry Failed' button re-queues EVERY failed recipient indiscriminately."
// §2: only TRANSIENT/THROTTLED dispositions are retryable; PERMANENT_NUMBER
// and PERMANENT_CONFIG never are. The response is shaped to make that
// distinction impossible to lose downstream: it reports how many were
// actually requeued vs. how many were left alone and why.
// ---------------------------------------------------------------------------

export const retryFailedRequestSchema = z.object({ broadcastId: broadcastIdSchema });
export type RetryFailedRequest = z.infer<typeof retryFailedRequestSchema>;

export const retryFailedResultSchema = z.object({
  broadcast: broadcastSchema,
  requeuedCount: z.number().int().min(0),
  /** Failed recipients left alone because their disposition is PERMANENT_NUMBER or PERMANENT_CONFIG — never blindly retried. */
  skippedNonRetryableCount: z.number().int().min(0),
});
export type RetryFailedResult = z.infer<typeof retryFailedResultSchema>;

export const retryFailedResponseSchema = apiResult(retryFailedResultSchema.shape);
export type RetryFailedResponse = z.infer<typeof retryFailedResponseSchema>;

// ---------------------------------------------------------------------------
// Audience preview — META_ERROR_TAXONOMY.md §4b. Every skip reason is
// grouped with a count and a plain-English label; `willSendCount +
// skippedCount === totalMatchedCount` and the group counts sum to
// `skippedCount` are enforced by `.refine()` so a server bug that drops a
// group silently fails its OWN response validation instead of shipping a
// number to the operator that doesn't add up.
// ---------------------------------------------------------------------------

export const audienceSkipReasonSchema = z.enum([
  "suppressed_number",
  "opted_out",
  "do_not_contact",
  "duplicate_contact",
  "invalid_phone_number",
]);
export type AudienceSkipReason = z.infer<typeof audienceSkipReasonSchema>;

export const audienceSkipGroupSchema = z.object({
  reason: audienceSkipReasonSchema,
  count: z.number().int().min(1),
  /** e.g. "can't receive WhatsApp messages" / "opted out of messages" — the parenthetical/expandable text in §4b's example line. */
  label: z.string().min(1),
});
export type AudienceSkipGroup = z.infer<typeof audienceSkipGroupSchema>;

export const previewAudienceRequestSchema = z.object({
  audienceFilter: audienceFilterSchema,
});
export type PreviewAudienceRequest = z.infer<typeof previewAudienceRequestSchema>;

export const audiencePreviewSchema = z
  .object({
    totalMatchedCount: z.number().int().min(0),
    willSendCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
    skippedGroups: z.array(audienceSkipGroupSchema),
    /** The rendered §4b headline, e.g. "3,142 recipients · 180 will be skipped (can't receive / opted out)". */
    summary: z.string().min(1),
  })
  .refine((value) => value.willSendCount + value.skippedCount === value.totalMatchedCount, {
    message: "willSendCount + skippedCount must equal totalMatchedCount",
    path: ["totalMatchedCount"],
  })
  .refine(
    (value) => value.skippedGroups.reduce((sum, group) => sum + group.count, 0) === value.skippedCount,
    { message: "skippedGroups counts must sum to skippedCount", path: ["skippedGroups"] },
  );
export type AudiencePreview = z.infer<typeof audiencePreviewSchema>;

export const previewAudienceResponseSchema = apiResult({ preview: audiencePreviewSchema });
export type PreviewAudienceResponse = z.infer<typeof previewAudienceResponseSchema>;

// ---------------------------------------------------------------------------
// Broadcast report — failures grouped by reason (§4b). `disposition` is
// carried alongside `code` so the UI can distinguish "will retry
// automatically" (TRANSIENT/THROTTLED) from a definitive stop
// (PERMANENT_NUMBER/PERMANENT_CONFIG) without re-deriving it from the code.
// ---------------------------------------------------------------------------

export const broadcastFailureGroupSchema = z.object({
  /** The Meta `error_code`, or the synthetic "NETWORK"/"UNKNOWN" keys (see modules/messaging-errors/domain/meta-error-codes.ts). */
  code: z.string().min(1),
  disposition: dispositionSchema,
  /** Customer-facing copy, no Meta codes/jargon — copied from the same `meta_error_codes.layman_message` a single failure's errorEnvelope would carry. */
  laymanMessage: z.string().min(1),
  count: z.number().int().min(1),
});
export type BroadcastFailureGroup = z.infer<typeof broadcastFailureGroupSchema>;

export const getBroadcastReportRequestSchema = z.object({ broadcastId: broadcastIdSchema });
export type GetBroadcastReportRequest = z.infer<typeof getBroadcastReportRequestSchema>;

export const broadcastReportSchema = z.object({
  broadcast: broadcastSchema,
  sentCount: z.number().int().min(0),
  deliveredCount: z.number().int().min(0),
  readCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  pendingCount: z.number().int().min(0),
  /** Sum of every group whose disposition is retryable (TRANSIENT/THROTTLED) — the §4b "8 will retry automatically" figure. */
  willRetryCount: z.number().int().min(0),
  failureGroups: z.array(broadcastFailureGroupSchema),
});
export type BroadcastReport = z.infer<typeof broadcastReportSchema>;

export const getBroadcastReportResponseSchema = apiResult({ report: broadcastReportSchema });
export type GetBroadcastReportResponse = z.infer<typeof getBroadcastReportResponseSchema>;

// ---------------------------------------------------------------------------
// List broadcasts
// ---------------------------------------------------------------------------

export const listBroadcastsQuerySchema = paginationQuerySchema.extend({
  status: broadcastStatusSchema.optional(),
  search: z.string().min(1).max(200).optional(),
});
export type ListBroadcastsQuery = z.infer<typeof listBroadcastsQuerySchema>;

export const listBroadcastsResponseSchema = apiResult(paginatedResponseSchema(broadcastSchema).shape);
export type ListBroadcastsResponse = z.infer<typeof listBroadcastsResponseSchema>;
