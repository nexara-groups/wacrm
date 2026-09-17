import { describe, expect, it } from "vitest";
import { computeNextAttempt, type RetryPolicyConfig } from "./retry-policy";

const NOW = new Date("2026-01-01T00:00:00Z");

describe("computeNextAttempt", () => {
  it("never retries a retryMax: 0 policy (PERMANENT_* dispositions)", () => {
    const policy: RetryPolicyConfig = { retryMax: 0, retryBaseDelaySeconds: 0 };
    const decision = computeNextAttempt(policy, 0, NOW);
    expect(decision.shouldRetry).toBe(false);
    expect(decision.delaySeconds).toBe(0);
    expect(decision.nextAttemptAt).toBeNull();
  });

  it("retries while attemptCount is below retryMax", () => {
    const policy: RetryPolicyConfig = { retryMax: 3, retryBaseDelaySeconds: 10 };
    expect(computeNextAttempt(policy, 0, NOW).shouldRetry).toBe(true);
    expect(computeNextAttempt(policy, 1, NOW).shouldRetry).toBe(true);
    expect(computeNextAttempt(policy, 2, NOW).shouldRetry).toBe(true);
  });

  it("stops retrying once attemptCount reaches retryMax", () => {
    const policy: RetryPolicyConfig = { retryMax: 3, retryBaseDelaySeconds: 10 };
    const decision = computeNextAttempt(policy, 3, NOW);
    expect(decision.shouldRetry).toBe(false);
    expect(decision.nextAttemptAt).toBeNull();
  });

  it("backs off exponentially: delay grows with attempt count (jitter fixed at 1.0)", () => {
    const policy: RetryPolicyConfig = { retryMax: 5, retryBaseDelaySeconds: 10 };
    const noJitter = () => 0.999999; // -> jitterFactor ~1.0, deterministic upper bound
    const d0 = computeNextAttempt(policy, 0, NOW, noJitter).delaySeconds;
    const d1 = computeNextAttempt(policy, 1, NOW, noJitter).delaySeconds;
    const d2 = computeNextAttempt(policy, 2, NOW, noJitter).delaySeconds;
    expect(d0).toBeCloseTo(10, 0);
    expect(d1).toBeCloseTo(20, 0);
    expect(d2).toBeCloseTo(40, 0);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it("jitter keeps the delay within [50%, 100%] of the unjittered exponential value", () => {
    const policy: RetryPolicyConfig = { retryMax: 5, retryBaseDelaySeconds: 100 };
    for (const rand of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const decision = computeNextAttempt(policy, 1, NOW, () => rand); // unjittered = 200
      expect(decision.delaySeconds).toBeGreaterThanOrEqual(100);
      expect(decision.delaySeconds).toBeLessThanOrEqual(200);
    }
  });

  it("caps the delay so it never grows unbounded", () => {
    const policy: RetryPolicyConfig = { retryMax: 50, retryBaseDelaySeconds: 100 };
    const decision = computeNextAttempt(policy, 40, NOW, () => 0.999999);
    expect(decision.delaySeconds).toBeLessThanOrEqual(3600);
  });

  it("sets nextAttemptAt to now + delaySeconds", () => {
    const policy: RetryPolicyConfig = { retryMax: 3, retryBaseDelaySeconds: 10 };
    const decision = computeNextAttempt(policy, 0, NOW, () => 0.999999);
    expect(decision.nextAttemptAt).not.toBeNull();
    const expectedMs = NOW.getTime() + decision.delaySeconds * 1000;
    expect(decision.nextAttemptAt!.getTime()).toBe(expectedMs);
  });

  it("defaults to Math.random when no jitter source is given (produces a valid decision)", () => {
    const policy: RetryPolicyConfig = { retryMax: 3, retryBaseDelaySeconds: 5 };
    const decision = computeNextAttempt(policy, 0, NOW);
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delaySeconds).toBeGreaterThanOrEqual(0);
  });
});
