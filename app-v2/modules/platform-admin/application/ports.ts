/**
 * Platform-admin repository PORTS — interfaces only.
 *
 * No SQL, no vendor SDK, no `core/database` import — mirrors
 * `modules/organizations/application/ports.ts`. Per
 * `docs/rebuild discussion/phase-0/SUPER_ADMIN_CONSOLE.md` §4: platform
 * queries are cross-tenant by nature, so the architecture guard's
 * per-statement `tenant_id` rule cannot apply to their SQL the way it does
 * for ordinary tenant repositories. The property that is kept instead —
 * "cross-tenant access is rare, named, and logged", not merely unchecked —
 * is enforced right here, at the type level, by two rules that hold for
 * EVERY method below without exception:
 *
 *   1. Every method takes an explicit `VerifiedPlatformPrincipal` argument.
 *      That type (nexara/core/rbac/platform-roles.ts) only exists once a
 *      principal has been confirmed, at authentication time, to hold a
 *      platform role — there is no default/ambient instance of it and no
 *      optional-parameter escape hatch, so a call site with no verified
 *      platform principal in hand has nothing to pass and does not compile.
 *   2. Every method is documented as auditing itself (§4: "reading across
 *      tenants is itself an auditable act") — the real implementation MUST
 *      call `PlatformAuditLogPort.append` before returning, for reads and
 *      writes alike. This file cannot enforce that at the type level (it is
 *      a runtime obligation of the implementation), so it is stated here
 *      once and referenced from every interface below instead of repeated
 *      per method.
 *
 * Tier gating (which `PlatformRole` may call which method) is likewise not
 * encoded in these signatures — that is `PlatformPermissionService`'s job
 * (nexara/core/rbac/platform-permission-service.ts), applied by the
 * application service that sits in front of these ports. A port method being
 * callable is not the same as a given principal being allowed to call it.
 */
import type { PlatformRole, VerifiedPlatformPrincipal } from "@nexara/core/rbac";
import type { TenantId, UserId } from "@shared/types";
import type { PlatformAuditEntry, PlatformAuditLogPort } from "../domain/audit";
import type { ComplianceCase, ComplianceCaseCategory, ComplianceResourceRef, ComplianceScope } from "../domain/compliance-case";

// ---------------------------------------------------------------------------
// §3 "Fleet overview" / "Account detail" / "Activity stream" / "Delivery
// health" — cross-account oversight. NOT gated by tier (spec §2): every
// platform role can call these for every account. Built from the shared
// pre-aggregated rollups (§4 "Serving the fleet view"), never a per-tenant
// fan-out — hence `listFleetOverview` taking no per-account argument at all.
// ---------------------------------------------------------------------------

export interface FleetAccountSummary {
  readonly accountId: TenantId;
  readonly name: string;
  readonly plan: string;
  readonly status: "active" | "suspended" | "onboarding";
  readonly creditBalance: number;
  readonly connectedWaba: string | null;
  readonly lastActivityAt: string | null;
  readonly messageVolume7d: number;
  readonly healthFlag: "ok" | "warning" | "critical";
}

export interface AccountDetail extends FleetAccountSummary {
  readonly members: readonly { readonly userId: UserId; readonly tenantRole: string }[];
  readonly qualityRating: string | null;
  readonly templateInventory: readonly { readonly templateId: string; readonly status: string }[];
  readonly onboardingState: string;
}

export interface ActivityStreamFilter {
  readonly accountId?: TenantId;
  readonly eventType?: string;
  readonly since?: string;
  readonly until?: string;
}

export interface ActivityEvent {
  readonly id: string;
  readonly accountId: TenantId;
  readonly type: string;
  readonly occurredAt: string;
  readonly summary: string;
}

export interface DeliveryHealthFilter {
  readonly accountId?: TenantId;
  readonly since?: string;
}

export interface DeliveryHealthSummary {
  readonly accountId: TenantId;
  readonly errorCounts: Readonly<Record<string, number>>;
  readonly suppressedContacts: number;
  readonly qualityRating: string | null;
  readonly templatePaused: boolean;
}

