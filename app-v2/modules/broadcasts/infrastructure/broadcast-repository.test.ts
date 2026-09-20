import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { RowCountingDatabaseProvider } from "../../../db/sqlite/row-counting-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlBroadcastRecipientRepository, SqlBroadcastRepository } from "./broadcast-repository";
import { AccountId, ContactId, TemplateId, UserId } from "../../../packages/domain/src/ids";
import type { RecipientOutcomeUpdate } from "../application/ports";

const ACCOUNT_A = AccountId(crypto.randomUUID());
const ACCOUNT_B = AccountId(crypto.randomUUID());
const TEMPLATE = TemplateId(crypto.randomUUID());
const CREATED_BY = UserId(crypto.randomUUID());

let db: SqlJsDatabaseProvider;
let broadcasts: SqlBroadcastRepository;
let recipients: SqlBroadcastRecipientRepository;

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  broadcasts = new SqlBroadcastRepository(db);
  recipients = new SqlBroadcastRecipientRepository(db);
});

async function makeBroadcast(accountId = ACCOUNT_A) {
  return broadcasts.create({
    accountId,
    name: "Diwali sale",
    templateId: TEMPLATE,
    createdBy: CREATED_BY,
    scheduledAt: null,
  });
}

const BASE_OUTCOME: RecipientOutcomeUpdate = {
  status: "failed",
  errorCode: null,
  errorMessage: null,
  disposition: null,
  attemptCount: 1,
  nextAttemptAt: null,
};

