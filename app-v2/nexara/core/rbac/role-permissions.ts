import type { Permission } from "./permissions";
import type { Role } from "./roles";

/**
 * RBAC Layer — Role → Permission mapping.
 *
 * The single source of truth for what each role can do. Higher roles are NOT
 * implicitly granted lower-role permissions by the type system; we compose the
 * sets explicitly so the mapping is auditable at a glance.
 */

const MEMBER: readonly Permission[] = [
  "profile:read:self",
  "profile:update:self",
  "task:read",
  "task:create",
];

const MANAGER: readonly Permission[] = [
  ...MEMBER,
  "users:read",
  "task:assign",
];

const ADMIN: readonly Permission[] = [
  ...MANAGER,
  "users:manage",
];

const OWNER: readonly Permission[] = [
  ...ADMIN,
  "tenant:manage",
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  member: new Set(MEMBER),
  manager: new Set(MANAGER),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};
