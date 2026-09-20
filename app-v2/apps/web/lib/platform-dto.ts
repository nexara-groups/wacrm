/**
 * Request validation + wire DTOs for the platform (super-admin) console.
 *
 * `packages/contracts/src/platform-admin.ts` exists but only covers
 * `FleetOverviewPort`'s surface (fleet overview / account detail / activity
 * / delivery health) — none of which is wired (see the module's own gap
 * note in `modules/container.ts`). It has NO schemas for compliance cases
 * or the audit log, and `packages/**` is out of scope for this task to
 * extend. So this file is the zod boundary for the routes this task DOES
 * own — every request is validated here before a repository is touched
 * (HARD RULE 3), same discipline as `lib/contact-dto.ts` / `lib/seat-
 * dto.ts`, just local to apps/web instead of shared package.
 *
 * DTOs here are the exact `ComplianceCase` shape
 * (modules/platform-admin/domain/compliance-case.ts) — no message content
 * field exists anywhere on it (the domain type doesn't carry one; content
 * only ever comes back from `ComplianceCasePort.readContent`, which this
 * console deliberately never calls — see AGENTS/report).
 */
import { z } from "zod";
import type { PlatformAuditEntry } from "@modules/platform-admin/domain/audit";
import {
  COMPLIANCE_CASE_CATEGORIES,
  type ComplianceCase,
  type ComplianceCaseCategory,
} from "@modules/platform-admin/domain/compliance-case";
import {
  PLATFORM_CAPABILITIES,
  PlatformPermissionService,
  type PlatformCapability,
  type PlatformRole,
  type VerifiedPlatformPrincipal,
} from "@nexara/core/rbac";
import { accountIdSchema, isoDateTimeSchema } from "@packages/contracts/src/common/ids";

const permissions = new PlatformPermissionService();

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export const complianceCaseCategorySchema = z.enum(COMPLIANCE_CASE_CATEGORIES);

export const complianceScopeSchema = z.discriminatedUnion("scopeType", [
  z.object({
    scopeType: z.literal("message_ids"),
    scopeValue: z.object({ messageIds: z.array(z.string().min(1)).min(1).max(100) }),
  }),
  z.object({
    scopeType: z.literal("contact"),
    scopeValue: z.object({ contactId: z.string().min(1) }),
  }),
  z.object({
    scopeType: z.literal("template"),
    scopeValue: z.object({ templateId: z.string().min(1) }),
  }),
  z.object({
    scopeType: z.literal("date_range"),
    scopeValue: z.object({ from: isoDateTimeSchema, to: isoDateTimeSchema }),
  }),
]);

/**
 * `id` is deliberately NOT accepted from the client — `ComplianceCasePort.
 * open` takes it as a plain field (ports.ts), but a request-supplied
 * primary key is an unnecessary trust surface for no benefit; the route
 * generates it server-side with `randomUUID()`.
 */
export const openComplianceCaseRequestSchema = z.object({
  externalRef: z.string().min(1).max(200),
  category: complianceCaseCategorySchema,
  accountId: accountIdSchema,
  scope: complianceScopeSchema,
  // Meta's own queries require a stated reason (§7); a short placeholder
  // like "x" defeats the purpose of the field, so this requires a real
  // sentence, not just non-empty.
  reason: z.string().trim().min(10).max(2000),
  disclosureRestricted: z.boolean().optional(),
});
export type OpenComplianceCaseRequestBody = z.infer<typeof openComplianceCaseRequestSchema>;

export const approveComplianceCaseRequestSchema = z.object({
  ttlDays: z.number().int().min(1).max(30).optional(),
});
export type ApproveComplianceCaseRequestBody = z.infer<typeof approveComplianceCaseRequestSchema>;

export const closeComplianceCaseRequestSchema = z.object({
  outcome: z.string().trim().min(3).max(2000),
});
export type CloseComplianceCaseRequestBody = z.infer<typeof closeComplianceCaseRequestSchema>;

/**
 * `ComplianceCasePort.findActiveForAccount` is the only listing method the
 * port exposes (application/ports.ts) — there is no fleet-wide "every
 * case, every account" query. `accountId` is therefore REQUIRED here, not
 * optional; see the route file and final report for why this is a scope
 * limit, not an oversight.
 */
export const listComplianceCasesQuerySchema = z.object({
  accountId: accountIdSchema,
});
export type ListComplianceCasesQuery = z.infer<typeof listComplianceCasesQuerySchema>;

