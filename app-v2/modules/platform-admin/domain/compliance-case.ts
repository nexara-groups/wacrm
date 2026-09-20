import { AppError } from "@shared/errors";
import { err, ok, type Result } from "@shared/result";
import type { TenantId, UserId } from "@shared/types";

/**
 * Compliance cases — answering Meta without standing access.
 *
 * See `docs/rebuild discussion/phase-0/SUPER_ADMIN_CONSOLE.md` §7. This is
 * the ONLY path by which message content becomes readable anywhere in the
 * platform-admin module (see `nexara/core/rbac/platform-permission-service.ts`
 * for why there is no capability-based path). The design, restated as the
 * invariants this file enforces:
 *
 *   - Scope is declared before access, not after (`ComplianceScope`).
 *   - No standing access: a case with no `approvedBy` grants nothing
 *     (`canReadContent`).
 *   - Two-person rule: the approver cannot be the opener (`approveCase`).
 *   - Auto-expiry, enforced at query time, not by a cleanup job: an expired
 *     case denies access even if `closedAt` is still null (`canReadContent`).
 *   - Closing ends access immediately (`canReadContent`).
 */

export const COMPLIANCE_CASE_CATEGORIES = [
  "user_complaint",
  "quality_rating_investigation",
  "policy_violation_review",
  "flagged_template",
  "blocked_number_dispute",
  "legal_request",
] as const;

export type ComplianceCaseCategory = (typeof COMPLIANCE_CASE_CATEGORIES)[number];

export const COMPLIANCE_SCOPE_TYPES = ["message_ids", "contact", "template", "date_range"] as const;

export type ComplianceScopeType = (typeof COMPLIANCE_SCOPE_TYPES)[number];

/**
 * The declared scope of a case, as a discriminated union. `scopeType` and
 * `scopeValue` are carried together (rather than as two independently-typed
 * fields) so it is impossible to construct a case whose `scopeType` says one
 * thing and whose `scopeValue` shape says another — the two spec-named
 * fields are exactly `scope.scopeType` and `scope.scopeValue` below.
 */
export type ComplianceScope =
  | { readonly scopeType: "message_ids"; readonly scopeValue: { readonly messageIds: readonly string[] } }
  | { readonly scopeType: "contact"; readonly scopeValue: { readonly contactId: string } }
  | { readonly scopeType: "template"; readonly scopeValue: { readonly templateId: string } }
  | {
      readonly scopeType: "date_range";
      readonly scopeValue: { readonly from: string; readonly to: string };
    };

/** A single piece of evidence being requested — checked against a case's declared scope. */
export type ComplianceResourceRef =
  | { readonly type: "message_ids"; readonly messageId: string }
  | { readonly type: "contact"; readonly contactId: string }
  | { readonly type: "template"; readonly templateId: string }
  | { readonly type: "date_range"; readonly occurredAt: string };

export type ComplianceCase = ComplianceScope & {
  readonly id: string;
  readonly externalRef: string;
  readonly category: ComplianceCaseCategory;
  readonly accountId: TenantId;
  readonly openedBy: UserId;
  readonly reason: string;
  /** Non-null only once a second person has approved — see `approveCase`. */
  readonly approvedBy: UserId | null;
  readonly approvedAt: string | null;
  /** Set on approval; a case with `approvedBy === null` has `expiresAt === null` too. */
  readonly expiresAt: string | null;
  readonly closedAt: string | null;
  readonly closedBy: UserId | null;
  readonly outcome: string | null;
  readonly tenantNotifiedAt: string | null;
  readonly disclosureRestricted: boolean;
};

const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS = 30;

export interface OpenComplianceCaseInput {
  readonly id: string;
  readonly externalRef: string;
  readonly category: ComplianceCaseCategory;
  readonly accountId: TenantId;
  readonly scope: ComplianceScope;
  readonly openedBy: UserId;
  readonly reason: string;
  readonly disclosureRestricted?: boolean;
}

/**
 * Open a new case. Opening grants nothing by itself — `approvedBy` starts
 * null, so `canReadContent` denies every read until a second person approves.
 */
