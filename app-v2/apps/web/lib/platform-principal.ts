/**
 * THE security seam for the platform (super-admin) console.
 *
 * Every route under `app/api/platform/**` and every server component under
 * `app/platform/**` MUST resolve the caller through `requirePlatformPrincipal`
 * (or `getPlatformPrincipal` when a null result is handled inline) before
 * doing anything else. A route that reads `req.body.platformRole` or any
 * other client-supplied claim instead of calling this file is a hole —
 * SUPER_ADMIN_CONSOLE.md's whole design rests on platform access being a
 * separate, server-verified axis from tenant membership (§2), never
 * something a request can assert about itself ("shape is not authority" —
 * see this task's HARD RULE 6).
 *
 * -----------------------------------------------------------------------
 * How resolution works
 * -----------------------------------------------------------------------
 * `PlatformRoleGrantPort.findOwnGrant(userId)` takes no principal, because
 * at this point there is none — that is the question being asked. It
 * returns the caller's active grant or null, and audits the lookup with
 * the role it actually FOUND.
 *
 * An earlier version of this file called `findActiveForUser` with a
 * fabricated principal carrying a hardcoded `platform_support` role. The
 * lookup was safe — it filters on `userId`, and the principal only
 * attributes the audit row — but the audit row was not: every visit to a
 * platform URL by an ordinary tenant user wrote an entry claiming that
 * user held `platform_support`. The console's audit log is meant to be
 * evidence of what staff did; one that records roles nobody was granted
 * is evidence of nothing.
 */
import { AppError } from "@shared/errors";
import type { ModuleRepositories } from "@modules/container";
import {
  platformRoleAtLeast,
  PlatformPermissionService,
  type PlatformCapability,
  type PlatformRole,
  type VerifiedPlatformPrincipal,
} from "@nexara/core/rbac";
import { getCurrentAuth } from "./session";
import { getBaseServices } from "./container";

const permissions = new PlatformPermissionService();

/**
 * Self-lookup bootstrap: resolve `userId` to a `VerifiedPlatformPrincipal`
 * by asking `platformRoleGrants.findActiveForUser` about that SAME user.
 * Exported (not just used internally) so a test can exercise it directly
 * against a seeded in-memory database without going through cookies/`next/
 * headers`, which only work inside an actual request.
 */
export async function resolvePlatformPrincipalForUser(
  repositories: ModuleRepositories,
  userId: string,
  tenantId: string,
  email: string,
): Promise<VerifiedPlatformPrincipal | null> {
  const grant = await repositories.platformRoleGrants.findOwnGrant(userId);
  if (grant === null) return null;
  return { userId, tenantId, email, platformRole: grant.platformRole };
}

/**
 * Resolve the CURRENT request's session to a verified platform principal,
 * or `null` when there is no session, or the session's user holds no
 * active platform-role grant (including a tenant owner/admin/member who
 * has never been granted one — a tenant role never implies a platform
 * role, per §2).
 *
 * Deliberately uses `getBaseServices()` (process-wide repositories), never
 * `getContainer()` — `getContainer()`'s `tenant` is the caller's OWN tenant
 * membership, which is irrelevant here and would wrongly suggest platform
 * access is tenant-scoped.
 */
export async function getPlatformPrincipal(): Promise<VerifiedPlatformPrincipal | null> {
  const auth = await getCurrentAuth();
  if (!auth) return null;
  const { repositories } = await getBaseServices();
  return resolvePlatformPrincipalForUser(repositories, auth.user.userId, auth.user.tenantId, auth.user.email);
}

/**
 * Throwing variant for routes: a single call that either returns a
 * `VerifiedPlatformPrincipal` or throws the exact `AppError` `lib/api-
 * response.ts`'s `internalError` already knows how to map (401 for no
 * session, 403 for a session with no platform-role grant). Every route in
 * `app/api/platform/**` calls this first, before touching any repository
 * or reading the request body.
 */
export async function requirePlatformPrincipal(): Promise<VerifiedPlatformPrincipal> {
  const auth = await getCurrentAuth();
  if (!auth) {
    throw AppError.unauthenticated("No active session");
  }
  const { repositories } = await getBaseServices();
  const principal = await resolvePlatformPrincipalForUser(
    repositories,
    auth.user.userId,
    auth.user.tenantId,
    auth.user.email,
  );
  if (principal === null) {
    throw AppError.forbidden(
      "This account holds no platform role. The platform console is for Nexara staff only — " +
        "a tenant role (owner/admin/manager/member) never grants platform access.",
    );
  }
  return principal;
}

/** Throwing capability check — wraps `PlatformPermissionService` so routes don't construct it themselves. */
export function requireCapability(principal: VerifiedPlatformPrincipal, capability: PlatformCapability): void {
  permissions.assertCanForPrincipal(principal, capability);
}

/**
 * Throwing minimum-tier check for actions SUPER_ADMIN_CONSOLE.md §7 names a
 * tier for but `PLATFORM_CAPABILITIES` (nexara/core/rbac/platform-
 * permission-service.ts) has no dedicated capability string for —
 * approving and closing a compliance case. §7: "second platform_admin or
 * platform_superadmin approves". `nexara/core/rbac/**` is framework code
 * this task was not asked to touch, so the gap is worked around here
 * rather than by adding a capability there; see the final report.
 */
export function requirePlatformTier(principal: VerifiedPlatformPrincipal, minimum: PlatformRole): void {
  if (!platformRoleAtLeast(principal.platformRole, minimum)) {
    throw AppError.forbidden(
      `Platform role "${principal.platformRole}" is below the required tier "${minimum}" for this action.`,
    );
  }
}

export type { PlatformCapability, PlatformRole, VerifiedPlatformPrincipal };
