/**
 * Retry timing — exponential backoff with jitter, capped by the
 * `retryMax` attempt count carried on each meta_error_codes entry
 * (domain/meta-error-codes.ts) / Classification (domain/meta-error-classifier.ts).
 *
 * Pure: takes the policy numbers, the attempt count so far, "now", and an
 * injectable jitter source (defaults to Math.random) so tests are
 * deterministic.
 */

export interface RetryPolicyConfig {
  /** Maximum number of automatic retry attempts. 0 means never retry
   *  (the PERMANENT_* dispositions). */
  readonly retryMax: number;
  /** Base delay, in seconds, for the first retry. Doubles each subsequent
   *  attempt (exponential backoff). */
  readonly retryBaseDelaySeconds: number;
}

export interface RetryDecision {
  readonly shouldRetry: boolean;
  /** 0 when `shouldRetry` is false. */
  readonly delaySeconds: number;
  /** `null` when `shouldRetry` is false. */
  readonly nextAttemptAt: Date | null;
}

/** Returns a value in [0, 1). Injectable purely for deterministic tests. */
export type JitterSource = () => number;

/**
 * An upper bound on any single computed delay, regardless of how large
 * `attemptCount` grows. The spec caps retries by attempt COUNT
 * (`retryMax`), not by a delay ceiling, but an unbounded exponential term
 * is still an easy footgun (e.g. attempt 20 on a misconfigured policy) —
 * this ceiling is a defensive addition, not spec-mandated, documented here
 * so it isn't mistaken for a table-driven value.
 */
const MAX_DELAY_SECONDS = 60 * 60; // 1 hour

/**
 * Compute whether another attempt should happen and, if so, when.
 *
 * `attemptCount` is the number of attempts already made (0 before the
 * first retry, i.e. right after the first, original failure). Retries stop
 * once `attemptCount >= policy.retryMax` — for a PERMANENT_* policy
 * (`retryMax: 0`) this is true immediately, so `shouldRetry` is always
 * `false` from the very first failure, matching "never retry".
 *
 * Backoff is exponential in the attempt count (`base * 2^attemptCount`),
 * capped at `MAX_DELAY_SECONDS`, then jittered to between 50% and 100% of
 * the capped value — full jitter down to zero would risk near-simultaneous
 * retries clustering right back at the front of the window; a floor keeps
 * spacing meaningful while still avoiding a thundering herd at the exact
 * same instant.
 */
export function computeNextAttempt(
  policy: RetryPolicyConfig,
  attemptCount: number,
  now: Date,
  randomSource: JitterSource = Math.random,
): RetryDecision {
  if (attemptCount >= policy.retryMax) {
    return { shouldRetry: false, delaySeconds: 0, nextAttemptAt: null };
  }

  const rawDelay = policy.retryBaseDelaySeconds * 2 ** attemptCount;
  const cappedDelay = Math.min(rawDelay, MAX_DELAY_SECONDS);
  const jitterFactor = 0.5 + randomSource() * 0.5; // [0.5, 1.0)
  const delaySeconds = Math.max(0, Math.round(cappedDelay * jitterFactor));
  const nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);

  return { shouldRetry: true, delaySeconds, nextAttemptAt };
}
