// Public surface of the RBAC layer.
export { ROLES, ROLE_RANK, isRole, roleAtLeast, type Role } from "./roles";
export { PERMISSIONS, isPermission, type Permission } from "./permissions";
export { ROLE_PERMISSIONS } from "./role-permissions";
export { PermissionService } from "./permission-service";
export { canManageUsers, canCreateTask, canAssignTask } from "./policies";
