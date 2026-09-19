import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { RowCountingDatabaseProvider } from "../../../db/sqlite/row-counting-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlConversationRepository } from "./conversation-repository";
import { SqlMessageRepository } from "./message-repository";
import type { TenantContext } from "@nexara/core/context";
import type { ContactId, ConversationId, MessageId } from "@packages/domain";
import { INITIAL_SYNC_CURSOR } from "../domain/incremental-sync";
import { applyMessageStatusUpdate, timestampFieldForStatus } from "../domain/message";
import type { NewMessageInput } from "../application/ports";

const A: TenantContext = { tenantId: "acct-a" as never };
const B: TenantContext = { tenantId: "acct-b" as never };
const contact = (id: string) => id as unknown as ContactId;
const conversation = (id: string) => id as unknown as ConversationId;
const messageId = (id: string) => id as unknown as MessageId;

let db: SqlJsDatabaseProvider;
let conversations: SqlConversationRepository;
let messages: SqlMessageRepository;
let convA: ConversationId;
let convB: ConversationId;

function inbound(overrides: Partial<NewMessageInput> = {}): NewMessageInput {
  return {
    id: messageId(`msg-${Math.random().toString(36).slice(2)}`),
    conversationId: convA,
    contactId: contact("c-1"),
    direction: "inbound",
    type: "text",
    body: "hello",
    templateId: null,
    waMessageId: null,
    replyToId: null,
    mediaRef: null,
    status: "delivered",
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  conversations = new SqlConversationRepository(db);
  messages = new SqlMessageRepository(db);

  convA = (await conversations.create(A, { id: conversation("conv-a"), contactId: contact("c-1"), now: "t0" })).id as ConversationId;
  convB = (await conversations.create(B, { id: conversation("conv-b"), contactId: contact("c-2"), now: "t0" })).id as ConversationId;
});

