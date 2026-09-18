import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlConversationRepository } from "./conversation-repository";
import type { TenantContext } from "@nexara/core/context";
import type { ContactId, ConversationId } from "@packages/domain";
import { INITIAL_SYNC_CURSOR } from "../domain/incremental-sync";
import { markRead, recordInboundMessage, recordOutboundMessage } from "../domain/conversation";

const A: TenantContext = { tenantId: "acct-a" as never };
const B: TenantContext = { tenantId: "acct-b" as never };
const contact = (id: string) => id as unknown as ContactId;
const conversationId = (id: string) => id as unknown as ConversationId;

let db: SqlJsDatabaseProvider;
let repo: SqlConversationRepository;

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repo = new SqlConversationRepository(db);
});

describe("SqlConversationRepository", () => {
  it("creates and reads back a conversation", async () => {
    const created = await repo.create(A, {
      id: conversationId("11111111-1111-1111-1111-111111111111"),
      contactId: contact("c-1"),
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(created.status).toBe("open");
    expect(created.unreadCount).toBe(0);
    expect(created.lastMessageAt).toBeNull();
    expect(created.lastInboundAt).toBeNull();

    const found = await repo.findById(A, created.id as ConversationId);
    expect(found?.contactId).toBe("c-1");

    const byContact = await repo.findByContactId(A, contact("c-1"));
    expect(byContact?.id).toBe(created.id);
  });

  it("create() is race-safe: a second create for the same contact returns the existing row", async () => {
    const id1 = conversationId("11111111-1111-1111-1111-111111111111");
    const id2 = conversationId("22222222-2222-2222-2222-222222222222");
    const first = await repo.create(A, { id: id1, contactId: contact("c-1"), now: "t0" });
    // Simulates the loser of a race: a second insert attempt for the same
    // (account_id, contact_id) — the unique index rejects it, and the
    // repository must return the winner's row rather than throwing.
    const second = await repo.create(A, { id: id2, contactId: contact("c-1"), now: "t0" });
    expect(second.id).toBe(first.id);
  });

  it("TENANT ISOLATION — account B cannot read account A's conversation", async () => {
    const a = await repo.create(A, { id: conversationId("11111111-1111-1111-1111-111111111111"), contactId: contact("c-1"), now: "t0" });

    expect(await repo.findById(B, a.id as ConversationId)).toBeNull();
    expect(await repo.findByContactId(B, contact("c-1"))).toBeNull();
    expect((await repo.list(B, {}, { limit: 10 })).items).toHaveLength(0);
    expect(await repo.countUnreadConversations(B)).toBe(0);
  });

  it("TENANT ISOLATION — a cross-tenant save is a NO-OP, not a silent success", async () => {
    const a = await repo.create(A, { id: conversationId("11111111-1111-1111-1111-111111111111"), contactId: contact("c-1"), now: "t0" });
    const hijacked = { ...a, assignedUserId: "u-evil" as never };

    await expect(repo.save(B, hijacked)).rejects.toThrow();

    const stillA = await repo.findById(A, a.id as ConversationId);
    expect(stillA?.assignedUserId).toBeNull();
  });

  it("recordInboundMessage bumps unread, advances last_message_at and last_inbound_at, and reopens", async () => {
    const created = await repo.create(A, { id: conversationId("11111111-1111-1111-1111-111111111111"), contactId: contact("c-1"), now: "t0" });

    const afterFirstInbound = recordInboundMessage(created, "2026-01-01T00:00:01.000Z");
    const saved1 = await repo.save(A, afterFirstInbound);
    expect(saved1.unreadCount).toBe(1);
    expect(saved1.lastMessageAt).toBe("2026-01-01T00:00:01.000Z");
    expect(saved1.lastInboundAt).toBe("2026-01-01T00:00:01.000Z");
    expect(saved1.status).toBe("open");

    const afterSecondInbound = recordInboundMessage(saved1, "2026-01-01T00:00:02.000Z");
    const saved2 = await repo.save(A, afterSecondInbound);
    expect(saved2.unreadCount).toBe(2);
    expect(saved2.lastInboundAt).toBe("2026-01-01T00:00:02.000Z");

    // Outbound advances last_message_at only.
    const afterOutbound = recordOutboundMessage(saved2, "2026-01-01T00:00:03.000Z");
    const saved3 = await repo.save(A, afterOutbound);
    expect(saved3.unreadCount).toBe(2);
    expect(saved3.lastMessageAt).toBe("2026-01-01T00:00:03.000Z");
    expect(saved3.lastInboundAt).toBe("2026-01-01T00:00:02.000Z");

    // markRead resets to zero as a whole-conversation action.
    const read = await repo.save(A, markRead(saved3));
    expect(read.unreadCount).toBe(0);
    expect(await repo.countUnreadConversations(A)).toBe(0);
  });

  it("countUnreadConversations counts conversations with unread mail, never a message scan", async () => {
    const c1 = await repo.create(A, { id: conversationId("11111111-1111-1111-1111-111111111111"), contactId: contact("c-1"), now: "t0" });
    const c2 = await repo.create(A, { id: conversationId("22222222-2222-2222-2222-222222222222"), contactId: contact("c-2"), now: "t0" });
    await repo.create(A, { id: conversationId("33333333-3333-3333-3333-333333333333"), contactId: contact("c-3"), now: "t0" });

    await repo.save(A, recordInboundMessage(c1, "t1"));
    await repo.save(A, recordInboundMessage(recordInboundMessage(c2, "t1"), "t2"));
    // c3 stays at zero unread.

    expect(await repo.countUnreadConversations(A)).toBe(2);
  });

  it("list() paginates newest-last_message_at-first without skipping or repeating rows", async () => {
    for (let i = 0; i < 5; i++) {
      const c = await repo.create(A, { id: conversationId(`conv-${i}`), contactId: contact(`c-${i}`), now: "t0" });
      await repo.save(A, recordInboundMessage(c, `2026-01-01T00:00:0${i}.000Z`));
    }

    const page1 = await repo.list(A, {}, { limit: 2 });
    expect(page1.items.map((c) => c.contactId)).toEqual(["c-4", "c-3"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await repo.list(A, {}, { limit: 2, before: page1.nextCursor! });
    expect(page2.items.map((c) => c.contactId)).toEqual(["c-2", "c-1"]);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await repo.list(A, {}, { limit: 2, before: page2.nextCursor! });
    expect(page3.items.map((c) => c.contactId)).toEqual(["c-0"]);
    expect(page3.nextCursor).toBeNull();

    // No overlap and no gaps across the three pages.
    const seen = [...page1.items, ...page2.items, ...page3.items].map((c) => c.id);
    expect(new Set(seen).size).toBe(5);
  });

  it("list() filters by status and assignedUserId", async () => {
    const open = await repo.create(A, { id: conversationId("11111111-1111-1111-1111-111111111111"), contactId: contact("c-1"), now: "t0" });
    const toClose = await repo.create(A, { id: conversationId("22222222-2222-2222-2222-222222222222"), contactId: contact("c-2"), now: "t0" });
    await repo.save(A, { ...toClose, status: "closed" });
    await repo.save(A, { ...open, assignedUserId: "u-1" as never });

    const openOnly = await repo.list(A, { status: "open" }, { limit: 10 });
    expect(openOnly.items.map((c) => c.contactId)).toEqual(["c-1"]);

    const assigned = await repo.list(A, { assignedUserId: "u-1" as never }, { limit: 10 });
    expect(assigned.items.map((c) => c.contactId)).toEqual(["c-1"]);

    const unassigned = await repo.list(A, { assignedUserId: null }, { limit: 10 });
    expect(unassigned.items.map((c) => c.contactId)).toEqual(["c-2"]);
  });

  it("listChangedSince (incremental sync) returns everything after the cursor and skips nothing under a same-timestamp tie", async () => {
    const c1 = await repo.create(A, { id: conversationId("11111111-1111-1111-1111-111111111111"), contactId: contact("c-1"), now: "2026-01-01T00:00:00.000Z" });
    const c2 = await repo.create(A, { id: conversationId("22222222-2222-2222-2222-222222222222"), contactId: contact("c-2"), now: "2026-01-01T00:00:00.000Z" });

    // Both rows share the exact same updated_at (a real case: two writers
    // committing at once). A naive `updated_at > cursor` cursor set to this
    // instant after seeing only c1 would permanently lose c2.
    const all = await repo.listChangedSince(A, INITIAL_SYNC_CURSOR, 10);
    expect(all.items.map((c) => c.id).sort()).toEqual([c1.id, c2.id].sort());

    const tieCursor = { updatedAt: "2026-01-01T00:00:00.000Z", seenIds: [c1.id] };
    const rest = await repo.listChangedSince(A, tieCursor, 10);
    expect(rest.items.map((c) => c.id)).toEqual([c2.id]);

    const bothSeenCursor = { updatedAt: "2026-01-01T00:00:00.000Z", seenIds: [c1.id, c2.id] };
    expect((await repo.listChangedSince(A, bothSeenCursor, 10)).items).toHaveLength(0);

    // A later write is picked up by a plain cursor advance.
    await repo.save(A, recordInboundMessage(c1, "2026-01-02T00:00:00.000Z"));
    const advanced = await repo.listChangedSince(A, { updatedAt: "2026-01-01T00:00:00.000Z", seenIds: [c1.id, c2.id] }, 10);
    expect(advanced.items.map((c) => c.id)).toEqual([c1.id]);
  });
});

describe("updated_at is the sync cursor and MUST advance on every save", () => {
  // The whole incremental-sync design rests on this one property, and it is
  // guaranteed only by the repository stamping its own clock: the domain is
  // deliberately clock-free ("callers supply timestamps") and the application
  // layer never sets updatedAt before save(). Nothing else enforces it, so a
  // future refactor that "simplifies" save() into trusting the passed-in
  // record would silently stop advancing the cursor — and clients would stop
  // receiving changes, with no test failing and no error anywhere.
  it("advances updated_at even when the domain returns an unchanged timestamp", async () => {
    const created = await repo.create(A, {
      id: conversationId("33333333-3333-3333-3333-333333333333"),
      contactId: contact("c-9"),
      now: "2026-01-01T00:00:00.000Z",
    });

    // recordInboundMessage is pure and leaves updatedAt exactly as it found
    // it — this assertion documents the gap the repository compensates for.
    const afterInbound = recordInboundMessage(created, "2026-01-02T00:00:00.000Z");
    expect(afterInbound.updatedAt).toBe(created.updatedAt);

    const saved = await repo.save(A, afterInbound);
    expect(saved).not.toBeNull();
    expect(saved!.updatedAt > created.updatedAt).toBe(true);
  });

  it("a saved change is visible to a cursor positioned at the previous value", async () => {
    // The property that actually matters to a client: after a write, polling
    // with the cursor you last held returns the changed row.
    const created = await repo.create(A, {
      id: conversationId("44444444-4444-4444-4444-444444444444"),
      contactId: contact("c-10"),
      now: "2026-01-01T00:00:00.000Z",
    });
    const cursorBefore = { updatedAt: created.updatedAt, seenIds: [created.id] };
    expect((await repo.listChangedSince(A, cursorBefore, 10)).items).toHaveLength(0);

    const saved = await repo.save(A, recordInboundMessage(created, "2026-01-02T00:00:00.000Z"));
    expect(saved).not.toBeNull();

    const changed = await repo.listChangedSince(A, cursorBefore, 10);
    expect(changed.items.map((c) => c.id)).toContain(created.id);
  });

  it("never moves updated_at backwards", async () => {
    const created = await repo.create(A, {
      id: conversationId("55555555-5555-5555-5555-555555555555"),
      contactId: contact("c-11"),
      now: "2026-01-01T00:00:00.000Z",
    });
    // A caller handing back a far-future timestamp must not be clobbered by
    // the repository's own (earlier) clock — monotonic, not "always now".
    const future = "2099-01-01T00:00:00.000Z";
    const saved = await repo.save(A, { ...created, updatedAt: future as never });
    expect(saved!.updatedAt).toBe(future);
  });
});
