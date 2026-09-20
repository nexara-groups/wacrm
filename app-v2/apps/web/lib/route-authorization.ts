/**
 * Who may perform each write in this app, in one table.
 *
 * Until now the answer was "anybody with a session". Every write route under
 * `app/api` — invite a teammate, remove one, launch a broadcast to every
 * customer, reassign another agent's conversation — was reachable by the
 * lowest-privileged member of the tenant, because `getContainer()` proves
 * only that a request belongs to SOME member of the tenant, and nothing
 * looked at the role after that. `PUT /api/whatsapp/connection` was the sole
 * exception, added with the route that writes a Meta credential.
 *
 * WHY A MINIMUM ROLE RATHER THAN A PERMISSION. The framework's
 * `Permission` union (`nexara/core/rbac/permissions.ts`) is a closed set of
 * platform-level strings — `users:manage`, `tenant:manage`, and three `task:*`
 * examples the file itself marks as demonstrations. None of them describes
 * "launch a broadcast". Extending that union means editing the framework to
 * know about WACRM's features, which the dependency rule this repo enforces
 * exists to prevent (`modules/container.ts`'s header). The honest alternative
 * is the framework's other primitive, `ROLE_RANK`/`roleAtLeast`, used through
 * an explicit product-level table — coarser than a permission system, but it
 * says exactly what it means and one grep shows every decision.
 *
 * Two rules for anything added here:
 *  - A route that changes state gets an entry. If a new action has no obvious
 *    minimum, that is a design question, not a reason to leave it open.
 *  - READS stay ungated at this layer. Tenant scoping already keeps one
 *    tenant's data away from another's, and role-filtering reads is a
 *    separate, larger design question (what does a member see on a
 *    dashboard?) that this table deliberately does not pre-empt.
 */
import { roleAtLeast, type Role } from "@nexara/core/rbac";

/**
 * Every state-changing action a tenant user can take, and the least
 * privileged role that may take it.
 *
 * The reasoning per entry, where it is not obvious:
 *
 * `contacts:write`, `messages:send`, `media:upload`,
 * `conversations:mark-read` — member. This is the job. An agent who cannot
 * add a contact or answer a message has no reason to hold a seat.
 *
 * `conversations:assign` — manager. Moving work between people is
 * supervisory, and the framework's own mapping already reserves `task:assign`
 * for manager and above; this follows that instinct rather than inventing a
 * different one.
 *
 * `broadcasts:write` / `broadcasts:control` — manager. A broadcast reaches
 * every matching customer at once and (once billing exists) spends real
 * money; one agent should not be able to launch one alone. The uncomfortable
 * half of that call is `control`: pausing a misfiring broadcast is a SAFETY
 * action, and this table makes an agent escalate to do it. Control sits with
 * manager anyway because the same endpoint family also cancels — which is
 * destructive and irreversible — and splitting pause from cancel would give
 * two neighbouring buttons different rules for a reason nobody reading the
 * screen could infer. If the escalation ever costs a real incident, split
 * them and say so here.
 *
 * `seats:invite` / `invitations:revoke` / `members:remove` /
 * `members:reactivate` — admin, matching the framework's `users:manage`
 * grant. Reactivation belongs with the rest of them because it CONSUMES A
 * SEAT: it is the same spend as an invitation, arriving through a different
 * door. It was missing from the first version of this table, which is
 * exactly the failure the rule above is meant to catch — the route changed
 * state and nobody had decided who may call it.
 *
 * `whatsapp:connect` — owner. It repoints every outbound message this
 * account sends.
 */
export const ACTION_MINIMUM_ROLE = {
  "contacts:write": "member",
  "messages:send": "member",
  "media:upload": "member",
  "conversations:mark-read": "member",
  "conversations:assign": "manager",
  "broadcasts:write": "manager",
  "broadcasts:control": "manager",
  "broadcasts:preview": "manager",
  "seats:invite": "admin",
  "invitations:revoke": "admin",
  "members:remove": "admin",
  "members:reactivate": "admin",
  "whatsapp:connect": "owner",
} as const satisfies Record<string, Role>;

export type TenantAction = keyof typeof ACTION_MINIMUM_ROLE;

export function minimumRoleFor(action: TenantAction): Role {
  return ACTION_MINIMUM_ROLE[action];
}

/** Whether `role` may perform `action`. The only place that decides. */
export function isAuthorizedForAction(role: Role, action: TenantAction): boolean {
  return roleAtLeast(role, ACTION_MINIMUM_ROLE[action]);
}

/**
 * The operator-facing refusal. It names the role needed rather than saying
 * "forbidden": a member who cannot launch a broadcast needs to know who to
 * ask, and an error that withholds that just becomes a support ticket.
 */
export function forbiddenMessageFor(action: TenantAction): string {
  const needed = ACTION_MINIMUM_ROLE[action];
  const who =
    needed === "owner"
      ? "the account owner"
      : needed === "admin"
        ? "an admin or the account owner"
        : "a manager or above";
  return `You don't have permission to do this — it needs ${who}.`;
}