describe("SqlMessageRepository", () => {
  it("inserts and reads back a message", async () => {
    const created = await messages.insert(A, inbound({ id: messageId("m-1") }));
    expect(created.body).toBe("hello");
    expect(created.direction).toBe("inbound");
    expect(created.status).toBe("delivered");

    const found = await messages.findById(A, messageId("m-1"));
    expect(found?.id).toBe("m-1");
  });

  it("insert() is idempotent on (account_id, wamid) — a redelivered webhook returns the existing row", async () => {
    const first = await messages.insert(A, inbound({ id: messageId("m-1"), waMessageId: "wamid.abc" }));
    const redelivered = await messages.insert(
      A,
      inbound({ id: messageId("m-2"), waMessageId: "wamid.abc", body: "different body" }),
    );
    expect(redelivered.id).toBe(first.id);
    expect(redelivered.body).toBe("hello");
    expect(await messages.findById(A, messageId("m-2"))).toBeNull();
  });

  it("the same wamid is allowed for two different tenants", async () => {
    const a = await messages.insert(A, inbound({ id: messageId("m-1"), conversationId: convA, waMessageId: "wamid.shared" }));
    const b = await messages.insert(B, inbound({ id: messageId("m-2"), conversationId: convB, waMessageId: "wamid.shared" }));
    expect(a.id).not.toBe(b.id);
    expect(await messages.findByWaMessageId(A, "wamid.shared")).not.toBeNull();
    expect(await messages.findByWaMessageId(B, "wamid.shared")).not.toBeNull();
  });

  it("TENANT ISOLATION — account B cannot read account A's messages", async () => {
    await messages.insert(A, inbound({ id: messageId("m-1"), waMessageId: "wamid.a" }));

    expect(await messages.findById(B, messageId("m-1"))).toBeNull();
    expect(await messages.findByWaMessageId(B, "wamid.a")).toBeNull();
    expect((await messages.listThread(B, convA, { limit: 10 })).items).toHaveLength(0);
  });

  it("TENANT ISOLATION — a cross-tenant save is a NO-OP, not a silent success", async () => {
    const m = await messages.insert(A, inbound({ id: messageId("m-1") }));
    const hijacked = { ...m, body: "hijacked" };

    await expect(messages.save(B, hijacked)).rejects.toThrow();

    const stillA = await messages.findById(A, messageId("m-1"));
    expect(stillA?.body).toBe("hello");
  });

  it("thread pagination is stable: no skipped or duplicated messages across pages, oldest last", async () => {
    for (let i = 0; i < 7; i++) {
      await messages.insert(
        A,
        inbound({
          id: messageId(`m-${i}`),
          occurredAt: `2026-01-01T00:00:0${i}.000Z`,
          body: `body-${i}`,
        }),
      );
    }

    const page1 = await messages.listThread(A, convA, { limit: 3 });
    expect(page1.items.map((m) => m.body)).toEqual(["body-6", "body-5", "body-4"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await messages.listThread(A, convA, { limit: 3, before: page1.nextCursor! });
    expect(page2.items.map((m) => m.body)).toEqual(["body-3", "body-2", "body-1"]);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await messages.listThread(A, convA, { limit: 3, before: page2.nextCursor! });
    expect(page3.items.map((m) => m.body)).toEqual(["body-0"]);
    expect(page3.nextCursor).toBeNull();

    const seen = [...page1.items, ...page2.items, ...page3.items].map((m) => m.id);
    expect(new Set(seen).size).toBe(7);
  });

  it("out-of-order status webhooks stay monotonic via the domain state machine, never decided by SQL", async () => {
    const created = await messages.insert(A, inbound({ id: messageId("m-1"), status: "pending" }));

    // 'delivered' arrives before 'sent' (Meta does not guarantee order).
    const toDelivered = applyMessageStatusUpdate(created.status, "delivered");
    expect(toDelivered.ok).toBe(true);
    if (!toDelivered.ok) throw new Error("unreachable");
    const deliveredField = timestampFieldForStatus(toDelivered.value);
    const afterDelivered = await messages.save(A, {
      ...created,
      status: toDelivered.value,
      ...(deliveredField ? { [deliveredField]: "2026-01-01T00:01:00.000Z" } : {}),
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
    expect(afterDelivered.status).toBe("delivered");

    // The stale 'sent' webhook shows up late — must be a no-op, not a regression.
    const staleSent = applyMessageStatusUpdate(afterDelivered.status, "sent");
    expect(staleSent.ok).toBe(true);
    if (!staleSent.ok) throw new Error("unreachable");
    expect(staleSent.value).toBe("delivered");
    const afterStale = await messages.save(A, { ...afterDelivered, status: staleSent.value, updatedAt: "2026-01-01T00:02:00.000Z" });
    expect(afterStale.status).toBe("delivered");
    expect(afterStale.sentAt).toBeNull();

    // A late 'failed' report after 'read' is rejected outright by the domain layer.
    const toRead = applyMessageStatusUpdate(afterStale.status, "read");
    if (!toRead.ok) throw new Error("unreachable");
    const readMsg = await messages.save(A, { ...afterStale, status: toRead.value, readAt: "2026-01-01T00:03:00.000Z", updatedAt: "2026-01-01T00:03:00.000Z" });
    const rejected = applyMessageStatusUpdate(readMsg.status, "failed");
    expect(rejected.ok).toBe(false);
  });

  it("listChangedSince (incremental sync) returns everything after the cursor and skips nothing under a same-timestamp tie", async () => {
    const m1 = await messages.insert(A, inbound({ id: messageId("m-1"), occurredAt: "2026-01-01T00:00:00.000Z" }));
    const m2 = await messages.insert(A, inbound({ id: messageId("m-2"), occurredAt: "2026-01-01T00:00:00.000Z" }));

    const all = await messages.listChangedSince(A, INITIAL_SYNC_CURSOR, 10);
    expect(all.items.map((m) => m.id).sort()).toEqual([m1.id, m2.id].sort());

    const tieCursor = { updatedAt: "2026-01-01T00:00:00.000Z", seenIds: [m1.id] };
    const rest = await messages.listChangedSince(A, tieCursor, 10);
    expect(rest.items.map((m) => m.id)).toEqual([m2.id]);

    const bothSeen = { updatedAt: "2026-01-01T00:00:00.000Z", seenIds: [m1.id, m2.id] };
    expect((await messages.listChangedSince(A, bothSeen, 10)).items).toHaveLength(0);
  });

  it("sets, swaps and removes reactions — one slot per (actor, message)", async () => {
    const m = await messages.insert(A, inbound({ id: messageId("m-1") }));

    await messages.setReaction(A, { id: "r-1", messageId: m.id as MessageId, actorType: "contact", actorId: "c-1", emoji: "👍", now: "t1" });
    expect((await messages.listReactions(A, [m.id as MessageId])).map((r) => r.emoji)).toEqual(["👍"]);

    // Swap: same actor, new emoji replaces rather than accumulates.
    await messages.setReaction(A, { id: "r-2", messageId: m.id as MessageId, actorType: "contact", actorId: "c-1", emoji: "❤️", now: "t2" });
    const afterSwap = await messages.listReactions(A, [m.id as MessageId]);
    expect(afterSwap).toHaveLength(1);
    expect(afterSwap[0]?.emoji).toBe("❤️");

    // Remove.
    await messages.setReaction(A, { id: "r-3", messageId: m.id as MessageId, actorType: "contact", actorId: "c-1", emoji: "", now: "t3" });
    expect(await messages.listReactions(A, [m.id as MessageId])).toHaveLength(0);
  });

  it("TENANT ISOLATION — reactions are not visible cross-tenant", async () => {
    const m = await messages.insert(A, inbound({ id: messageId("m-1") }));
    await messages.setReaction(A, { id: "r-1", messageId: m.id as MessageId, actorType: "contact", actorId: "c-1", emoji: "👍", now: "t1" });
    expect(await messages.listReactions(B, [m.id as MessageId])).toHaveLength(0);
  });

  it("records a message action with its metadata", async () => {
    const m = await messages.insert(A, inbound({ id: messageId("m-1") }));
    const action = await messages.recordAction(A, {
      id: "act-1",
      conversationId: convA,
      messageId: m.id as MessageId,
      actorUserId: "u-1",
      actionType: "status_changed",
      metadata: { from: "sent", to: "delivered" },
      now: "t1",
    });
    expect(action.actionType).toBe("status_changed");
    expect(action.metadata).toEqual({ from: "sent", to: "delivered" });
  });

  it("listThreadPage() paginates page/pageSize with a real total, no skipped or duplicated messages", async () => {
    for (let i = 0; i < 25; i++) {
      await messages.insert(
        A,
        inbound({ id: messageId(`m-${i}`), occurredAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, body: `body-${i}` }),
      );
    }

    const page1 = await messages.listThreadPage(A, convA, { page: 1, pageSize: 10 });
    expect(page1.items).toHaveLength(10);
    expect(page1.total).toBe(25);
    expect(page1.items[0]?.body).toBe("body-24");

    const page3 = await messages.listThreadPage(A, convA, { page: 3, pageSize: 10 });
    expect(page3.items).toHaveLength(5);
    expect(page3.total).toBe(25);

    const seen = new Set([
      ...page1.items.map((m) => m.id),
      ...(await messages.listThreadPage(A, convA, { page: 2, pageSize: 10 })).items.map((m) => m.id),
      ...page3.items.map((m) => m.id),
    ]);
    expect(seen.size).toBe(25);
  });

  it("TENANT ISOLATION — account B's listThreadPage never sees account A's messages", async () => {
    await messages.insert(A, inbound({ id: messageId("m-1") }));
    const result = await messages.listThreadPage(B, convA, { page: 1, pageSize: 10 });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("D1 rows-read cost: listThreadPage reads a bounded number of rows over a long thread, not the whole thread", async () => {
    for (let i = 0; i < 400; i++) {
      await messages.insert(A, inbound({ id: messageId(`m-${i}`), occurredAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`, body: `body-${i}` }));
    }

    const counting = new RowCountingDatabaseProvider(db);
    const costRepo = new SqlMessageRepository(counting);

    const page = await costRepo.listThreadPage(A, convA, { page: 1, pageSize: 20 });

    expect(page.items).toHaveLength(20);
    expect(page.total).toBe(400);
    // One COUNT(*) row + 20 page rows = 21. The pre-fix route walked the
    // ENTIRE keyset-paginated thread (400+ rows) to compute this same page.
    expect(counting.totalRowsReturned).toBeLessThan(60);
  });
});

describe("SqlMessageRepository — retention sweep", () => {
  /** Inserts a message with an explicit created_at, which `insert` does not expose. */
  async function messageAt(
    tenant: TenantContext,
    conversationId: ConversationId,
    id: string,
    createdAt: string,
    replyTo: string | null = null,
  ): Promise<void> {
    await db.query(
      `insert into messages
         (id, account_id, conversation_id, contact_id, wamid, direction, type, body,
          template_id, media_ref, status, error_code, reply_to, sent_at, delivered_at,
          read_at, created_at, updated_at)
       values ($1, $2, $3, $4, null, 'inbound', 'text', 'body', null, null, 'delivered',
               null, $5, null, null, null, $6, $6)`,
      [id, tenant.tenantId, conversationId, "c-1", replyTo, createdAt],
    );
  }

  it("deletes a message that a SURVIVING message replies to — the case D1's foreign key rejects", async () => {
    // THE TEST THIS FEATURE EXISTS FOR. `messages.reply_to` self-references
    // `messages(id)`. Deleting an old message that a recent one replies to is
    // a foreign-key violation, and D1 enforces foreign keys. Without nulling
    // the survivor's `reply_to` in the SAME batch, the delete is rejected and
    // retention silently never runs.
    //
    // This only fails here because the sql.js harness sets
    // `PRAGMA foreign_keys = ON` to match D1. With SQLite's default (OFF) the
    // broken version passes and leaves a dangling pointer instead.
    await messageAt(A, convA, "old-quoted", "2020-01-01T00:00:00.000Z");
    await messageAt(A, convA, "recent-reply", "2026-09-19T00:00:00.000Z", "old-quoted");

    const result = await messages.sweepExpiredMessages(A, "2026-08-01T00:00:00.000Z", 100);

    expect(result.deleted).toBe(1);
    const survivors = await db.query<{ id: string; reply_to: string | null }>(
      `select id, reply_to from messages where account_id = $1`,
      [A.tenantId],
    );
    expect(survivors.rows.map((r) => r.id)).toEqual(["recent-reply"]);
    // The survivor is kept, with its now-meaningless pointer cleared rather
    // than left dangling.
    expect(survivors.rows[0]?.reply_to).toBeNull();
  });

  it("deletes only messages older than the cutoff, oldest first", async () => {
    await messageAt(A, convA, "ancient", "2020-01-01T00:00:00.000Z");
    await messageAt(A, convA, "expired", "2026-07-01T00:00:00.000Z");
    await messageAt(A, convA, "kept", "2026-09-01T00:00:00.000Z");

    const result = await messages.sweepExpiredMessages(A, "2026-08-01T00:00:00.000Z", 100);

    expect(result).toEqual({ deleted: 2, more: false });
    const rest = await db.query<{ id: string }>(
      `select id from messages where account_id = $1`,
      [A.tenantId],
    );
    expect(rest.rows.map((r) => r.id)).toEqual(["kept"]);
  });

  it("stops at maxDeletes and reports that more remain", async () => {
    for (let i = 0; i < 5; i++) {
      await messageAt(A, convA, `old-${i}`, `2020-01-0${i + 1}T00:00:00.000Z`);
    }
    const first = await messages.sweepExpiredMessages(A, "2026-08-01T00:00:00.000Z", 2);
    expect(first).toEqual({ deleted: 2, more: true });

    const second = await messages.sweepExpiredMessages(A, "2026-08-01T00:00:00.000Z", 2);
    expect(second).toEqual({ deleted: 2, more: true });

    const third = await messages.sweepExpiredMessages(A, "2026-08-01T00:00:00.000Z", 2);
    expect(third).toEqual({ deleted: 1, more: false });
  });

  it("never touches another tenant's messages", async () => {
    await messageAt(A, convA, "a-old", "2020-01-01T00:00:00.000Z");
    await messageAt(B, convB, "b-old", "2020-01-01T00:00:00.000Z");

    await messages.sweepExpiredMessages(A, "2026-08-01T00:00:00.000Z", 100);

    const bRows = await db.query<{ id: string }>(
      `select id from messages where account_id = $1`,
      [B.tenantId],
    );
    expect(bRows.rows.map((r) => r.id)).toEqual(["b-old"]);
  });

  it("resolves the retention window, preferring an account override", async () => {
    // The other tests in this file never create an `accounts` row — they only
    // need `messages` and `conversations`. Retention config lives on
    // `accounts`, so this one does.
    await db.query(
      `insert into accounts (id, name, owner_user_id, created_at, updated_at)
       values ($1, 'Tenant A', 'owner-a', 't0', 't0')`,
      [A.tenantId],
    );

    const base = await messages.getRetentionConfig(A);
    expect(base).toEqual({ accountRetentionDaysOverride: null, platformDefaultRetentionDays: 60 });

    await db.query(`update accounts set message_retention_days_override = $2 where id = $1`, [
      A.tenantId,
      180,
    ]);
    const overridden = await messages.getRetentionConfig(A);
    expect(overridden.accountRetentionDaysOverride).toBe(180);
  });
});
