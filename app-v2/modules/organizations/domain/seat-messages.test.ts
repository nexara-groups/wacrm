import { describe, expect, it } from "vitest";
import { SEAT_MESSAGES, SEAT_MESSAGES_3_SEAT_EXAMPLE } from "./seat-messages";

describe("seat messages — SEAT_LIMITS.md §3 exact wording", () => {
  it("matches the spec's exact 3-seat wording for every situation", () => {
    expect(SEAT_MESSAGES.atCap(3)).toBe(
      "You've used all 3 user seats on your plan. Remove a user or upgrade to add more.",
    );
    expect(SEAT_MESSAGES.pendingInvitesUsage(3, 3, 1)).toBe(
      "3 of 3 seats used — 1 is a pending invitation that hasn't been accepted yet.",
    );
    expect(SEAT_MESSAGES.acceptFailedCapReached).toBe(
      "This workspace has no free seats. Ask the account owner to free one or upgrade.",
    );
    expect(SEAT_MESSAGES.approachingCap(1)).toBe("1 seat left on your plan.");
  });

  it("the pinned 3-seat example constants equal the templates evaluated at seatLimit = 3", () => {
    expect(SEAT_MESSAGES_3_SEAT_EXAMPLE.atCap).toBe(SEAT_MESSAGES.atCap(3));
    expect(SEAT_MESSAGES_3_SEAT_EXAMPLE.pendingInvitesUsage).toBe(SEAT_MESSAGES.pendingInvitesUsage(3, 3, 1));
    expect(SEAT_MESSAGES_3_SEAT_EXAMPLE.acceptFailedCapReached).toBe(SEAT_MESSAGES.acceptFailedCapReached);
    expect(SEAT_MESSAGES_3_SEAT_EXAMPLE.approachingCap).toBe(SEAT_MESSAGES.approachingCap(1));
  });

  it("no jargon: none of the messages mention internal terms", () => {
    const jargon = /seat_limit|over_seat_limit|tenant|platform_settings|account_role_enum/i;
    for (const text of Object.values(SEAT_MESSAGES_3_SEAT_EXAMPLE)) {
      expect(jargon.test(text)).toBe(false);
    }
  });
});
