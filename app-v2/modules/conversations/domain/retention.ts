/**
 * Message retention policy — pure. No SQL, no clock of its own.
 *
 * "Keep 60 days" is one subtraction, so the value here is not the
 * arithmetic; it is having exactly one place that decides what "expired"
 * means, and a bound on how much a single sweep may delete.
 *
 * The bound matters more than it looks. Retention runs against D1, whose
 * free tier meters rows WRITTEN, and a delete is a write. The first sweep
 * over an account that has never been trimmed could be its entire history —
 * which is both a large bill and a long-running statement on a platform
 * with request time limits. So a sweep deletes at most `maxDeletes` rows and
 * reports whether more remain; the caller runs it again. Deleting less than
 * asked is normal operation here, not a partial failure.
 */

/** SEAT_LIMITS-style resolution: an account override wins over the platform default. */
export interface RetentionConfig {
  readonly accountRetentionDaysOverride: number | null;
  readonly platformDefaultRetentionDays: number;
}

/**
 * Floor of 1 day. A resolved value of 0 would mean "delete everything,
 * continuously" — which is not a retention policy anyone means to set, and
 * is the kind of typo (`0` for "unlimited") that quietly destroys data. A
 * configuration mistake should cost storage, never history.
 */
export const MIN_RETENTION_DAYS = 1;

export function resolveRetentionDays(config: RetentionConfig): number {
  const chosen = config.accountRetentionDaysOverride ?? config.platformDefaultRetentionDays;
  return Math.max(MIN_RETENTION_DAYS, Math.floor(chosen));
}

/**
 * The instant before which messages are expired. Messages created exactly
 * AT the cutoff are kept — a 60-day policy that drops a message on its
 * 60th day has kept 59.
 */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  const days = Math.max(MIN_RETENTION_DAYS, Math.floor(retentionDays));
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export interface SweepPlan {
  /** ISO-8601. Messages with `created_at` strictly before this are expired. */
  readonly cutoff: string;
  /** Hard ceiling on rows deleted in one sweep — see this file's header. */
  readonly maxDeletes: number;
}

/** Default ceiling per sweep. Large enough to make progress, small enough to stay a bounded statement. */
export const DEFAULT_MAX_DELETES_PER_SWEEP = 1_000;

export function planSweep(
  now: Date,
  config: RetentionConfig,
  maxDeletes: number = DEFAULT_MAX_DELETES_PER_SWEEP,
): SweepPlan {
  return {
    cutoff: retentionCutoff(now, resolveRetentionDays(config)).toISOString(),
    maxDeletes: Math.max(1, Math.floor(maxDeletes)),
  };
}

/** A message, as retention sees it. Nothing else about a message is relevant here. */
export interface RetainableMessage {
  readonly id: string;
  readonly createdAt: string;
}

/**
 * Which of `messages` are expired under `plan`. Exposed for tests and for
 * callers that already hold rows; the repository does this in SQL rather
 * than loading a table to filter it in memory.
 */
export function selectExpired(
  messages: readonly RetainableMessage[],
  plan: SweepPlan,
): readonly RetainableMessage[] {
  const cutoffMs = new Date(plan.cutoff).getTime();
  return messages
    .filter((m) => new Date(m.createdAt).getTime() < cutoffMs)
    .slice(0, plan.maxDeletes);
}