/** Every method below is oversight-only (read-only) and NOT tier-gated. */
export interface FleetOverviewPort {
  /** §3 "Fleet overview" — every account, from the shared rollups. */
  listFleetOverview(principal: VerifiedPlatformPrincipal): Promise<readonly FleetAccountSummary[]>;

  /** §3 "Account detail" — one tenant's full oversight view. */
  getAccountDetail(principal: VerifiedPlatformPrincipal, accountId: TenantId): Promise<AccountDetail | null>;

  /** §3 "Activity stream" — cross-tenant `EventBus` feed, filterable. */
  listActivity(
    principal: VerifiedPlatformPrincipal,
    filter: ActivityStreamFilter,
  ): Promise<readonly ActivityEvent[]>;

  /** §3 "Delivery health" — the early-warning surface. */
  listDeliveryHealth(
    principal: VerifiedPlatformPrincipal,
    filter: DeliveryHealthFilter,
  ): Promise<readonly DeliveryHealthSummary[]>;
}

// ---------------------------------------------------------------------------
// §3 "Billing ops" / "Support tools" — mutate tenant data. Gated to
// `platform_admin`+ by the application service; the port itself only
// requires the mandatory `reason` every mutation must carry (§5).
// ---------------------------------------------------------------------------

export interface CreditAdjustmentInput {
  readonly accountId: TenantId;
  readonly delta: number;
  readonly reason: string;
}

export interface BillingOpsPort {
  getBillingState(principal: VerifiedPlatformPrincipal, accountId: TenantId): Promise<FleetAccountSummary>;

  /** §3 "manual credit adjustment with mandatory reason". */
  adjustCredit(principal: VerifiedPlatformPrincipal, input: CreditAdjustmentInput): Promise<void>;
}

