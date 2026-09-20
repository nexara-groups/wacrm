/**
 * RBAC Layer — Permissions.
 *
 * Permissions are fine-grained capability strings in the form
 * `resource:action`. The foundation ships with a small platform-level set;
 * business modules (added later) register their own permissions the same way.
 *
 * NOTE: task:* permissions exist here purely as RBAC examples requested by the
 * spec (canCreateTask / canAssignTask). They do NOT imply a Tasks module — no
 * business module is built in the foundation.
 */

export const PERMISSIONS = [
  // Platform / tenant administration
  "users:manage", // invite, remove, change roles
  "users:read",
  "tenant:manage", // tenant settings, billing
  "profile:read:self",
  "profile:update:self",

  // Example resource permissions (demonstration only)
  "task:create",
  "task:assign",
  "task:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}
