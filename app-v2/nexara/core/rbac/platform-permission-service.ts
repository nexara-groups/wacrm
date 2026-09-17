import { AppError } from "@shared/errors";
import type { PlatformRole, VerifiedPlatformPrincipal } from "./platform-roles";

/**
 * RBAC Layer — Platform capability checking.
 *
 * See `docs/rebuild discussion/phase-0/SUPER_ADMIN_CONSOLE.md` §2 for the
 * gating table this mirrors. Cross-account oversight (reports, metadata,
 * activity, billing state, delivery health) is available at every tier —
 * it is intentionally listed here as ungated, not simply left unchecked.
 * Mutating tenant data, impersonation, and opening a compliance case require
 * `platform_admin`+. Granting/revoking platform roles and platform
 * configuration require `platform_superadmin` only.
 *
 * DELIBERATELY ABSENT: there is no "read message content" / "browse inbox"
 * capability anywhere in `PLATFORM_CAPABILITIES`, at any tier, including
 * `platform_superadmin`. This is not an oversight to remember not to check —
 * the capability string does not exist in the closed union below, so no
 * amount of misconfiguring `PLATFORM_ROLE_CAPABILITIES` can grant it, and no
 * caller can ask `can(role, "message_content:read")` because that is not a
 * valid `PlatformCapability` and the call does not compile. Content is
 * reachable ONLY through an approved, scoped, unexpired compliance case —
 * see `modules/platform-admin/domain/compliance-case.ts` — which is a wholly
 * separate mechanism from this role→capability mapping and does not consult
 * it. That is what makes "no tier may browse content" structural rather than
 * a policy that happens to be unchecked today.
 */

export const PLATFORM_CAPABILITIES = [
  // Cross-account oversight — NOT gated; granted at every tier, for every account.
  "cross_account:read_reports",
  "cross_account:read_metadata",
  "cross_account:read_activity",
  "cross_account:read_billing_state",
  "cross_account:read_delivery_health",

  // Mutating tenant data — platform_admin+.
  "tenant:adjust_credit",
  "tenant:suspend",
  "tenant:reactivate",
  "tenant:clear_suppression",
  "tenant:requeue",

  // Time-boxed impersonation — platform_admin+.
  "tenant:impersonate",

  // Opening a compliance case (not reading content — see file header) — platform_admin+.
  "compliance_case:open",

  // Platform-role grants and platform configuration — platform_superadmin only.
  "platform_role:grant",
  "platform_role:revoke",
  "platform_config:manage",
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export function isPlatformCapability(value: unknown): value is PlatformCapability {
  return typeof value === "string" && (PLATFORM_CAPABILITIES as readonly string[]).includes(value);
}

const SUPPORT_CAPABILITIES: readonly PlatformCapability[] = [
  "cross_account:read_reports",
  "cross_account:read_metadata",
  "cross_account:read_activity",
  "cross_account:read_billing_state",
  "cross_account:read_delivery_health",
];

const ADMIN_CAPABILITIES: readonly PlatformCapability[] = [
  // platform_admin is a strict superset of platform_support (spec §2: "tiers
  // are cumulative — each is a strict superset of the one below").
  ...SUPPORT_CAPABILITIES,
  "tenant:adjust_credit",
  "tenant:suspend",
  "tenant:reactivate",
  "tenant:clear_suppression",
  "tenant:requeue",
  "tenant:impersonate",
  "compliance_case:open",
];

const SUPERADMIN_CAPABILITIES: readonly PlatformCapability[] = [
  // platform_superadmin is a strict superset of platform_admin — "the super
  // super admin": everything the lower tiers can do, plus role/config grants.
  // Nothing is withheld from the top tier.
  ...ADMIN_CAPABILITIES,
  "platform_role:grant",
  "platform_role:revoke",
  "platform_config:manage",
];

/** The single source of truth for what each platform role can do. */
export const PLATFORM_ROLE_CAPABILITIES: Record<PlatformRole, ReadonlySet<PlatformCapability>> = {
  platform_support: new Set(SUPPORT_CAPABILITIES),
  platform_admin: new Set(ADMIN_CAPABILITIES),
  platform_superadmin: new Set(SUPERADMIN_CAPABILITIES),
};

/**
 * Provider-independent: depends only on the role→capability mapping. No
 * database, no auth SDK. This is the platform-axis counterpart of
 * `PermissionService` (./permission-service.ts) — kept as a separate class,
 * over the same `PlatformPrincipal`/`Principal` distinction that keeps the
 * two axes from being compared to one another (see ./platform-roles.ts).
 *
 * Note there is no `canInTenant`-equivalent tenant-scoping check here: per
 * spec §2, cross-account oversight capabilities are explicitly NOT scoped to
 * one tenant — they are "available at every tier, for every account" by
 * design. Capabilities that DO act on one account (suspend, credit
 * adjustment, impersonation, ...) take the target account id as an explicit
 * argument at the call site (see `modules/platform-admin/application/ports.ts`)
 * and are logged there; this service only answers "can this platform role
 * hold this capability at all", not "for which account".
 */
export class PlatformPermissionService {
  constructor(
    private readonly mapping: Record<PlatformRole, ReadonlySet<PlatformCapability>> = PLATFORM_ROLE_CAPABILITIES,
  ) {}

  /** Does this platform role hold this capability? */
  can(role: PlatformRole, capability: PlatformCapability): boolean {
    return this.mapping[role]?.has(capability) ?? false;
  }

  /** All capabilities granted to a platform role. */
  capabilitiesFor(role: PlatformRole): readonly PlatformCapability[] {
    return [...(this.mapping[role] ?? new Set<PlatformCapability>())];
  }

  /**
   * Principal-aware check. Requires a `VerifiedPlatformPrincipal` — a
   * principal already confirmed to hold a platform role — so this can never
   * be called with an unverified or absent role (see ./platform-roles.ts).
   */
  canForPrincipal(principal: VerifiedPlatformPrincipal, capability: PlatformCapability): boolean {
    return this.can(principal.platformRole, capability);
  }

  /** Throwing variant — raises AppError("FORBIDDEN") when not permitted. */
  assertCanForPrincipal(principal: VerifiedPlatformPrincipal, capability: PlatformCapability): void {
    if (!this.canForPrincipal(principal, capability)) {
      throw AppError.forbidden(
        `Platform role "${principal.platformRole}" lacks capability "${capability}"`,
      );
    }
  }
}
