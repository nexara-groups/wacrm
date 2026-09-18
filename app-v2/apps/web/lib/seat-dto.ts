/**
 * Maps organizations-module seat/member/invitation records
 * (`modules/organizations/**`) onto the wire DTOs in
 * `@packages/contracts/src/seats.ts` and `invitations.ts`. Same discipline
 * as `lib/contact-dto.ts`: every DTO is parsed through its resource's real
 * zod schema so a field added to one side and not the other fails loudly
 * instead of shipping a response with something quietly missing.
 *
 * -----------------------------------------------------------------------
 * PORT GAP — read before trusting `userId` / `joinedAt` / invitation
 * `email` / `role` / `invitedBy` on anything this file returns
 * -----------------------------------------------------------------------
 * `SeatRepository` (modules/organizations/application/ports.ts) is
 * deliberately minimal: it exists to make the seat CAP arithmetic correct,
 * not to back a full team-directory screen. Per its own types:
 *   - `SeatMember`     = { id, status, role, isPlatformStaff }         — no
 *     `userId`, `accountId` or `joinedAt`. `id` (confirmed against
 *     `SqlSeatRepository.toSeatMember`, which selects `m.id`) is the
 *     MEMBERSHIP row id, not the user's id.
 *   - `SeatInvitation` = { id, status, expiresAt }                     — no
 *     `email`, `role` or `invitedBy`, even though the repository DOES
 *     persist the invitee email (in `account_invitations.label`, per that
 *     file's own header gap #3) — `listInvitations`'s SELECT simply never
 *     reads it back out.
 * There is no port method that returns the missing fields, and per this
 * task's hard rules a missing port method is reported, not invented (no new
 * port method, no SQL in `apps/web`). So for rows read back from
 * `listMembers`/`listInvitations` (i.e. everything except a JUST-CREATED
 * invitation, where this route already has the real values from the
 * request it validated) this file fills the gap with clearly-fake,
 * documented placeholders — never a silent guess:
 *   - member `userId`     -> the membership row id (NOT a real user id)
 *   - member `joinedAt`   -> `UNKNOWN_JOIN_DATE` epoch sentinel
 *   - invitation `email`  -> `unknown+<id>@invalid` — the SAME sentinel
 *     pattern `SqlSeatRepository.acceptInvitationIfSeatAvailable` already
 *     falls back to when `label` is missing, reused here for consistency
 *     rather than inventing a second "unknown" convention
 *   - invitation `role`   -> `"member"` (least-privilege placeholder)
 *   - invitation `invitedBy` -> the account owner's user id (best
 *     available guess; not necessarily the real inviter)
 * See this slice's final report for the full writeup.
 */
import { seatUsageSchema, type SeatUsage } from "@packages/contracts/src/seats";
import {
  accountMemberSchema,
  invitationSchema,
  type AccountMember,
  type Invitation,
} from "@packages/contracts/src/invitations";
import { resolveSeatLimit, type SeatLimitInputs } from "@modules/organizations/domain/seat-limit";
import { countSeats, type SeatInvitation, type SeatMember } from "@modules/organizations/domain/seat-usage";
import { computeOverSeatLimitStatus } from "@modules/organizations/domain/over-seat-limit";
import { SEAT_MESSAGES } from "@modules/organizations/domain/seat-messages";
import type { SeatLimitExceeded } from "@modules/organizations/application/seat-service";
import { fail } from "@/lib/api-response";

/** Which resolution level (SEAT_LIMITS.md §2) actually supplied the limit. */
export type SeatLimitSource = "account_override" | "plan" | "platform_default";

/** GAP sentinel — see file header. Obviously not a real join date. */

function resolveLimitSource(config: SeatLimitInputs): SeatLimitSource {
  if (config.accountSeatLimitOverride !== null) return "account_override";
  if (config.planIncludedSeats !== null) return "plan";
  return "platform_default";
}

/**
 * Mirrors the private `isPendingAndUnexpired` predicate in
 * `modules/organizations/domain/seat-usage.ts` (not exported — only the
 * combined `countSeats` total is). Needed here to split out the
 * invitation-only sub-count for `SeatUsage.pendingInvitationCount`.
 */
