import { describe, expect, it } from "vitest";
import {
  assertUnreadInvariant,
  assignConversation,
  canTransitionConversationStatus,
  closeConversation,
  hasUnread,
  markRead,
  recordInboundMessage,
  recordOutboundMessage,
  reopenConversation,
  type ConversationRecord,
} from "./conversation";

function makeConversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" as never,
    accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa7" as never,
    contactId: "3fa85f64-5717-4562-b3fc-2c963f66afa8" as never,
    assignedUserId: null,
    lastMessageAt: null,
    unreadCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "open",
    lastInboundAt: null,
    ...overrides,
  };
}

describe("canTransitionConversationStatus", () => {
  it("allows open -> closed and closed -> open", () => {
    expect(canTransitionConversationStatus("open", "closed")).toBe(true);
    expect(canTransitionConversationStatus("closed", "open")).toBe(true);
  });

  it("rejects a same-state transition", () => {
    expect(canTransitionConversationStatus("open", "open")).toBe(false);
    expect(canTransitionConversationStatus("closed", "closed")).toBe(false);
  });
});

describe("closeConversation / reopenConversation", () => {
  it("closes an open conversation", () => {
    expect(closeConversation(makeConversation({ status: "open" })).status).toBe("closed");
  });

  it("is a no-op closing an already-closed conversation", () => {
    const closed = makeConversation({ status: "closed" });
    expect(closeConversation(closed)).toBe(closed);
  });

  it("reopens a closed conversation", () => {
    expect(reopenConversation(makeConversation({ status: "closed" })).status).toBe("open");
  });

  it("is a no-op reopening an already-open conversation", () => {
    const open = makeConversation({ status: "open" });
    expect(reopenConversation(open)).toBe(open);
  });
});

describe("assignConversation", () => {
  it("assigns to a member", () => {
    const userId = "3fa85f64-5717-4562-b3fc-2c963f66afa9" as never;
    expect(assignConversation(makeConversation(), userId).assignedUserId).toBe(userId);
  });

  it("unassigns with null", () => {
    const userId = "3fa85f64-5717-4562-b3fc-2c963f66afa9" as never;
    const assigned = makeConversation({ assignedUserId: userId });
    expect(assignConversation(assigned, null).assignedUserId).toBeNull();
  });

  it("is a no-op re-assigning to the same member", () => {
    const userId = "3fa85f64-5717-4562-b3fc-2c963f66afa9" as never;
    const assigned = makeConversation({ assignedUserId: userId });
    expect(assignConversation(assigned, userId)).toBe(assigned);
  });
});

describe("unread counting invariants", () => {
  it("a new inbound message increments unreadCount by exactly 1", () => {
    const c = makeConversation({ unreadCount: 0 });
    const next = recordInboundMessage(c, "2026-01-02T00:00:00.000Z");
    expect(next.unreadCount).toBe(1);
  });

  it("multiple inbound messages accumulate unreadCount one at a time", () => {
    let c = makeConversation({ unreadCount: 0 });
    for (let i = 0; i < 5; i++) {
      c = recordInboundMessage(c, `2026-01-02T00:00:0${i}.000Z`);
    }
    expect(c.unreadCount).toBe(5);
  });

  it("an inbound message advances both lastMessageAt and lastInboundAt", () => {
    const c = makeConversation();
    const next = recordInboundMessage(c, "2026-01-02T00:00:00.000Z");
    expect(next.lastMessageAt).toBe("2026-01-02T00:00:00.000Z");
    expect(next.lastInboundAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("an inbound message reopens a closed conversation", () => {
    const c = makeConversation({ status: "closed" });
    expect(recordInboundMessage(c, "2026-01-02T00:00:00.000Z").status).toBe("open");
  });

  it("an outbound message advances lastMessageAt but never touches unreadCount or lastInboundAt", () => {
    const c = makeConversation({ unreadCount: 3, lastInboundAt: "2026-01-01T00:00:00.000Z" });
    const next = recordOutboundMessage(c, "2026-01-02T00:00:00.000Z");
    expect(next.lastMessageAt).toBe("2026-01-02T00:00:00.000Z");
    expect(next.unreadCount).toBe(3);
    expect(next.lastInboundAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("markRead resets unreadCount to exactly 0, regardless of how high it was", () => {
    const c = makeConversation({ unreadCount: 42 });
    expect(markRead(c).unreadCount).toBe(0);
  });

  it("markRead is a no-op (same object) when already 0 — avoids a needless write", () => {
    const c = makeConversation({ unreadCount: 0 });
    expect(markRead(c)).toBe(c);
  });

  it("mark-read then new inbound produces exactly 1, never a residual count", () => {
    let c = makeConversation({ unreadCount: 7 });
    c = markRead(c);
    c = recordInboundMessage(c, "2026-01-02T00:00:00.000Z");
    expect(c.unreadCount).toBe(1);
  });

  it("interleaved inbound/outbound/mark-read stays correct", () => {
    let c = makeConversation({ unreadCount: 0 });
    c = recordInboundMessage(c, "t1"); // 1
    c = recordOutboundMessage(c, "t2"); // still 1
    c = recordInboundMessage(c, "t3"); // 2
    expect(c.unreadCount).toBe(2);
    c = markRead(c); // 0
    c = recordOutboundMessage(c, "t4"); // still 0
    expect(c.unreadCount).toBe(0);
    c = recordInboundMessage(c, "t5"); // 1
    expect(c.unreadCount).toBe(1);
  });

  it("hasUnread reflects unreadCount > 0", () => {
    expect(hasUnread(makeConversation({ unreadCount: 0 }))).toBe(false);
    expect(hasUnread(makeConversation({ unreadCount: 1 }))).toBe(true);
  });

  it("assertUnreadInvariant throws on a negative count and passes otherwise", () => {
    expect(() => assertUnreadInvariant(makeConversation({ unreadCount: 0 }))).not.toThrow();
    expect(() => assertUnreadInvariant(makeConversation({ unreadCount: -1 }))).toThrow();
  });
});
