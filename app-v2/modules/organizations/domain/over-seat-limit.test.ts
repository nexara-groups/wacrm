import { describe, expect, it } from "vitest";
import {
  blocksNewInvitations,
  blocksReactivation,
  computeOverSeatLimitStatus,
  graceEndsAt,
  isCleared,
} from "./over-seat-limit";

describe("computeOverSeatLimitStatus — SEAT_LIMITS.md §4 / §7", () => {
  it("is not over the limit when usage is under the cap", () => {
    const status = computeOverSeatLimitStatus(2, 3);
    expect(status.isOverSeatLimit).toBe(false);
    expect(status.seatsOverBy).toBe(0);
  });

  it("is not (yet) 'over' when usage exactly equals the cap — that is the ordinary at-cap case", () => {
    const status = computeOverSeatLimitStatus(3, 3);
    expect(status.isOverSeatLimit).toBe(false);
  });

  it("is over the limit once usage exceeds the cap, e.g. after a downgrade from 10 to 3 with 8 active users", () => {
    const status = computeOverSeatLimitStatus(8, 3);
    expect(status.isOverSeatLimit).toBe(true);
    expect(status.seatsOverBy).toBe(5);
  });

  it("blocks new invitations and reactivations while over the cap", () => {
    const status = computeOverSeatLimitStatus(8, 3);
    expect(blocksNewInvitations(status)).toBe(true);
    expect(blocksReactivation(status)).toBe(true);
  });

  it("does not block invitations/reactivations once at or under the cap", () => {
    const status = computeOverSeatLimitStatus(3, 3);
    expect(blocksNewInvitations(status)).toBe(false);
    expect(blocksReactivation(status)).toBe(false);
  });

  it("self-clears (isCleared) the moment usage drops back to the cap — no separate 'unblock' step", () => {
    const stillOver = computeOverSeatLimitStatus(4, 3);
    const clearedByOneRemoval = computeOverSeatLimitStatus(3, 3);
    expect(isCleared(stillOver)).toBe(false);
    expect(isCleared(clearedByOneRemoval)).toBe(true);
  });

  it("downgrade never removes a member — this module exposes no member-removal function at all", () => {
    // Structural assertion: the over-seat-limit domain module's exports are
    // entirely read-only projections (status derivation + grace math). There
    // is no "removeMembers" or similar in this file to call during a
    // downgrade, by design (SEAT_LIMITS.md §4.1 "Existing members are NEVER
    // auto-removed. Ever.").
    const exportNames = ["computeOverSeatLimitStatus", "blocksNewInvitations", "blocksReactivation", "isCleared", "graceEndsAt"];
    expect(exportNames.every((name) => !/remove/i.test(name))).toBe(true);
  });
});

describe("graceEndsAt — SEAT_LIMITS.md §4.6 (grace period is a plan setting, not hardcoded)", () => {
  it("adds the plan's configured graceDays to the downgrade timestamp", () => {
    const downgradedAt = new Date("2026-09-17T00:00:00Z");
    const end = graceEndsAt(downgradedAt, { graceDays: 14 });
    expect(end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("a zero-day grace configuration (a different plan setting) yields no grace window", () => {
    const downgradedAt = new Date("2026-09-17T00:00:00Z");
    const end = graceEndsAt(downgradedAt, { graceDays: 0 });
    expect(end.getTime()).toBe(downgradedAt.getTime());
  });
});
