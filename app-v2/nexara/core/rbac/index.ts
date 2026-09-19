// Public surface of the RBAC layer.
export { ROLES, ROLE_RANK, isRole, roleAtLeast, type Role } from "./roles";
export { PERMISSIONS, isPermission, type Permission } from "./permissions";
export { ROLE_PERMISSIONS } from "./role-permissions";
export { PermissionService } from "./permission-service";
export { canManageUsers, canCreateTask, canAssignTask } from "./policies";

// Platform-admin axis — orthogonal to the tenant-role axis above. See
// ./platform-roles.ts and SUPER_ADMIN_CONSOLE.md §2 for why these are never
// merged into ROLES/ROLE_RANK/Role.
export {
  PLATFORM_ROLES,
  PLATFORM_ROLE_RANK,
  isPlatformRole,
  platformRoleAtLeast,
  isVerifiedPlatformPrincipal,
  type PlatformRole,
  type PlatformPrincipal,
  type VerifiedPlatformPrincipal,
} from "./platform-roles";
export {
  PLATFORM_CAPABILITIES,
  PLATFORM_ROLE_CAPABILITIES,
  isPlatformCapability,
  PlatformPermissionService,
  type PlatformCapability,
} from "./platform-permission-service";
