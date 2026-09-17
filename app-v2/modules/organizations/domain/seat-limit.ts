/**
 * Seat limit resolution — SEAT_LIMITS.md §2.
 *
 * The number of seats an account may use is never a constant in the code. It
 * is resolved through three levels, most specific wins:
 *
 *   account.seatLimitOverride ?? plan.includedSeats ?? platformSettings.defaultSeatLimit
 *
 * All three inputs are passed in by the caller (read fresh from persistence
 * for every resolution) — this module never reaches for a database, a cache,
 * or a hardcoded number. That is what makes "changing the platform default
 * moves every inheriting account immediately" true: there is nothing here to
 * invalidate.
 */

/**
 * DB SEED VALUE ONLY. This is the literal `3` that SEAT_LIMITS.md §2 says
 * `platform_settings.default_seat_limit` starts at. It exists so a migration
 * / seed script has a single named source for the initial row value — it
 * must NEVER be imported by `resolveSeatLimit` or any other domain/
 * application logic. Business logic always receives the platform default as
 * a resolved input (see `SeatLimitInputs.platformDefaultSeatLimit` below),
 * read live from `platform_settings` by the persistence layer.
 */
export const PLATFORM_DEFAULT_SEAT_LIMIT_SEED = 3;

/**
 * The three inputs to seat limit resolution, already fetched from
 * persistence for one account. `null` at a level means "not set at this
 * level, fall through".
 */
export interface SeatLimitInputs {
  /** Level 1 — per-account grant. Set by `platform_admin`+ with a mandatory reason. */
  readonly accountSeatLimitOverride: number | null;
  /** Level 2 — the account's plan. Set by `platform_superadmin`. `null` = inherit platform default. */
  readonly planIncludedSeats: number | null;
  /** Level 3 — platform-wide default. Read live from `platform_settings.default_seat_limit`. */
  readonly platformDefaultSeatLimit: number;
}

/**
 * Resolve the seat limit for one account, most-specific-wins.
 *
 * Pure and synchronous: given the same three inputs it always returns the
 * same number, so "does the platform default change move this account" is
 * entirely a question of which inputs the caller passes in, never a question
 * of this function's internals.
 */
export function resolveSeatLimit(input: SeatLimitInputs): number {
  return input.accountSeatLimitOverride ?? input.planIncludedSeats ?? input.platformDefaultSeatLimit;
}
