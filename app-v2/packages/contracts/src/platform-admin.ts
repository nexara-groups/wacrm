/**
 * Platform admin — fleet overview, account detail, activity stream,
 * delivery health.
 *
 * SUPER_ADMIN_CONSOLE.md §5: "Message content: NO browsing capability at
 * any tier. Reachable only inside an approved, scoped, expiring compliance
 * case (§7)." Compliance-case content access is deliberately OUT OF SCOPE
 * for this package (it is not one of the nine schema groups this package
 * was built to cover) — nothing here returns message bodies, and nothing
 * here even has a path that could grow one by accident: every schema below
 * is built from `FleetOverviewPort`'s own return shapes
 * (`modules/platform-admin/application/ports.ts`), which are themselves
 * pre-aggregated rollups (§4 "Serving the fleet view") — counts, states and
 * summaries, never raw per-message content. See
 * `platform-admin.test.ts`'s "no message content" test, which walks every
 * exported schema's fields recursively and fails if a banned field name
 * (body/content/text/...) ever appears here.
 */
import { z } from "zod";
import { accountIdSchema, isoDateTimeSchema, userIdSchema } from "./common/ids";
import { apiResult } from "./common/response";
import { paginatedResponseSchema, paginationQuerySchema } from "./common/pagination";

// ---------------------------------------------------------------------------
// Shared vocabulary — mirrors `FleetAccountSummary` in
// modules/platform-admin/application/ports.ts exactly (`status` and
// `healthFlag` are plain `string` unions there, not yet backed by a
// packages/domain vocabulary module the way Contact/Broadcast/etc. are).
// ---------------------------------------------------------------------------

export const platformAccountStatusSchema = z.enum(["active", "suspended", "onboarding"]);
export type PlatformAccountStatus = z.infer<typeof platformAccountStatusSchema>;

export const accountHealthFlagSchema = z.enum(["ok", "warning", "critical"]);
export type AccountHealthFlag = z.infer<typeof accountHealthFlagSchema>;

// ---------------------------------------------------------------------------
// Fleet overview — SUPER_ADMIN_CONSOLE.md §3. NOT tier-gated (every
// platform role can call it); this package models no tier/permission
// concept at all — that is `PlatformPermissionService`'s job, applied in
// front of these contracts, not encoded in the wire shape.
// ---------------------------------------------------------------------------

export const fleetAccountSummarySchema = z.object({
  accountId: accountIdSchema,
  name: z.string().min(1).max(200),
  plan: z.string().min(1).max(200),
  status: platformAccountStatusSchema,
  creditBalance: z.number(),
  connectedWaba: z.string().min(1).nullable(),
  lastActivityAt: isoDateTimeSchema.nullable(),
  messageVolume7d: z.number().int().min(0),
  healthFlag: accountHealthFlagSchema,
});
export type FleetAccountSummary = z.infer<typeof fleetAccountSummarySchema>;

/**
 * DISAGREEMENT WITH THE ALREADY-BUILT PORT: `FleetOverviewPort.listFleetOverview`
 * (modules/platform-admin/application/ports.ts) takes ONLY a
 * `VerifiedPlatformPrincipal` — no filter, no sort, no pagination
 * parameters at all ("built from the shared pre-aggregated rollups ...
 * never a per-tenant fan-out"). SUPER_ADMIN_CONSOLE.md §3's own prose says
 * "Sort/filter/search" is part of the fleet-overview surface, so this
 * request schema models that anyway — but wiring this contract to the
 * existing port will need the port's signature extended (or filtering
 * pushed entirely into the rollup query the port's implementation builds),
 * not a straightforward pass-through.
 */
export const listFleetOverviewRequestSchema = paginationQuerySchema.extend({
  search: z.string().min(1).max(200).optional(),
  status: platformAccountStatusSchema.optional(),
  healthFlag: accountHealthFlagSchema.optional(),
});
export type ListFleetOverviewRequest = z.infer<typeof listFleetOverviewRequestSchema>;

export const listFleetOverviewResponseSchema = apiResult(paginatedResponseSchema(fleetAccountSummarySchema).shape);
export type ListFleetOverviewResponse = z.infer<typeof listFleetOverviewResponseSchema>;

