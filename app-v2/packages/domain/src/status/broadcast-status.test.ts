import { describe, expect, it } from "vitest";
import { canTransitionBroadcastStatus, isTerminalBroadcastStatus } from "./broadcast-status";

describe("canTransitionBroadcastStatus", () => {
  const legal: Array<[string, string]> = [
    ["draft", "scheduled"],
    ["draft", "sending"],
    ["scheduled", "sending"],
    ["scheduled", "draft"],
    ["scheduled", "failed"],
    ["sending", "sent"],
    ["sending", "failed"],
  ];

  for (const [from, to] of legal) {
    it(`allows ${from} -> ${to}`, () => {
      expect(canTransitionBroadcastStatus(from as never, to as never)).toBe(true);
    });
  }

  const illegal: Array<[string, string]> = [
    ["draft", "sent"],
    ["draft", "failed"],
    ["sent", "sending"],
    ["sent", "draft"],
    ["failed", "sending"],
    ["failed", "draft"],
    ["sending", "draft"],
    ["sending", "scheduled"],
  ];

  for (const [from, to] of illegal) {
    it(`rejects ${from} -> ${to}`, () => {
      expect(canTransitionBroadcastStatus(from as never, to as never)).toBe(false);
    });
  }

  it("rejects a same-state transition", () => {
    expect(canTransitionBroadcastStatus("draft", "draft")).toBe(false);
  });

  it("sent and failed are terminal", () => {
    expect(isTerminalBroadcastStatus("sent")).toBe(true);
    expect(isTerminalBroadcastStatus("failed")).toBe(true);
    expect(isTerminalBroadcastStatus("draft")).toBe(false);
  });
});
