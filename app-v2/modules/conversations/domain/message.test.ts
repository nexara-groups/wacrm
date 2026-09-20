import { describe, expect, it } from "vitest";
import type { RecipientStatus } from "@packages/domain";
import {
  applyMessageStatusUpdate,
  applyReaction,
  assertMediaInvariant,
  isDirectStatusTransition,
  timestampFieldForStatus,
  validateReplyTarget,
  type MessageReaction,
} from "./message";

describe("applyMessageStatusUpdate — legal transitions", () => {
  const legal: Array<[RecipientStatus, RecipientStatus]> = [
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
    it(`accepts ${from} -> ${to}`, () => {
      const result = applyMessageStatusUpdate(from, to);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(to);
    });
  }
});

describe("applyMessageStatusUpdate — illegal transitions are rejected", () => {
  it("rejects 'failed' arriving after 'read' (delivery already confirmed)", () => {
    const result = applyMessageStatusUpdate("read", "failed");
    expect(result.ok).toBe(false);
  });

  it("rejects 'failed' arriving after 'replied'", () => {
    const result = applyMessageStatusUpdate("replied", "failed");
    expect(result.ok).toBe(false);
  });

  it("rejects any further transition once 'failed' (terminal)", () => {
    for (const to of ["pending", "sent", "delivered", "read", "replied"] as const) {
      const result = applyMessageStatusUpdate("failed", to);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects any further transition once 'replied' (terminal), except itself", () => {
    for (const to of ["pending", "sent", "delivered", "read"] as const) {
      const result = applyMessageStatusUpdate("replied", to);
      expect(result.ok).toBe(false);
    }
  });
});

describe("applyMessageStatusUpdate — out-of-order webhooks stay monotonic", () => {
  it("a 'delivered' webhook landing before 'sent' moves the message straight to delivered", () => {
    const result = applyMessageStatusUpdate("pending", "delivered");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("delivered");
  });

  it("a 'read' webhook landing before both 'sent' and 'delivered' skips straight to read", () => {
    const result = applyMessageStatusUpdate("pending", "read");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("read");
  });

  it("a late 'sent' webhook arriving after 'delivered' is a no-op, not an error or a regression", () => {
    const result = applyMessageStatusUpdate("delivered", "sent");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("delivered");
  });

  it("a late 'delivered' webhook arriving after 'read' is a no-op", () => {
    const result = applyMessageStatusUpdate("read", "delivered");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("read");
  });

  it("a duplicate/replayed webhook reporting the current status is an idempotent no-op", () => {
    const result = applyMessageStatusUpdate("delivered", "delivered");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("delivered");
  });

  it("full out-of-order sequence: delivered, then sent, then read, then sent again — ends at read", () => {
    let status: RecipientStatus = "pending";
    for (const incoming of ["delivered", "sent", "read", "sent"] as const) {
      const result = applyMessageStatusUpdate(status, incoming);
      expect(result.ok).toBe(true);
      if (result.ok) status = result.value;
    }
    expect(status).toBe("read");
  });
});

describe("isDirectStatusTransition", () => {
  it("mirrors the shared single-hop legal graph", () => {
    expect(isDirectStatusTransition("pending", "sent")).toBe(true);
    expect(isDirectStatusTransition("pending", "delivered")).toBe(false);
  });
});

describe("timestampFieldForStatus", () => {
  it("maps sent/delivered/read to their column", () => {
    expect(timestampFieldForStatus("sent")).toBe("sentAt");
    expect(timestampFieldForStatus("delivered")).toBe("deliveredAt");
    expect(timestampFieldForStatus("read")).toBe("readAt");
  });

  it("has no dedicated column for pending/replied/failed", () => {
    expect(timestampFieldForStatus("pending")).toBeNull();
    expect(timestampFieldForStatus("replied")).toBeNull();
    expect(timestampFieldForStatus("failed")).toBeNull();
  });
});

describe("assertMediaInvariant", () => {
  it("passes for a media message with a mediaRef", () => {
    expect(() => assertMediaInvariant({ type: "media", mediaRef: "r2://x" })).not.toThrow();
  });

  it("throws for a media message with no mediaRef", () => {
    expect(() => assertMediaInvariant({ type: "media", mediaRef: null })).toThrow();
  });

  it("throws for a non-media message carrying a mediaRef", () => {
    expect(() => assertMediaInvariant({ type: "text", mediaRef: "r2://x" })).toThrow();
  });

  it("passes for a text message with no mediaRef", () => {
    expect(() => assertMediaInvariant({ type: "text", mediaRef: null })).not.toThrow();
  });
});

describe("validateReplyTarget", () => {
  const accountId = "3fa85f64-5717-4562-b3fc-2c963f66afa6" as never;
  const conversationId = "3fa85f64-5717-4562-b3fc-2c963f66afa7" as never;
  const otherConversationId = "3fa85f64-5717-4562-b3fc-2c963f66afa8" as never;
  const targetId = "3fa85f64-5717-4562-b3fc-2c963f66afa9" as never;

  it("accepts a reply target in the same conversation and account", () => {
    const result = validateReplyTarget(
      { accountId, conversationId },
      { id: targetId, accountId, conversationId },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(targetId);
  });

  it("rejects a reply target from a different conversation", () => {
    const result = validateReplyTarget(
      { accountId, conversationId },
      { id: targetId, accountId, conversationId: otherConversationId },
    );
    expect(result.ok).toBe(false);
  });
});

describe("applyReaction", () => {
  const base = {
    id: "r1",
    accountId: "acc" as never,
    messageId: "m1" as never,
    actorType: "user" as const,
    actorId: "u1",
    emoji: "👍",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("adds a reaction when the actor has none yet", () => {
    const result = applyReaction([], base);
    expect(result).toHaveLength(1);
    expect(result[0]?.emoji).toBe("👍");
  });

  it("swaps an actor's existing reaction on the same message rather than adding a second", () => {
    const existing: readonly MessageReaction[] = [
      { ...base, id: "r0", emoji: "❤️" },
    ];
    const result = applyReaction(existing, { ...base, id: "r1", emoji: "👍" });
    expect(result).toHaveLength(1);
    expect(result[0]?.emoji).toBe("👍");
  });

  it("removes the actor's reaction when emoji is empty", () => {
    const existing: readonly MessageReaction[] = [{ ...base, id: "r0" }];
    const result = applyReaction(existing, { ...base, emoji: "" });
    expect(result).toHaveLength(0);
  });

  it("leaves other actors' reactions on the same message untouched", () => {
    const other: MessageReaction = { ...base, id: "r-other", actorId: "u2", emoji: "🔥" };
    const result = applyReaction([other], { ...base, emoji: "👍" });
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.actorId === "u2")?.emoji).toBe("🔥");
  });
});
