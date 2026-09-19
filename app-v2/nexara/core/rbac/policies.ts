import type { Principal, TenantId } from "../../shared/types";
import type { PermissionService } from "./permission-service";
import type { Role } from "./roles";

/**
 * RBAC Layer — named policy helpers (the spec's examples).
 *
 * These are thin, readable wrappers over PermissionService so call sites read
 * like intent — `canCreateTask(user)` — instead of passing permission strings
 * around. They are provider-independent and tenant-aware.
 *
 * (task:* helpers are RBAC demonstrations only; no Tasks module exists.)
 */

type Actor = Principal & { role: Role };

export function canManageUsers(svc: PermissionService, actor: Actor, tenantId: TenantId): boolean {
  return svc.canInTenant(actor, "users:manage", tenantId);
}

export function canCreateTask(svc: PermissionService, actor: Actor, tenantId: TenantId): boolean {
  return svc.canInTenant(actor, "task:create", tenantId);
}

export function canAssignTask(svc: PermissionService, actor: Actor, tenantId: TenantId): boolean {
  return svc.canInTenant(actor, "task:assign", tenantId);
}
