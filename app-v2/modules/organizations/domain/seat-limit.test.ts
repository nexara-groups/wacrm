import { describe, expect, it } from "vitest";
import { resolveSeatLimit, PLATFORM_DEFAULT_SEAT_LIMIT_SEED, type SeatLimitInputs } from "./seat-limit";

describe("resolveSeatLimit — SEAT_LIMITS.md §2 / §7", () => {
  it("resolves to 3 with no plan and no override (platform default = 3)", () => {
    const input: SeatLimitInputs = {
      accountSeatLimitOverride: null,
      planIncludedSeats: null,
      platformDefaultSeatLimit: PLATFORM_DEFAULT_SEAT_LIMIT_SEED,
    };
    expect(resolveSeatLimit(input)).toBe(3);
  });

  it("plan value overrides the platform default", () => {
    const input: SeatLimitInputs = {
      accountSeatLimitOverride: null,
      planIncludedSeats: 10,
      platformDefaultSeatLimit: 3,
    };
    expect(resolveSeatLimit(input)).toBe(10);
  });

  it("account override beats both plan and platform default", () => {
    const input: SeatLimitInputs = {
      accountSeatLimitOverride: 25,
      planIncludedSeats: 10,
      platformDefaultSeatLimit: 3,
    };
    expect(resolveSeatLimit(input)).toBe(25);
  });

  it("seat_limit_override takes precedence over plan even when override is smaller", () => {
    // Precedence is structural (most specific wins), not "whichever is larger".
    const input: SeatLimitInputs = {
      accountSeatLimitOverride: 1,
      planIncludedSeats: 10,
      platformDefaultSeatLimit: 3,
    };
    expect(resolveSeatLimit(input)).toBe(1);
  });

  it("changing the platform default moves accounts that inherit it immediately", () => {
    // There is no caching in resolveSeatLimit: the same account (no override,
    // no plan) resolves to whatever platformDefaultSeatLimit is passed this
    // call — exactly what "moves immediately" means for a pure function.
    const before = resolveSeatLimit({
      accountSeatLimitOverride: null,
      planIncludedSeats: null,
      platformDefaultSeatLimit: 3,
    });
    const after = resolveSeatLimit({
      accountSeatLimitOverride: null,
      planIncludedSeats: null,
      platformDefaultSeatLimit: 5,
    });
    expect(before).toBe(3);
    expect(after).toBe(5);
  });

  it("changing the platform default does NOT move an account carrying an override", () => {
    const withOverrideBefore = resolveSeatLimit({
      accountSeatLimitOverride: 25,
      planIncludedSeats: null,
      platformDefaultSeatLimit: 3,
    });
    const withOverrideAfter = resolveSeatLimit({
      accountSeatLimitOverride: 25,
      planIncludedSeats: null,
      platformDefaultSeatLimit: 5,
    });
    expect(withOverrideBefore).toBe(25);
    expect(withOverrideAfter).toBe(25);
  });

  it("changing the platform default does NOT move an account on a plan with included seats", () => {
    const withPlanBefore = resolveSeatLimit({
      accountSeatLimitOverride: null,
      planIncludedSeats: 10,
      platformDefaultSeatLimit: 3,
    });
    const withPlanAfter = resolveSeatLimit({
      accountSeatLimitOverride: null,
      planIncludedSeats: 10,
      platformDefaultSeatLimit: 5,
    });
    expect(withPlanBefore).toBe(10);
    expect(withPlanAfter).toBe(10);
  });
});
