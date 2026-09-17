/**
 * RBAC Layer — Roles.
 *
 * Roles are provider-independent. They do not know about Supabase, auth tokens,
 * or the database — they are pure domain values.
 */

export const ROLES = ["owner", "admin", "manager", "member"] as const;

export type Role = (typeof ROLES)[number];

/** Type guard for untrusted input (e.g. a value read from token metadata). */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Role hierarchy rank (higher = more privileged). Useful for "at least"
 * comparisons; the source of truth for what a role *can do* is the
 * role→permission mapping, not this rank.
 */
export const ROLE_RANK: Record<Role, number> = {
  owner: 40,
  admin: 30,
  manager: 20,
  member: 10,
};

/** True if `role` is at least as privileged as `minimum`. */
export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
