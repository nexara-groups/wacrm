import type { Principal } from "@shared/types";
import type { Role } from "./roles";

/**
 * RBAC Layer — Platform roles.
 *
 * See `docs/rebuild discussion/phase-0/SUPER_ADMIN_CONSOLE.md` §2 for the full
 * design rationale. The short version:
 *
 * A platform admin is NOT a fifth tenant role. It is a wholly separate,
 * orthogonal principal dimension:
 *   - different table (would be `platform_admins`, not tenant membership)
 *   - different grant path (§5 — only `platform_superadmin`, 2-person rule)
 *   - different audit stream
 *
 * Consequently `PLATFORM_ROLES` is intentionally NOT added to `ROLES`
 * (./roles.ts), and `PLATFORM_ROLE_RANK` below is intentionally NOT merged
 * into `ROLE_RANK`. The two rank tables are disjoint on purpose: a bug that
 * accidentally compared a platform role against a tenant role via a shared
 * rank table could let e.g. a `platform_admin` pass an `roleAtLeast(role,
 * "owner")` check it was never granted — that is exactly the leak this file
 * exists to prevent. `roleAtLeast` (./roles.ts) only ever looks up `Role`
 * keys; `platformRoleAtLeast` (below) only ever looks up `PlatformRole` keys.
 * Neither function, nor either rank table, references the other.
 */

export const PLATFORM_ROLES = ["platform_support", "platform_admin", "platform_superadmin"] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Type guard for untrusted input (e.g. a value read from a platform_admins row). */
export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === "string" && (PLATFORM_ROLES as readonly string[]).includes(value);
}

/**
 * Platform-role hierarchy rank (higher = more privileged). Deliberately a
 * SEPARATE table from `ROLE_RANK` (./roles.ts) — see file header. The tiers
 * are strictly cumulative: `platform_superadmin` (rank 30) can do everything
 * `platform_admin` (rank 20) can, which can do everything `platform_support`
 * (rank 10) can. Nothing is withheld from the top tier.
 */
export const PLATFORM_ROLE_RANK: Record<PlatformRole, number> = {
  platform_support: 10,
  platform_admin: 20,
  platform_superadmin: 30,
};

/**
 * True if `role` is at least as privileged as `minimum`, WITHIN the platform
 * axis only. Only ever compares `PlatformRole` values against `PlatformRole`
 * values — there is no overload, cast path, or shared table that lets a
 * tenant `Role` participate in this comparison. See `roleAtLeast` in
 * ./roles.ts for the equivalent, and equally isolated, tenant-axis check.
 */
export function platformRoleAtLeast(role: PlatformRole, minimum: PlatformRole): boolean {
  return PLATFORM_ROLE_RANK[role] >= PLATFORM_ROLE_RANK[minimum];
}

/**
 * PlatformPrincipal — the shared (tenant-scoped) `Principal` extended with the
 * orthogonal platform-role axis (spec §2):
 *
 *   interface Principal {
 *     userId; tenantRole?: Role; platformRole?: PlatformRole;
 *   }
 *
 * We cannot edit `@shared/types` from this module (out of scope for this
 * build), so the extension is expressed here instead of on the base
 * `Principal`. Both `tenantRole` and `platformRole` are optional and
 * independent: a user may hold a `tenantRole` in their own account, a
 * `platformRole` as Nexara staff, both, or neither — setting one never
 * implies or reads the other. `PermissionService` (./permission-service.ts)
 * only ever reads `tenantRole` (via its own `role` field); the platform
 * checks in `platform-permission-service.ts` only ever read `platformRole`.
 */
export interface PlatformPrincipal extends Principal {
  readonly tenantRole?: Role;
  readonly platformRole?: PlatformRole;
}

/**
 * A `PlatformPrincipal` known — verified against the platform_admins grant
 * table, at request-authentication time — to actually hold a platform role.
 * This is the type every cross-tenant repository method in
 * `modules/platform-admin/application/ports.ts` requires as a mandatory
 * argument: `platformRole` is non-optional here, so a caller holding only a
 * bare `PlatformPrincipal` (platformRole possibly absent) cannot pass it
 * without first narrowing via `isVerifiedPlatformPrincipal`, and a call site
 * that never obtained a `PlatformPrincipal` at all has nothing to pass —
 * there is no ambient/default instance of this type.
 */
export interface VerifiedPlatformPrincipal extends PlatformPrincipal {
  readonly platformRole: PlatformRole;
}

/** Narrowing guard: does this principal actually carry a verified platform role? */
export function isVerifiedPlatformPrincipal(
  principal: PlatformPrincipal,
): principal is VerifiedPlatformPrincipal {
  return principal.platformRole !== undefined && isPlatformRole(principal.platformRole);
}