// ---------------------------------------------------------------------------
// Account detail — SUPER_ADMIN_CONSOLE.md §3. Mirrors `AccountDetail`
// exactly: `members` carries `tenantRole` as a plain string (the port's own
// choice, not this package's `Role` vocab) because SEAT_LIMITS.md §1's
// role-vocabulary conflict — owner/admin/agent/viewer vs.
// owner/admin/manager/member — is explicitly unresolved, and the platform
// console has to display members under EITHER vocabulary depending on
// which one the organizations port ultimately lands on. Kept loose
// deliberately; see `common/vocab.ts`'s `roleSchema` note for the same
// unresolved conflict from the invitations/seats side.
// ---------------------------------------------------------------------------

export const accountMemberSummarySchema = z.object({
  userId: userIdSchema,
  tenantRole: z.string().min(1),
});
export type AccountMemberSummary = z.infer<typeof accountMemberSummarySchema>;

export const templateInventoryEntrySchema = z.object({
  templateId: z.string().min(1),
  status: z.string().min(1),
});
export type TemplateInventoryEntry = z.infer<typeof templateInventoryEntrySchema>;

export const accountDetailSchema = fleetAccountSummarySchema.extend({
  members: z.array(accountMemberSummarySchema),
  qualityRating: z.string().min(1).nullable(),
  templateInventory: z.array(templateInventoryEntrySchema),
  onboardingState: z.string().min(1),
});
export type AccountDetail = z.infer<typeof accountDetailSchema>;

export const getAccountDetailRequestSchema = z.object({ accountId: accountIdSchema });
export type GetAccountDetailRequest = z.infer<typeof getAccountDetailRequestSchema>;

/** `account: null` mirrors the port's `Promise<AccountDetail | null>` — "no such account", not an error. */
export const getAccountDetailResponseSchema = apiResult({ account: accountDetailSchema.nullable() });
export type GetAccountDetailResponse = z.infer<typeof getAccountDetailResponseSchema>;

// ---------------------------------------------------------------------------
// Activity stream — SUPER_ADMIN_CONSOLE.md §3, the framework `EventBus`
// feed. `summary` is a short, pre-written human description of the event
// ("Alice invited bob@example.com as admin") produced by the event
// producer at write time — NEVER a copy of message content. There is no
// field here that could carry a WhatsApp message body.
// ---------------------------------------------------------------------------

export const activityEventSchema = z.object({
  id: z.string().min(1),
  accountId: accountIdSchema,
  type: z.string().min(1),
  occurredAt: isoDateTimeSchema,
  summary: z.string().min(1).max(500),
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const listActivityRequestSchema = paginationQuerySchema.extend({
  accountId: accountIdSchema.optional(),
  eventType: z.string().min(1).optional(),
  since: isoDateTimeSchema.optional(),
  until: isoDateTimeSchema.optional(),
});
export type ListActivityRequest = z.infer<typeof listActivityRequestSchema>;

export const listActivityResponseSchema = apiResult(paginatedResponseSchema(activityEventSchema).shape);
export type ListActivityResponse = z.infer<typeof listActivityResponseSchema>;

// ---------------------------------------------------------------------------
// Delivery health — SUPER_ADMIN_CONSOLE.md §3, "the early-warning surface".
// `errorCounts` is keyed by Meta `error_code` (META_ERROR_TAXONOMY.md §3) —
// aggregate counts only, never a single failure's detail or content.
// ---------------------------------------------------------------------------

export const deliveryHealthEntrySchema = z.object({
  accountId: accountIdSchema,
  /** Meta error code -> occurrence count, e.g. `{ "131026": 142, "131049": 8 }`. */
  errorCounts: z.record(z.string(), z.number().int().min(0)),
  suppressedContacts: z.number().int().min(0),
  qualityRating: z.string().min(1).nullable(),
  templatePaused: z.boolean(),
});
export type DeliveryHealthEntry = z.infer<typeof deliveryHealthEntrySchema>;

export const listDeliveryHealthRequestSchema = z.object({
  accountId: accountIdSchema.optional(),
  since: isoDateTimeSchema.optional(),
});
export type ListDeliveryHealthRequest = z.infer<typeof listDeliveryHealthRequestSchema>;

export const listDeliveryHealthResponseSchema = apiResult({ items: z.array(deliveryHealthEntrySchema) });
export type ListDeliveryHealthResponse = z.infer<typeof listDeliveryHealthResponseSchema>;