export const complianceCaseIdParamSchema = z.object({
  caseId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/**
 * Mirrors `ComplianceCase` field-for-field (never a superset — anything not
 * listed here does not reach the wire, so a future field added to the
 * domain type without being added here fails loudly via `.parse` rather
 * than leaking silently).
 */
const complianceCaseDTOSchema = z.object({
  id: z.string(),
  externalRef: z.string(),
  category: complianceCaseCategorySchema,
  accountId: z.string(),
  scopeType: z.enum(["message_ids", "contact", "template", "date_range"]),
  scopeValue: z.unknown(),
  openedBy: z.string(),
  reason: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  /** Null until approved (no standing access — domain invariant); see compliance-case.ts. */
  expiresAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  outcome: z.string().nullable(),
  tenantNotifiedAt: z.string().nullable(),
  disclosureRestricted: z.boolean(),
  /** Derived, not stored — see `deriveCaseStatus` below. Saves every screen re-deriving it. */
  status: z.enum(["pending_approval", "active", "expired", "closed"]),
});
export type ComplianceCaseDTO = z.infer<typeof complianceCaseDTOSchema>;

/**
 * Status is derived here, once, from the same fields `canReadContent`
 * (domain/compliance-case.ts) itself checks — never re-decided ad hoc by a
 * screen. "active" means content COULD currently be read within scope, not
 * that anyone has; "expired" is time-based, computed against `now`, not a
 * stored flag (the domain's own "no cleanup job" invariant — see file
 * header there).
 */
function deriveCaseStatus(case_: ComplianceCase, now: Date): ComplianceCaseDTO["status"] {
  if (case_.closedAt !== null) return "closed";
  if (case_.approvedBy === null || case_.expiresAt === null) return "pending_approval";
  if (now.getTime() >= new Date(case_.expiresAt).getTime()) return "expired";
  return "active";
}

export function toComplianceCaseDTO(case_: ComplianceCase, now: Date = new Date()): ComplianceCaseDTO {
  return complianceCaseDTOSchema.parse({
    id: case_.id,
    externalRef: case_.externalRef,
    category: case_.category,
    accountId: case_.accountId,
    scopeType: case_.scopeType,
    scopeValue: case_.scopeValue,
    openedBy: case_.openedBy,
    reason: case_.reason,
    approvedBy: case_.approvedBy,
    approvedAt: case_.approvedAt,
    expiresAt: case_.expiresAt,
    closedAt: case_.closedAt,
    closedBy: case_.closedBy,
    outcome: case_.outcome,
    tenantNotifiedAt: case_.tenantNotifiedAt,
    disclosureRestricted: case_.disclosureRestricted,
    status: deriveCaseStatus(case_, now),
  });
}

// ---------------------------------------------------------------------------
// Principal summary — what the console home shows about "you".
// ---------------------------------------------------------------------------

export interface PlatformPrincipalSummaryDTO {
  readonly userId: string;
  readonly email: string;
  readonly platformRole: PlatformRole;
  readonly capabilities: readonly PlatformCapability[];
}

export function toPlatformPrincipalSummaryDTO(principal: VerifiedPlatformPrincipal): PlatformPrincipalSummaryDTO {
  return {
    userId: principal.userId,
    email: principal.email,
    platformRole: principal.platformRole,
    capabilities: permissions.capabilitiesFor(principal.platformRole),
  };
}

export { PLATFORM_CAPABILITIES };
export type { ComplianceCaseCategory };

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * A platform audit entry on the wire.
 *
 * Deliberately a straight projection: an audit entry's value is that it is
 * a faithful record, so this reshapes nothing and omits nothing. There is
 * no contract schema for it in `@packages/contracts` — the platform-admin
 * contracts only cover the fleet/billing ports that have no persistence —
 * so the shape is declared here, as `contact-dto.ts` does for its own.
 */
export const auditEntryDTOSchema = z.object({
  id: z.string().min(1),
  actor: z.string().min(1),
  platformRole: z.enum(["platform_support", "platform_admin", "platform_superadmin"]),
  action: z.string().min(1),
  targetAccountId: z.string().nullable(),
  targetResource: z.string().nullable(),
  reason: z.string().nullable(),
  occurredAt: z.string().min(1),
  requestId: z.string().min(1),
});
export type AuditEntryDTO = z.infer<typeof auditEntryDTOSchema>;

export function toAuditEntryDTO(entry: PlatformAuditEntry): AuditEntryDTO {
  return auditEntryDTOSchema.parse({
    id: entry.id,
    actor: entry.actor,
    platformRole: entry.platformRole,
    action: entry.action,
    targetAccountId: entry.targetAccountId,
    targetResource: entry.targetResource,
    reason: entry.reason,
    occurredAt: entry.occurredAt,
    requestId: entry.requestId,
  });
}
