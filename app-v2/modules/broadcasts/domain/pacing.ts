/**
 * Send pacing — respects Meta's Cloud API throughput limits by capping how
 * many messages a broadcast may send within a rolling time window. See
 * docs/broadcast-two-per-minute-plan.md for the reference product's
 * behaviour (a fixed number of sequential sends per cron minute); this
 * generalises that to an injectable `(messagesPerWindow, windowMs)` pair
 * instead of a hardcoded "2 per minute cron tick".
 *
 * Pure and deterministic: every function here takes `now` and the recent
 * send timestamps explicitly — no hidden clock, no module-level mutable
 * counter. That is also what makes pacing RESUMABLE after an interruption
 * (a crashed worker, a redeployed cron): there is no in-memory pacing state
 * to lose. The caller (application/broadcast-service.ts) re-reads recent
 * send timestamps from the already-durable `broadcast_recipients.sent_at`
 * column each time it processes a batch, so pacing decisions are correct
 * from a cold start exactly as they would be mid-run — see
 * `pacing.test.ts`'s resumability test, which asserts that two independent
 * calls given the same reconstructed history produce the identical
 * decision.
 */

export interface PacingLimits {
  /** Maximum messages allowed inside any `windowMs`-wide rolling window. */
  readonly messagesPerWindow: number;
  readonly windowMs: number;
}

/** Matches the reference implementation's shipped default (2 messages/minute) — see docs/broadcast-two-per-minute-plan.md. */
export const DEFAULT_PACING_LIMITS: PacingLimits = {
  messagesPerWindow: 2,
  windowMs: 60_000,
};

function countWithinWindow(limits: PacingLimits, recentSentAt: readonly Date[], now: Date): number {
  const windowStart = now.getTime() - limits.windowMs;
  return recentSentAt.filter((sentAt) => sentAt.getTime() > windowStart).length;
}

/** How many more sends the pacing window allows right now. Never negative. */
export function remainingCapacity(limits: PacingLimits, recentSentAt: readonly Date[], now: Date): number {
  return Math.max(0, limits.messagesPerWindow - countWithinWindow(limits, recentSentAt, now));
}

export function canSendNow(limits: PacingLimits, recentSentAt: readonly Date[], now: Date): boolean {
  return remainingCapacity(limits, recentSentAt, now) > 0;
}

/**
 * When the next send slot opens. Returns `now` unchanged when a slot is
 * already free. Otherwise: the oldest send still inside the current window
 * falls out of it exactly `windowMs` after it happened — that instant is
 * the next available slot.
 */
export function nextAvailableSendTime(limits: PacingLimits, recentSentAt: readonly Date[], now: Date): Date {
  if (canSendNow(limits, recentSentAt, now)) return now;

  const windowStart = now.getTime() - limits.windowMs;
  const withinWindow = recentSentAt
    .filter((sentAt) => sentAt.getTime() > windowStart)
    .sort((a, b) => a.getTime() - b.getTime());
  const oldest = withinWindow[0];
  // Defensive fallback only: canSendNow() being false already implies
  // withinWindow is non-empty (capacity is fully consumed by something).
  return oldest ? new Date(oldest.getTime() + limits.windowMs) : now;
}

/**
 * How many of `pendingCount` waiting recipients can be sent in this pass,
 * given the pacing window right now. The caller uses this to bound how many
 * due rows it fetches (`listDueForSend(..., limit)`); this function never
 * touches storage itself, which is what keeps it safely callable from a
 * cold start.
 */
export function batchSizeForThisPass(
  limits: PacingLimits,
  recentSentAt: readonly Date[],
  now: Date,
  pendingCount: number,
): number {
  return Math.min(remainingCapacity(limits, recentSentAt, now), Math.max(0, pendingCount));
}
