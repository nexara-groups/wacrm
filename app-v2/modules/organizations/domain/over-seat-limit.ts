/**
 * The downgrade path — SEAT_LIMITS.md §4 "Downgrade — the hard case".
 *
 * An account on 10 seats downgrades to a plan with 3 included, with 8 active
 * users. The rule, in order:
 *
 *   1. Existing members are NEVER auto-removed. Ever. (Nothing in this file,
 *      or in the SeatService write paths that use it, deletes or deactivates
 *      a member. Enforced by omission: there is no such function to call.)
 *   2. The account enters `over_seat_limit` — visible, explained, with the
 *      count (see `computeOverSeatLimitStatus`).
 *   3. No new invitations and no reactivations until usage is at or under
 *      the cap (see `blocksNewInvitations` / `blocksReactivation` — this
 *      block is immediate, not gated by any grace period; see the grace
 *      period note below).
 *   4. Removing a member decrements usage; the block lifts at the cap
 *      (`computeOverSeatLimitStatus` is re-derived after every membership
 *      change, so it is self-clearing rather than a sticky flag).
 *   5. Optionally, billing charges for overage seats at `extra_seat_price`
 *      if the plan allows purchasable seats — out of scope here (see §8:
 *      overage charging ships with billing).
 *   6. Grace period is a plan setting, not hardcoded.
 */

/** Status of one account relative to its resolved seat limit right now. */
export interface OverSeatLimitStatus {
  readonly seatsUsed: number;
  readonly seatLimit: number;
  readonly isOverSeatLimit: boolean;
  /** 0 when at or under the cap. */
  readonly seatsOverBy: number;
}

/**
 * Derive over-seat-limit status from current usage and the resolved limit.
 * Pure and stateless on purpose: an account's over_seat_limit state is a
 * *projection* of usage vs. limit, not an independent fact that can drift
 * out of sync — the service recomputes it after every membership or plan
 * change and persists the projection for fast reads (fleet overview, block
 * checks), rather than this function owning any state itself.
 */
export function computeOverSeatLimitStatus(seatsUsed: number, seatLimit: number): OverSeatLimitStatus {
  const seatsOverBy = Math.max(0, seatsUsed - seatLimit);
  return { seatsUsed, seatLimit, isOverSeatLimit: seatsOverBy > 0, seatsOverBy };
}

/** §4.3 — invitations are refused while over the cap. */
export function blocksNewInvitations(status: OverSeatLimitStatus): boolean {
  return status.isOverSeatLimit;
}

/** §4.3 — reactivating a deactivated member is refused while over the cap
 * (reactivation consumes a seat just like an invitation would). */
export function blocksReactivation(status: OverSeatLimitStatus): boolean {
  return status.isOverSeatLimit;
}

/** §4.4 — true once usage has come back down to (or under) the limit. */
export function isCleared(status: OverSeatLimitStatus): boolean {
  return !status.isOverSeatLimit;
}

/**
 * §4.6 — the downgrade grace period is a plan setting, never hardcoded.
 *
 * Per SEAT_LIMITS.md §8's build-sequencing table, *overage charging and the
 * downgrade grace period* land with the billing module, not with
 * organizations. This type and `graceEndsAt` exist now (schema/interface
 * shaped ahead of time, per §6 "design now, build later") so the plan
 * setting has a home, but nothing in this module or in SeatService's
 * downgrade handling uses it to delay the growth block above — that block is
 * immediate per §4.3. Grace, once billing lands, governs only *when overage
 * charging may start*, not whether invitations/reactivations are blocked.
 */
export interface SeatGraceConfig {
  /** Plan setting. 0 = no grace before overage billing may start. */
  readonly graceDays: number;
}

/** Computes the end of the (billing-only, see above) grace window. Not
 * currently called by SeatService — provided for the billing module. */
export function graceEndsAt(downgradedAt: Date, config: SeatGraceConfig): Date {
  const end = new Date(downgradedAt.getTime());
  end.setUTCDate(end.getUTCDate() + config.graceDays);
  return end;
}
