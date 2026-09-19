/**
 * Seats — usage response carrying used/limit and whether any are pending
 * invitations, so the UI can render SEAT_LIMITS.md §3's plain-English
 * messages (`atCap`, `pendingInvitesUsage`, `acceptFailedCapReached`,
 * `approachingCap` in `modules/organizations/domain/seat-messages.ts`)
 * without re-deriving the counting rule (§2 "what counts as a seat") on the
 * client.
 */
import { z } from "zod";
import { accountIdSchema } from "./common/ids";
import { apiResult } from "./common/response";

export const seatUsageSchema = z
  .object({
    accountId: accountIdSchema,
    /** Active members (any role, including `owner`) + pending, unexpired invitations — SEAT_LIMITS.md §2. */
    used: z.number().int().min(0),
    /** `resolved_seat_limit`: `accountSeatLimitOverride ?? planIncludedSeats ?? platformDefaultSeatLimit` (§2). */
    limit: z.number().int().min(1),
    /** `limit - used`; negative while `isOverSeatLimit` (§4 downgrade grandfathering). */
    remaining: z.number().int(),
    pendingInvitationCount: z.number().int().min(0),
    hasPendingInvitations: z.boolean(),
    /** §4: the account was grandfathered above its current limit by a downgrade — existing members were never removed, but growth is blocked. */
    isOverSeatLimit: z.boolean(),
    /**
     * A pre-rendered SEAT_LIMITS.md §3 status line (`SEAT_MESSAGES.atCap` /
     * `.pendingInvitesUsage` / `.approachingCap`, exactly as those templates
     * render for this account's numbers), or `null` when there is nothing
     * worth telling the user (comfortably under cap, no pending invites).
     * Pre-rendered server-side so this package does not need to duplicate
     * `SEAT_MESSAGES`'s copy — that would be a second source of truth for
     * the exact wording §3's test requirements pin word-for-word.
     */
    statusMessage: z.string().min(1).nullable(),
  })
  .refine((value) => value.remaining === value.limit - value.used, {
    message: "remaining must equal limit - used",
    path: ["remaining"],
  })
  .refine((value) => value.hasPendingInvitations === value.pendingInvitationCount > 0, {
    message: "hasPendingInvitations must match pendingInvitationCount > 0",
    path: ["hasPendingInvitations"],
  });
export type SeatUsage = z.infer<typeof seatUsageSchema>;

export const getSeatUsageRequestSchema = z.object({ accountId: accountIdSchema });
export type GetSeatUsageRequest = z.infer<typeof getSeatUsageRequestSchema>;

export const getSeatUsageResponseSchema = apiResult({ usage: seatUsageSchema });
export type GetSeatUsageResponse = z.infer<typeof getSeatUsageResponseSchema>;
