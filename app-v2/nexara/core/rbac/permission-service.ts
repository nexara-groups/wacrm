import { AppError } from "../../shared/errors";
import type { Principal, TenantId } from "../../shared/types";
import type { Permission } from "./permissions";
import { ROLE_PERMISSIONS } from "./role-permissions";
import type { Role } from "./roles";

/**
 * RBAC Layer — Permission checking service.
 *
 * Provider-independent: depends only on the role→permission mapping and pure
 * domain types. No database, no auth SDK, no platform APIs. This is what every
 * other layer calls to make an authorization decision.
 */
export class PermissionService {
  constructor(
    private readonly mapping: Record<Role, ReadonlySet<Permission>> = ROLE_PERMISSIONS,
  ) {}

  /** Does this role hold this permission? */
  can(role: Role, permission: Permission): boolean {
    return this.mapping[role]?.has(permission) ?? false;
  }

  /** All permissions granted to a role. */
  permissionsFor(role: Role): readonly Permission[] {
    return [...(this.mapping[role] ?? new Set<Permission>())];
  }

  /**
   * Tenant-aware check. A principal may only act when (a) the action is within
   * their own tenant and (b) their role grants the permission. This is the
   * primary entry point for business logic.
   */
  canInTenant(
    principal: Principal & { role: Role },
    permission: Permission,
    resourceTenantId: TenantId,
  ): boolean {
    if (principal.tenantId !== resourceTenantId) return false;
    return this.can(principal.role, permission);
  }

  /** Throwing variant — raises AppError("FORBIDDEN") when not permitted. */
  assertInTenant(
    principal: Principal & { role: Role },
    permission: Permission,
    resourceTenantId: TenantId,
  ): void {
    if (!this.canInTenant(principal, permission, resourceTenantId)) {
      throw AppError.forbidden(
        `Role "${principal.role}" lacks "${permission}" in tenant ${resourceTenantId}`,
      );
    }
  }
}