export interface SupportToolsPort {
  suspendAccount(principal: VerifiedPlatformPrincipal, accountId: TenantId, reason: string): Promise<void>;
  reactivateAccount(principal: VerifiedPlatformPrincipal, accountId: TenantId, reason: string): Promise<void>;
  clearSuppression(
    principal: VerifiedPlatformPrincipal,
    accountId: TenantId,
    contactId: string,
    reason: string,
  ): Promise<void>;
  requeueBroadcast(
    principal: VerifiedPlatformPrincipal,
    accountId: TenantId,
    broadcastId: string,
    reason: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// §5 Impersonation — `platform_admin`+, time-boxed (<=60min), consented,
// recorded, auto-expires.
// ---------------------------------------------------------------------------

export interface ImpersonationSession {
  readonly id: string;
  readonly actorUserId: UserId;
  readonly targetAccountId: TenantId;
  readonly targetUserId: UserId;
  readonly reason: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  readonly endedReason: string | null;
}

export interface ImpersonationPort {
  /** MUST enforce the <=60 minute cap server-side; a caller-supplied longer
   * TTL is clamped, never trusted verbatim. */
  startImpersonation(
    principal: VerifiedPlatformPrincipal,
    targetAccountId: TenantId,
    targetUserId: UserId,
    reason: string,
  ): Promise<ImpersonationSession>;

  endImpersonation(
    principal: VerifiedPlatformPrincipal,
    sessionId: string,
    endedReason: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// §7 Compliance cases — the ONLY path to message content. See
// ../domain/compliance-case.ts for the invariants (`canReadContent`,
// `approveComplianceCase`'s two-person rule). This port persists case
// records and their append-only read trail; it does not itself decide
// whether a read is allowed — the implementation MUST call
// `canReadContent(case, resourceRef, now)` before `readContent` returns
// anything, and MUST append a `ComplianceCaseRead` row for every read
// regardless of outcome.
// ---------------------------------------------------------------------------

export interface OpenComplianceCaseRequest {
  readonly id: string;
  readonly externalRef: string;
  readonly category: ComplianceCaseCategory;
  readonly accountId: TenantId;
  readonly scope: ComplianceScope;
  readonly reason: string;
  readonly disclosureRestricted?: boolean;
}

/** Append-only — `compliance_case_reads` (spec §7 data model). */
export interface ComplianceCaseRead {
  readonly id: string;
  readonly caseId: string;
  readonly actorUserId: UserId;
  readonly resourceType: ComplianceResourceRef["type"];
  readonly resourceId: string;
  readonly readAt: string;
}

export interface ComplianceCaseExport {
  readonly caseId: string;
  readonly actorUserId: UserId;
  readonly format: string;
  readonly watermark: string;
  readonly rowCount: number;
}

export interface ComplianceCasePort {
  /** §7 — opening grants nothing; `approvedBy` starts null. `platform_admin`+. */
  open(principal: VerifiedPlatformPrincipal, request: OpenComplianceCaseRequest): Promise<ComplianceCase>;

  /** §7 two-person rule — the implementation MUST reject `approver === case.openedBy`
   * (see `approveComplianceCase` in ../domain/compliance-case.ts, which this
   * delegates to). `platform_admin`+ or `platform_superadmin`. */
  approve(
    principal: VerifiedPlatformPrincipal,
    caseId: string,
    ttlDays?: number,
  ): Promise<ComplianceCase>;

  close(principal: VerifiedPlatformPrincipal, caseId: string, outcome: string): Promise<ComplianceCase>;

  findById(principal: VerifiedPlatformPrincipal, caseId: string): Promise<ComplianceCase | null>;

  findActiveForAccount(
    principal: VerifiedPlatformPrincipal,
    accountId: TenantId,
  ): Promise<readonly ComplianceCase[]>;

  /**
   * The only content-reading method in this module. MUST internally call
   * `canReadContent` and return `null` (never the content) whenever it
   * returns false — there is no bypass parameter. MUST append a
   * `ComplianceCaseRead` row for every call, successful or not.
   */
  readContent(
    principal: VerifiedPlatformPrincipal,
    caseId: string,
    resourceRef: ComplianceResourceRef,
    now: Date,
  ): Promise<unknown | null>;

  recordExport(principal: VerifiedPlatformPrincipal, exportRecord: ComplianceCaseExport): Promise<void>;
}

// ---------------------------------------------------------------------------
// §5 Platform-role grants — `platform_superadmin` only, 2-person rule.
// ---------------------------------------------------------------------------

export interface PlatformRoleGrant {
  readonly userId: UserId;
  readonly platformRole: PlatformRole;
  readonly grantedBy: UserId;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
}

export interface PlatformRoleGrantPort {
  /** MUST reject `grantedBy === userId` (the same 2-person rule as compliance
   * case approval, §5: "the same rule already applied to platform-role grants"). */
  grant(
    principal: VerifiedPlatformPrincipal,
    userId: UserId,
    role: PlatformRole,
    reason: string,
  ): Promise<PlatformRoleGrant>;

  revoke(principal: VerifiedPlatformPrincipal, userId: UserId, reason: string): Promise<void>;

  findActiveForUser(principal: VerifiedPlatformPrincipal, userId: UserId): Promise<PlatformRoleGrant | null>;

  /**
   * "Does this user hold a platform grant at all?" — the entry point every
   * other method presupposes an answer to.
   *
   * Without this, resolving your own status meant calling
   * `findActiveForUser` with a fabricated principal carrying a made-up
   * role. The lookup itself was safe (it filters on `userId`, and the
   * principal only attributes the audit row), but the audit row is the
   * problem: every visit to a platform page by an ordinary tenant user
   * wrote an entry claiming that user held `platform_support`. An audit
   * log that records roles nobody was granted is not evidence of anything.
   *
   * Takes no principal, because there is none yet, and audits the lookup
   * truthfully as a self-lookup.
   */
  findOwnGrant(userId: UserId): Promise<PlatformRoleGrant | null>;
}

// ---------------------------------------------------------------------------
// Re-exported so a caller can depend on one module for the whole port set.
// ---------------------------------------------------------------------------

export interface PlatformAdminPorts {
  readonly fleetOverview: FleetOverviewPort;
  readonly billingOps: BillingOpsPort;
  readonly supportTools: SupportToolsPort;
  readonly impersonation: ImpersonationPort;
  readonly complianceCases: ComplianceCasePort;
  readonly platformRoleGrants: PlatformRoleGrantPort;
  readonly auditLog: PlatformAuditLogPort;
}

/** Re-exported for convenience alongside the port set above. */
export type { PlatformAuditEntry, PlatformAuditLogPort };