describe("SqlBroadcastRepository", () => {
  it("creates a broadcast and reads it back", async () => {
    const created = await makeBroadcast();
    expect(created.status).toBe("draft");
    expect(created.totalRecipients).toBe(0);
    expect(created.pausedAt).toBeNull();

    const fetched = await broadcasts.getById(ACCOUNT_A, created.id);
    expect(fetched?.name).toBe("Diwali sale");
    expect(fetched?.templateId).toBe(TEMPLATE);
  });

  it("records audience counts and increments send/failure counts independently", async () => {
    const b = await makeBroadcast();
    await broadcasts.recordAudience(ACCOUNT_A, b.id, 100, 12);
    await broadcasts.updateStatus(ACCOUNT_A, b.id, "sending");
    await broadcasts.incrementCounts(ACCOUNT_A, b.id, { sent: 3, failed: 1 });
    await broadcasts.incrementCounts(ACCOUNT_A, b.id, { sent: 2, failed: 0 });

    const after = await broadcasts.getById(ACCOUNT_A, b.id);
    expect(after?.totalRecipients).toBe(100);
    expect(after?.skippedCount).toBe(12);
    expect(after?.status).toBe("sending");
    expect(after?.sentCount).toBe(5);
    expect(after?.failedCount).toBe(1);
  });

  it("pauses and resumes without touching status", async () => {
    const b = await makeBroadcast();
    await broadcasts.updateStatus(ACCOUNT_A, b.id, "sending");
    await broadcasts.setPaused(ACCOUNT_A, b.id, "2026-01-01T00:00:00.000Z", "rate limited");
    let after = await broadcasts.getById(ACCOUNT_A, b.id);
    expect(after?.status).toBe("sending");
    expect(after?.pausedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(after?.pauseReason).toBe("rate limited");

    await broadcasts.setPaused(ACCOUNT_A, b.id, null, null);
    after = await broadcasts.getById(ACCOUNT_A, b.id);
    expect(after?.pausedAt).toBeNull();
    expect(after?.pauseReason).toBeNull();
  });

  it("paginates listForAccount with a keyset cursor", async () => {
    for (let i = 0; i < 5; i++) await makeBroadcast();

    const page1 = await broadcasts.listForAccount(ACCOUNT_A, null, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await broadcasts.listForAccount(ACCOUNT_A, page1.nextCursor, 2);
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await broadcasts.listForAccount(ACCOUNT_A, page2.nextCursor, 2);
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const seenIds = new Set([...page1.items, ...page2.items, ...page3.items].map((b) => b.id));
    expect(seenIds.size).toBe(5);
  });

  it("TENANT ISOLATION — account B cannot read account A's broadcasts, and a cross-tenant write is a no-op", async () => {
    const a = await makeBroadcast(ACCOUNT_A);

    expect(await broadcasts.getById(ACCOUNT_B, a.id)).toBeNull();
    expect((await broadcasts.listForAccount(ACCOUNT_B, null, 50)).items).toHaveLength(0);

    // Cross-tenant writes must be no-ops, not silent cross-tenant mutation.
    await broadcasts.updateStatus(ACCOUNT_B, a.id, "sending");
    await broadcasts.setPaused(ACCOUNT_B, a.id, "2026-01-01T00:00:00.000Z", "hijacked");
    await broadcasts.recordAudience(ACCOUNT_B, a.id, 999, 999);
    await broadcasts.incrementCounts(ACCOUNT_B, a.id, { sent: 999, failed: 999 });

    const untouched = await broadcasts.getById(ACCOUNT_A, a.id);
    expect(untouched?.status).toBe("draft");
    expect(untouched?.pausedAt).toBeNull();
    expect(untouched?.totalRecipients).toBe(0);
    expect(untouched?.sentCount).toBe(0);
    expect(untouched?.failedCount).toBe(0);
  });
});

describe("SqlBroadcastRecipientRepository", () => {
  it("creates a broadcast with recipients and lists them back", async () => {
    const b = await makeBroadcast();
    const contactIds = [ContactId(crypto.randomUUID()), ContactId(crypto.randomUUID()), ContactId(crypto.randomUUID())];
    await recipients.createMany(contactIds.map((contactId) => ({ accountId: ACCOUNT_A, broadcastId: b.id, contactId })));

    const page = await recipients.listByBroadcast(ACCOUNT_A, b.id, null, 50);
    expect(page.items).toHaveLength(3);
    expect(page.items.every((r) => r.status === "pending")).toBe(true);
    expect(new Set(page.items.map((r) => r.contactId))).toEqual(new Set(contactIds));
  });

  it("batch-inserts many recipients across multiple chunks, and paginates them all back", async () => {
    const b = await makeBroadcast();
    const COUNT = 250; // several times the internal chunk size, forces >1 chunk
    const contactIds = Array.from({ length: COUNT }, () => ContactId(crypto.randomUUID()));
    await recipients.createMany(contactIds.map((contactId) => ({ accountId: ACCOUNT_A, broadcastId: b.id, contactId })));

    let cursor: string | null = null;
    let total = 0;
    const seen = new Set<string>();
    do {
      const page = await recipients.listByBroadcast(ACCOUNT_A, b.id, cursor, 40);
      total += page.items.length;
      for (const r of page.items) seen.add(r.id);
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(total).toBe(COUNT);
    expect(seen.size).toBe(COUNT);
  });

  it("createMany is idempotent — re-enqueuing overlapping contacts does not duplicate or throw", async () => {
    const b = await makeBroadcast();
    const contactIds = Array.from({ length: 15 }, () => ContactId(crypto.randomUUID()));
    await recipients.createMany(contactIds.map((contactId) => ({ accountId: ACCOUNT_A, broadcastId: b.id, contactId })));

    // A second, overlapping call (simulating a retried/duplicated startBroadcast)
    // must not throw the unique (broadcast_id, contact_id) constraint and must
    // not create duplicate rows.
    await expect(
      recipients.createMany(contactIds.map((contactId) => ({ accountId: ACCOUNT_A, broadcastId: b.id, contactId }))),
    ).resolves.toBeUndefined();

    const page = await recipients.listByBroadcast(ACCOUNT_A, b.id, null, 100);
    expect(page.items).toHaveLength(15);
  });

  it("round-trips error_code, error_message and disposition together", async () => {
    const b = await makeBroadcast();
    const contactId = ContactId(crypto.randomUUID());
    await recipients.createMany([{ accountId: ACCOUNT_A, broadcastId: b.id, contactId }]);
    const [created] = (await recipients.listByBroadcast(ACCOUNT_A, b.id, null, 10)).items;
    expect(created).toBeDefined();

    await recipients.applyOutcome(ACCOUNT_A, created!.id, {
      ...BASE_OUTCOME,
      status: "failed",
      errorCode: "131026",
      errorMessage: "This number can't receive WhatsApp messages.",
      disposition: "PERMANENT_NUMBER",
      attemptCount: 1,
    });

    const after = await recipients.getById(ACCOUNT_A, created!.id);
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("131026");
    expect(after?.errorMessage).toBe("This number can't receive WhatsApp messages.");
    expect(after?.disposition).toBe("PERMANENT_NUMBER");
  });

  it("retry selection (listDueForSend) EXCLUDES PERMANENT_NUMBER and INCLUDES TRANSIENT", async () => {
    const b = await makeBroadcast();
    const transientContact = ContactId(crypto.randomUUID());
    const permanentContact = ContactId(crypto.randomUUID());
    await recipients.createMany([
      { accountId: ACCOUNT_A, broadcastId: b.id, contactId: transientContact },
      { accountId: ACCOUNT_A, broadcastId: b.id, contactId: permanentContact },
    ]);
    const items = (await recipients.listByBroadcast(ACCOUNT_A, b.id, null, 10)).items;
    const transientRow = items.find((r) => r.contactId === transientContact)!;
    const permanentRow = items.find((r) => r.contactId === permanentContact)!;

    const past = "2020-01-01T00:00:00.000Z";
    const now = "2026-09-18T00:00:00.000Z";

    // Legitimate retry: still pending (per recipient-outcome.ts's status
    // modeling), due, disposition TRANSIENT.
    await recipients.applyOutcome(ACCOUNT_A, transientRow.id, {
      status: "pending",
      errorCode: "NETWORK",
      errorMessage: "Temporary network error.",
      disposition: "TRANSIENT",
      attemptCount: 1,
      nextAttemptAt: past,
    });

    // Defensive scenario: a recipient that (via some other bug) is still
    // `pending` and due, but carries a PERMANENT_NUMBER disposition — this
    // must never be selected, no matter how it got into this state.
    await recipients.applyOutcome(ACCOUNT_A, permanentRow.id, {
      status: "pending",
      errorCode: "131026",
      errorMessage: "This number can't receive WhatsApp messages.",
      disposition: "PERMANENT_NUMBER",
      attemptCount: 1,
      nextAttemptAt: past,
    });

    const due = await recipients.listDueForSend(ACCOUNT_A, b.id, now, 10);
    expect(due.map((r) => r.contactId)).toContain(transientContact);
    expect(due.map((r) => r.contactId)).not.toContain(permanentContact);
  });

  it("queue drain (listDueForSend) orders oldest-created first and respects the limit", async () => {
    const b = await makeBroadcast();
    const contactIds = [ContactId(crypto.randomUUID()), ContactId(crypto.randomUUID()), ContactId(crypto.randomUUID())];
    await recipients.createMany(contactIds.map((contactId) => ({ accountId: ACCOUNT_A, broadcastId: b.id, contactId })));
    const items = (await recipients.listByBroadcast(ACCOUNT_A, b.id, null, 10)).items;

    // Force distinct created_at values directly (createMany stamps one `now`
    // for the whole fan-out, which is correct for production but useless for
    // testing ordering) so FIFO order is unambiguous.
    const timestamps = ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"];
    for (const [i, row] of items.entries()) {
      await db.query(`update broadcast_recipients set created_at = $1 where account_id = $2 and id = $3`, [
        timestamps[i],
        ACCOUNT_A,
        row.id,
      ]);
    }

    const due = await recipients.listDueForSend(ACCOUNT_A, b.id, "2026-06-01T00:00:00.000Z", 2);
    expect(due).toHaveLength(2);
    expect(due[0]?.contactId).toBe(items[0]!.contactId);
    expect(due[1]?.contactId).toBe(items[1]!.contactId);
  });

  it("listDueForSend uses the (account_id, broadcast_id, status, next_attempt_at) index, not a table scan", async () => {
    const b = await makeBroadcast();
    const { rows } = await db.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       select id from broadcast_recipients
        where account_id = $1 and broadcast_id = $2 and status = 'pending'
          and (next_attempt_at is null or next_attempt_at <= $3)
          and (disposition is null or disposition <> 'PERMANENT_NUMBER')
        order by created_at asc, id asc
        limit $4`,
      [ACCOUNT_A, b.id, "2026-01-01T00:00:00.000Z", 10],
    );
    const plan = rows.map((r) => r.detail).join("\n");
    expect(plan).toContain("idx_broadcast_recipients_queue");
    expect(plan).not.toMatch(/SCAN broadcast_recipients(?! USING)/);
  });

  it("paginates listByBroadcast and listFailed with a keyset cursor", async () => {
    const b = await makeBroadcast();
    const contactIds = Array.from({ length: 5 }, () => ContactId(crypto.randomUUID()));
    await recipients.createMany(contactIds.map((contactId) => ({ accountId: ACCOUNT_A, broadcastId: b.id, contactId })));
    const created = (await recipients.listByBroadcast(ACCOUNT_A, b.id, null, 50)).items;

    for (const row of created) {
      await recipients.applyOutcome(ACCOUNT_A, row.id, {
        ...BASE_OUTCOME,
        status: "failed",
        errorCode: "UNKNOWN",
        errorMessage: "Something went wrong.",
      });
    }

    const page1 = await recipients.listFailed(ACCOUNT_A, b.id, null, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await recipients.listFailed(ACCOUNT_A, b.id, page1.nextCursor, 2);
    expect(page2.items).toHaveLength(2);
    const page3 = await recipients.listFailed(ACCOUNT_A, b.id, page2.nextCursor, 2);
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  it("listRecentSentAt returns only sent_at timestamps at/after the given time", async () => {
    const b = await makeBroadcast();
    const contactIds = [ContactId(crypto.randomUUID()), ContactId(crypto.randomUUID())];
    await recipients.createMany(contactIds.map((contactId) => ({ accountId: ACCOUNT_A, broadcastId: b.id, contactId })));
    const [r1, r2] = (await recipients.listByBroadcast(ACCOUNT_A, b.id, null, 10)).items;

    await recipients.applyOutcome(ACCOUNT_A, r1!.id, {
      ...BASE_OUTCOME,
      status: "sent",
      sentAt: "2020-01-01T00:00:00.000Z",
    });
    await recipients.applyOutcome(ACCOUNT_A, r2!.id, {
      ...BASE_OUTCOME,
      status: "sent",
      sentAt: "2026-06-01T00:00:00.000Z",
    });

    const recent = await recipients.listRecentSentAt(ACCOUNT_A, b.id, "2025-01-01T00:00:00.000Z");
    expect(recent).toEqual(["2026-06-01T00:00:00.000Z"]);
  });

  it("TENANT ISOLATION — account B cannot read account A's recipients, and a cross-tenant applyOutcome is a no-op", async () => {
    const b = await makeBroadcast(ACCOUNT_A);
    const contactId = ContactId(crypto.randomUUID());
    await recipients.createMany([{ accountId: ACCOUNT_A, broadcastId: b.id, contactId }]);
    const [row] = (await recipients.listByBroadcast(ACCOUNT_A, b.id, null, 10)).items;
    expect(row).toBeDefined();

    expect(await recipients.getById(ACCOUNT_B, row!.id)).toBeNull();
    expect((await recipients.listByBroadcast(ACCOUNT_B, b.id, null, 10)).items).toHaveLength(0);
    expect((await recipients.listFailed(ACCOUNT_B, b.id, null, 10)).items).toHaveLength(0);
    expect(await recipients.listDueForSend(ACCOUNT_B, b.id, "2026-01-01T00:00:00.000Z", 10)).toHaveLength(0);

    // Cross-tenant applyOutcome must be a no-op, not a silent cross-tenant write.
    await recipients.applyOutcome(ACCOUNT_B, row!.id, {
      ...BASE_OUTCOME,
      status: "failed",
      errorCode: "HIJACKED",
      errorMessage: "hijacked",
      disposition: "PERMANENT_NUMBER",
    });
    const untouched = await recipients.getById(ACCOUNT_A, row!.id);
    expect(untouched?.status).toBe("pending");
    expect(untouched?.errorCode).toBeNull();
    expect(untouched?.disposition).toBeNull();
  });
});

describe("search() — the page/pageSize + total read backing GET /api/broadcasts", () => {
  it("filters by status and by name (search), case-insensitively", async () => {
    const draft = await makeBroadcast();
    const sending = await broadcasts.create({
      accountId: ACCOUNT_A,
      name: "New Year blast",
      templateId: TEMPLATE,
      createdBy: CREATED_BY,
      scheduledAt: null,
    });
    await broadcasts.updateStatus(ACCOUNT_A, sending.id, "sending");

    const draftsOnly = await broadcasts.search(ACCOUNT_A, { status: "draft" }, { page: 1, pageSize: 10 });
    expect(draftsOnly.items.map((b) => b.id)).toEqual([draft.id]);
    expect(draftsOnly.total).toBe(1);

    const byName = await broadcasts.search(ACCOUNT_A, { search: "diwali" }, { page: 1, pageSize: 10 });
    expect(byName.items.map((b) => b.id)).toEqual([draft.id]);
    expect(byName.total).toBe(1);
  });

  it("paginates page/pageSize with a real total, and every row appears exactly once across pages", async () => {
    const created = [];
    for (let i = 0; i < 25; i++) {
      const b = await broadcasts.create({
        accountId: ACCOUNT_A,
        name: `Broadcast ${i}`,
        templateId: TEMPLATE,
        createdBy: CREATED_BY,
        scheduledAt: null,
      });
      // Give each row a distinct created_at so page ordering is deterministic
      // (rows created in the same test tick can otherwise share a timestamp
      // and tie-break on a random uuid).
      await db.query(`update broadcasts set created_at = $1 where account_id = $2 and id = $3`, [
        `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        ACCOUNT_A,
        b.id,
      ]);
      created.push(b);
    }

    const page1 = await broadcasts.search(ACCOUNT_A, {}, { page: 1, pageSize: 10 });
    expect(page1.items).toHaveLength(10);
    expect(page1.total).toBe(25);
    expect(page1.items[0]?.name).toBe("Broadcast 24");

    const page2 = await broadcasts.search(ACCOUNT_A, {}, { page: 2, pageSize: 10 });
    expect(page2.items).toHaveLength(10);

    const page3 = await broadcasts.search(ACCOUNT_A, {}, { page: 3, pageSize: 10 });
    expect(page3.items).toHaveLength(5);
    expect(page3.total).toBe(25);

    const seen = [...page1.items, ...page2.items, ...page3.items].map((b) => b.id);
    expect(new Set(seen).size).toBe(25);
  });

  it("TENANT ISOLATION — account B's search never sees account A's broadcasts", async () => {
    await makeBroadcast(ACCOUNT_A);

    const result = await broadcasts.search(ACCOUNT_B, {}, { page: 1, pageSize: 10 });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("search() — D1 rows-read cost (the bug this task fixes)", () => {
  it("listing page 1 of 20 over 400 broadcasts reads a bounded number of rows, not the whole table", async () => {
    for (let i = 0; i < 400; i++) {
      await broadcasts.create({
        accountId: ACCOUNT_A,
        name: `Broadcast ${i}`,
        templateId: TEMPLATE,
        createdBy: CREATED_BY,
        scheduledAt: null,
      });
    }

    const counting = new RowCountingDatabaseProvider(db);
    const costRepo = new SqlBroadcastRepository(counting);

    const page = await costRepo.search(ACCOUNT_A, {}, { page: 1, pageSize: 20 });

    expect(page.items).toHaveLength(20);
    expect(page.total).toBe(400);
    // One COUNT(*) row + 20 page rows = 21. The pre-fix route walked the
    // ENTIRE cursor-paginated `listForAccount` result (400+ rows) to compute
    // this same page; this assertion is what fails against that code path
    // and passes against the direct SQL COUNT(*)/LIMIT/OFFSET read.
    expect(counting.totalRowsReturned).toBeLessThan(60);
  });
});
