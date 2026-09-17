import { describe, expect, it } from "vitest";
import { canTransitionRecipientStatus, isTerminalRecipientStatus } from "./recipient-status";

describe("canTransitionRecipientStatus", () => {
  const legal: Array<[string, string]> = [
    ["pending", "sent"],
    ["pending", "failed"],
    ["sent", "delivered"],
    ["sent", "failed"],
    ["delivered", "read"],
    ["delivered", "replied"],
    ["delivered", "failed"],
    ["read", "replied"],
  ];

  for (const [from, to] of legal) {
    it(`allows ${from} -> ${to}`, () => {
      expect(canTransitionRecipientStatus(from as never, to as never)).toBe(true);
    });
  }

  const illegal: Array<[string, string]> = [
    ["pending", "delivered"],
    ["pending", "read"],
    ["pending", "replied"],
    ["sent", "read"],
    ["sent", "replied"],
    ["sent", "pending"],
    ["delivered", "sent"],
    ["read", "delivered"],
    ["read", "failed"],
    ["replied", "read"],
    ["failed", "pending"],
    ["failed", "sent"],
  ];

  for (const [from, to] of illegal) {
    it(`rejects ${from} -> ${to}`, () => {
      expect(canTransitionRecipientStatus(from as never, to as never)).toBe(false);
    });
  }

  it("rejects a same-state transition", () => {
    expect(canTransitionRecipientStatus("sent", "sent")).toBe(false);
  });

  it("replied and failed are terminal", () => {
    expect(isTerminalRecipientStatus("replied")).toBe(true);
    expect(isTerminalRecipientStatus("failed")).toBe(true);
    expect(isTerminalRecipientStatus("pending")).toBe(false);
  });
});
