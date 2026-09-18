/**
 * Seat usage — what counts toward the cap. SEAT_LIMITS.md §2 "What counts as
 * a seat".
 *
 *   COUNTS:          every active member of any role, including `owner`;
 *                     every PENDING invitation (reserved, not yet accepted).
 *   DOES NOT COUNT:   removed / deactivated members;
 *                     expired or revoked invitations;
 *                     Nexara platform staff acting via the console.
 *
 * Ambiguity here becomes a billing dispute, so the rule is kept in one place
 * and is exhaustive over the status unions below — adding a new status forces
 * a compile error here until this file is updated.
 *
 * NOTE (role vocabulary): SEAT_LIMITS.md §1 flags that the current app's
 * roles (`owner`/`admin`/`agent`/`viewer`) differ from the framework's
 * (`owner`/`admin`/`manager`/`member` — nexara/core/rbac/roles.ts). Per the
 * spec, the port speaks the framework's vocabulary; the reconciliation
 * (`agent`→`member`, `viewer`→ a `member` variant or a fifth role) is
 * explicitly NOT resolved here.
 * TODO(SEAT_LIMITS.md §1): resolve the role-vocabulary mismatch when the
 * organizations port/migration is built; this module intentionally only
 * uses the framework's `Role` type in the meantime.
 */
import type { Role } from "@nexara/core/rbac";

export type SeatMemberStatus = "active" | "removed" | "deactivated";

/** A membership row as seen by seat accounting. Role is carried for context
 * only — every role counts equally, `owner` included (§2: "a 3-seat plan
 * means three people total — the owner plus two others"). */
export interface SeatMember {
  /** The MEMBERSHIP row id — not the user's id. See `userId` below. */
  readonly id: string;
  /**
   * The member's actual user id. Distinct from `id`, and the distinction
   * matters: a screen that assigns work to `id` is pointing at a
   * membership row, not a person.
   */
  readonly userId: string;
  /** When the membership was created — the "joined" date a team screen shows. */
  readonly joinedAt: Date;
  readonly status: SeatMemberStatus;
  readonly role: Role;
  /** True for Nexara platform staff acting via the console — never counts. */
  readonly isPlatformStaff: boolean;
}

export type SeatInvitationStatus = "pending" | "accepted" | "expired" | "revoked";

/** An invitation row as seen by seat accounting. A seat is reserved the
 * moment an invitation is created and released the moment it stops being
 * `pending` (accepted converts it to a member seat instead; expired/revoked
 * release it outright). */
export interface SeatInvitation {
  readonly id: string;
  readonly status: SeatInvitationStatus;
  /**
   * Who was invited. Persisted in `account_invitations.label`; the read
   * query simply never selected it, which left every screen showing a
   * placeholder instead of the address someone actually typed.
   */
  readonly email: string | null;
  readonly role: Role;
  readonly invitedBy: string | null;
  readonly createdAt: Date | null;
  /**
   * When the invitation stops being valid. An invitation whose status is
   * still `pending` in storage but whose `expiresAt` has passed is treated
   * as expired here too — usage accounting does not depend on a background
   * job having already flipped the status column.
   */
  readonly expiresAt: Date | null;
}

function isPendingAndUnexpired(invitation: SeatInvitation, now: Date): boolean {
  if (invitation.status !== "pending") return false;
  if (invitation.expiresAt === null) return true;
  return invitation.expiresAt.getTime() > now.getTime();
}

/**
 * Count the seats used by one tenant right now.
 *
 * Both lists MUST already be scoped to the same single account/tenant by the
 * caller (the repository query, in the real implementation) — this function
 * has no tenant concept of its own and will happily count whatever it is
 * given, which is exactly why tenant scoping is verified at the repository
 * boundary, not here (see seat-service tests "seat counts are tenant-scoped").
 */
export function countSeats(
  members: readonly SeatMember[],
  invitations: readonly SeatInvitation[],
  now: Date,
): number {
  const activeMembers = members.filter((m) => m.status === "active" && !m.isPlatformStaff).length;
  const pendingInvitations = invitations.filter((i) => isPendingAndUnexpired(i, now)).length;
  return activeMembers + pendingInvitations;
}
