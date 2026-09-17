/**
 * Plain-English seat messages — SEAT_LIMITS.md §3 "Plain-English messages".
 *
 * Same rules as META_ERROR_TAXONOMY.md §4b: no jargon, say what happened and
 * what to do next. Kept as data, keyed by situation, so copy changes never
 * touch SeatService's control flow.
 *
 * The spec gives these as fixed strings for the canonical 3-seat example.
 * The seat limit is a *configured* value (SEAT_LIMITS.md §2) and can be any
 * number, so the entries below are small templates parameterized by the
 * actual numbers for an account — `SEAT_MESSAGES_3_SEAT_EXAMPLE` further down
 * pins them at seatLimit = 3 and asserts, word for word, against the spec's
 * exact wording (see seat-messages.test.ts).
 */

export type SeatMessageKey =
  | "atCap"
  | "pendingInvitesUsage"
  | "acceptFailedCapReached"
  | "approachingCap";

export const SEAT_MESSAGES = {
  /** §3 "At cap, inviting". */
  atCap: (seatLimit: number): string =>
    `You've used all ${seatLimit} user seats on your plan. Remove a user or upgrade to add more.`,

  /** §3 "Pending invites consuming seats". */
  pendingInvitesUsage: (seatsUsed: number, seatLimit: number, pendingInvitations: number): string => {
    const noun = pendingInvitations === 1 ? "invitation" : "invitations";
    const verb = pendingInvitations === 1 ? "hasn't" : "haven't";
    return `${seatsUsed} of ${seatLimit} seats used — ${pendingInvitations} ${pendingInvitations === 1 ? "is" : "are"} a pending ${noun} that ${verb} been accepted yet.`;
  },

  /** §3 "Accept fails (cap reached meanwhile)". Fixed wording — no numbers involved. */
  acceptFailedCapReached: "This workspace has no free seats. Ask the account owner to free one or upgrade.",

  /** §3 "Approaching cap". */
  approachingCap: (seatsRemaining: number): string =>
    `${seatsRemaining} seat${seatsRemaining === 1 ? "" : "s"} left on your plan.`,
} as const;

/**
 * The spec's exact 3-seat wording (SEAT_LIMITS.md §3 table), kept verbatim so
 * tests can assert the templates above have not drifted from the spec.
 */
export const SEAT_MESSAGES_3_SEAT_EXAMPLE = {
  atCap: "You've used all 3 user seats on your plan. Remove a user or upgrade to add more.",
  pendingInvitesUsage:
    "3 of 3 seats used — 1 is a pending invitation that hasn't been accepted yet.",
  acceptFailedCapReached: "This workspace has no free seats. Ask the account owner to free one or upgrade.",
  approachingCap: "1 seat left on your plan.",
} as const;