export function openComplianceCase(input: OpenComplianceCaseInput): ComplianceCase {
  return {
    ...input.scope,
    id: input.id,
    externalRef: input.externalRef,
    category: input.category,
    accountId: input.accountId,
    openedBy: input.openedBy,
    reason: input.reason,
    approvedBy: null,
    approvedAt: null,
    expiresAt: null,
    closedAt: null,
    closedBy: null,
    outcome: null,
    tenantNotifiedAt: null,
    disclosureRestricted: input.disclosureRestricted ?? false,
  };
}

export interface ApproveComplianceCaseOptions {
  /** Injectable for tests; defaults to `new Date()`. */
  readonly now?: Date;
  /** Days until expiry, clamped to [1, 30]; defaults to 7 (spec §7). */
  readonly ttlDays?: number;
}

/**
 * Approve a case — the second step of the two-person rule. REJECTS when
 * `approver === case_.openedBy` (the person who wants the data cannot be the
 * person who authorises it), when the case is already closed, or when it was
 * already approved (approval happens once).
 */
export function approveComplianceCase(
  case_: ComplianceCase,
  approver: UserId,
  options: ApproveComplianceCaseOptions = {},
): Result<ComplianceCase, AppError> {
  if (approver === case_.openedBy) {
    return err(AppError.forbidden("Two-person rule: the approver cannot be the case's opener"));
  }
  if (case_.closedAt !== null) {
    return err(AppError.validation("Cannot approve a closed compliance case"));
  }
  if (case_.approvedBy !== null) {
    return err(new AppError("CONFLICT", "Compliance case is already approved"));
  }

  const now = options.now ?? new Date();
  const ttlDays = Math.min(Math.max(options.ttlDays ?? DEFAULT_TTL_DAYS, 1), MAX_TTL_DAYS);
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  return ok({
    ...case_,
    approvedBy: approver,
    approvedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
}

/** Close a case — access ends immediately regardless of `expiresAt`. */
export function closeComplianceCase(
  case_: ComplianceCase,
  closedBy: UserId,
  outcome: string,
  now: Date = new Date(),
): ComplianceCase {
  return { ...case_, closedAt: now.toISOString(), closedBy, outcome };
}

function isWithinScope(case_: ComplianceCase, ref: ComplianceResourceRef): boolean {
  if (case_.scopeType !== ref.type) return false;

  switch (case_.scopeType) {
    case "message_ids":
      return ref.type === "message_ids" && case_.scopeValue.messageIds.includes(ref.messageId);
    case "contact":
      return ref.type === "contact" && case_.scopeValue.contactId === ref.contactId;
    case "template":
      return ref.type === "template" && case_.scopeValue.templateId === ref.templateId;
    case "date_range": {
      if (ref.type !== "date_range") return false;
      const at = new Date(ref.occurredAt).getTime();
      const from = new Date(case_.scopeValue.from).getTime();
      const to = new Date(case_.scopeValue.to).getTime();
      return at >= from && at <= to;
    }
  }
}

/**
 * The single gate for content access. TRUE only when ALL of:
 *   1. the case is approved (`approvedBy` present — no standing access),
 *   2. the case is not closed,
 *   3. the case is not expired AT `now` (checked every call, not by a
 *      cleanup job — an expired case denies access even if a row still says
 *      open / `closedAt` is still null),
 *   4. the requested `resourceRef` falls inside the case's declared scope.
 *
 * There is deliberately no "browse this account" shortcut: an out-of-scope
 * or wrong-type resourceRef is denied even for an approved, open, unexpired
 * case on the very same account.
 */
export function canReadContent(case_: ComplianceCase, resourceRef: ComplianceResourceRef, now: Date): boolean {
  if (case_.approvedBy === null) return false;
  if (case_.closedAt !== null) return false;
  if (case_.expiresAt === null) return false;
  if (now.getTime() >= new Date(case_.expiresAt).getTime()) return false;

  return isWithinScope(case_, resourceRef);
}