function isPendingAndUnexpired(invitation: SeatInvitation, now: Date): boolean {
  if (invitation.status !== "pending") return false;
  if (invitation.expiresAt === null) return true;
  return invitation.expiresAt.getTime() > now.getTime();
}

/** Builds the full `SeatUsage` DTO (SEAT_LIMITS.md §2) plus which level supplied the limit. */
export function buildSeatUsageDTO(
  accountId: string,
  config: SeatLimitInputs,
  members: readonly SeatMember[],
  invitations: readonly SeatInvitation[],
  now: Date,
): { usage: SeatUsage; limitSource: SeatLimitSource } {
  const limit = resolveSeatLimit(config);
  const limitSource = resolveLimitSource(config);
  const used = countSeats(members, invitations, now);
  const pendingInvitationCount = invitations.filter((i) => isPendingAndUnexpired(i, now)).length;
  const remaining = limit - used;
  const isOverSeatLimit = computeOverSeatLimitStatus(used, limit).isOverSeatLimit;

  // SEAT_LIMITS.md §3 "Plain-English messages" — pre-rendered server-side
  // (this package owns `SEAT_MESSAGES`) rather than re-derived by the client.
  let statusMessage: string | null = null;
  if (used >= limit) {
    statusMessage = SEAT_MESSAGES.atCap(limit);
  } else if (pendingInvitationCount > 0) {
    statusMessage = SEAT_MESSAGES.pendingInvitesUsage(used, limit, pendingInvitationCount);
  } else if (remaining === 1) {
    statusMessage = SEAT_MESSAGES.approachingCap(remaining);
  }

  const usage = seatUsageSchema.parse({
    accountId,
    used,
    limit,
    remaining,
    pendingInvitationCount,
    hasPendingInvitations: pendingInvitationCount > 0,
    isOverSeatLimit,
    statusMessage,
  });
  return { usage, limitSource };
}

export function toAccountMemberDTO(accountId: string, member: SeatMember): AccountMember {
  return accountMemberSchema.parse({
    // `member.userId`, NOT `member.id` — the latter is the membership row.
    userId: member.userId,
    accountId,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt.toISOString(),
  });
}

/**
 * GET-list path — a previously-created invitation read back through
 * `listInvitations`.
 *
 * `email` is nullable in the schema (`account_invitations.label`), so an
 * invitation with no recorded address renders as one, rather than as a
 * fabricated address that looks real enough to email.
 */
export function toListedInvitationDTO(
  accountId: string,
  invitation: SeatInvitation,
  createdAtFallback: string,
): Invitation {
  return invitationSchema.parse({
    id: invitation.id,
    accountId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedBy: invitation.invitedBy,
    expiresAt: invitation.expiresAt ? invitation.expiresAt.toISOString() : createdAtFallback,
    createdAt: invitation.createdAt ? invitation.createdAt.toISOString() : createdAtFallback,
  });
}

/**
 * POST-create path — every field is real, straight from the request this
 * route already validated and the actual authenticated actor.
 */
export function toFreshInvitationDTO(
  accountId: string,
  invitation: SeatInvitation,
  email: string,
  role: string,
  invitedBy: string,
  createdAt: string,
): Invitation {
  return invitationSchema.parse({
    id: invitation.id,
    accountId,
    email,
    role,
    status: invitation.status,
    invitedBy,
    expiresAt: invitation.expiresAt ? invitation.expiresAt.toISOString() : createdAt,
    createdAt,
  });
}

/**
 * SEAT_LIMITS.md §3: "Hitting the cap is a normal outcome, not an error
 * page." Turns a `SeatLimitExceeded` into the shared error envelope with
 * its pre-rendered `SEAT_MESSAGES` text as `laymanMessage` (never the
 * generic CONFLICT mapping in `lib/api-response.ts#internalError`, which
 * would throw that specific wording away) and an `operatorHint` naming what
 * actually unblocks it.
 */
export function seatLimitExceededResponse(error: SeatLimitExceeded) {
  return fail(
    {
      code: "seat_limit_exceeded",
      laymanMessage: error.message,
      operatorHint:
        `${error.seatsUsed}/${error.seatLimit} seats used. Unblock by removing or deactivating a ` +
        "member, revoking an unneeded pending invitation, or raising this account's seat limit " +
        "override (platform_admin+, with a reason).",
    },
    409,
  );
}
