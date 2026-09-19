/**
 * Coverage for the retention-sweep orchestration against REAL repositories
 * (sql.js, migrated schema) — no mocks. Exercises the four things the cron
 * task calls out as mattering more than the loop: the write budget, per
 * account failure isolation, keyset account paging, and backlog reporting.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { buildModuleRepositories, type ModuleRepositories } from "@modules/container";
import type { ConversationId, ContactId, MessageId } from "@packages/domain";
import type { NewMessageInput } from "@modules/conversations/application/ports";
import type { TenantContext } from "@nexara/core/context";
import { runRetentionSweep } from "./retention-sweep";

let db: SqlJsDatabaseProvider;
let repositories: ModuleRepositories;

const NOW = new Date("2026-09-19T00:00:00.000Z");
const OLD = "2020-01-01T00:00:00.000Z"; // far past the 60-day default retention
const RECENT = "2026-09-18T00:00:00.000Z"; // within the 60-day window
const MID = "2026-09-05T00:00:00.000Z"; // 14 days old: kept under 60-day default, expired under a 5-day override

async function seedAccount(accountId: string): Promise<void> {
  await db.query(
    `-- tenant-scope-exempt: creates the tenant root row itself; accounts.id IS the tenant id
     insert into accounts (id, name, owner_user_id, created_at, updated_at)
     values ($1, $1, $2, 't0', 't0')`,
    [accountId, `owner-${accountId}`],
  );
}

async function seedMessage(accountId: string, id: string, occurredAt: string): Promise<void> {
  const tenant: TenantContext = { tenantId: accountId };
  const conversationId = `conv-${accountId}` as unknown as ConversationId;
  const existing = await repositories.conversations.findById(tenant, conversationId);
  if (existing === null) {
    await repositories.conversations.create(tenant, {
      id: conversationId,
      contactId: `c-${accountId}` as unknown as ContactId,
      now: occurredAt,
    });
  }
  const input: NewMessageInput = {
    id: id as unknown as MessageId,
    conversationId,
    contactId: `c-${accountId}` as unknown as ContactId,
    direction: "inbound",
    type: "text",
    body: "hi",
    templateId: null,
    waMessageId: null,
    replyToId: null,
    mediaRef: null,
    status: "delivered",
    occurredAt,
  };
  await repositories.messages.insert(tenant, input);
}

async function countMessages(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*) as n from messages where account_id = $1`,
    [accountId],
  );
  return Number(rows[0]?.n ?? 0);
}

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repositories = buildModuleRepositories(db);
});

describe("runRetentionSweep", () => {
  it("does nothing and reports cleanly when there are no accounts at all", async () => {
    const report = await runRetentionSweep(repositories, NOW);
    expect(report).toEqual({
      accountsSeen: 0,
      failures: [],
      totalDeleted: 0,
      budgetExhausted: false,
      accountsWithBacklogRemaining: [],
    });
  });

  it("deletes expired messages and keeps recent ones, across more than one account", async () => {
    await seedAccount("acct-a");
    await seedAccount("acct-b");
    await seedMessage("acct-a", "a-old-1", OLD);
    await seedMessage("acct-a", "a-old-2", OLD);
    await seedMessage("acct-a", "a-recent", RECENT);
    await seedMessage("acct-b", "b-old", OLD);
    await seedMessage("acct-b", "b-recent", RECENT);

    const report = await runRetentionSweep(repositories, NOW);

    expect(report.failures).toEqual([]);
    expect(report.budgetExhausted).toBe(false);
    expect(report.accountsWithBacklogRemaining).toEqual([]);
    expect(report.accountsSeen).toBe(2);
    expect(report.totalDeleted).toBe(3);
    expect(await countMessages("acct-a")).toBe(1);
    expect(await countMessages("acct-b")).toBe(1);
  });

  it("respects an account's own retention override instead of the platform default", async () => {
    await seedAccount("acct-a");
    await seedMessage("acct-a", "a-old", OLD);
    await seedMessage("acct-a", "a-mid", MID);
    await seedMessage("acct-a", "a-recent", RECENT);

    // Under the 60-day platform default, only OLD is expired.
    const withDefault = await runRetentionSweep(repositories, NOW);
    expect(withDefault.totalDeleted).toBe(1);
    expect(await countMessages("acct-a")).toBe(2);

    // A 5-day override now also expires MID (14 days old), but never RECENT.
    await db.query(`update accounts set message_retention_days_override = 5 where id = $1`, ["acct-a"]);
    const withOverride = await runRetentionSweep(repositories, NOW);
    expect(withOverride.totalDeleted).toBe(1);
    expect(await countMessages("acct-a")).toBe(1);
  });

  it("caps total deletes at the write budget and reports the run as budget-exhausted", async () => {
    await seedAccount("acct-a");
    for (let i = 0; i < 5; i++) {
      await seedMessage("acct-a", `a-old-${i}`, OLD);
    }

    const report = await runRetentionSweep(repositories, NOW, { writeBudget: 3 });

    expect(report.totalDeleted).toBe(3);
    expect(report.budgetExhausted).toBe(true);
    expect(report.accountsWithBacklogRemaining).toEqual(["acct-a"]);
    expect(await countMessages("acct-a")).toBe(2);
  });

  it("never asks a single account to consume more than the remaining budget", async () => {
    await seedAccount("acct-a");
    await seedAccount("acct-b");
    for (let i = 0; i < 4; i++) {
      await seedMessage("acct-a", `a-old-${i}`, OLD);
      await seedMessage("acct-b", `b-old-${i}`, OLD);
    }

    // Budget covers all of acct-a (4) plus 2 of acct-b's 4 — acct-b must be
    // left with backlog, and the run must stop there rather than overshoot.
    const report = await runRetentionSweep(repositories, NOW, {
      writeBudget: 6,
      accountPageSize: 10,
    });

    expect(report.totalDeleted).toBe(6);
    expect(report.budgetExhausted).toBe(true);
    expect(await countMessages("acct-a")).toBe(0);
    expect(await countMessages("acct-b")).toBe(2);
  });

  it("isolates one account's failure so every other account is still swept", async () => {
    // A malformed account id (blank) is a real failure mode `createTenantContext`
    // itself guards against (AppError.validation) — used here rather than a
    // mock so the isolation this test proves is against a genuine error path,
    // not a stand-in for one.
    await seedAccount("");
    await seedAccount("acct-a");
    await seedAccount("acct-c");
    await seedMessage("acct-a", "a-old", OLD);
    await seedMessage("acct-c", "c-old", OLD);

    const report = await runRetentionSweep(repositories, NOW);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.accountId).toBe("");
    expect(report.accountsSeen).toBe(3);
    expect(await countMessages("acct-a")).toBe(0);
    expect(await countMessages("acct-c")).toBe(0);
  });

  it("pages through more accounts than fit in one account-directory page", async () => {
    for (const id of ["acct-a", "acct-b", "acct-c", "acct-d", "acct-e"]) {
      await seedAccount(id);
      await seedMessage(id, `${id}-old`, OLD);
    }

    const report = await runRetentionSweep(repositories, NOW, { accountPageSize: 2 });

    expect(report.accountsSeen).toBe(5);
    expect(report.totalDeleted).toBe(5);
    for (const id of ["acct-a", "acct-b", "acct-c", "acct-d", "acct-e"]) {
      expect(await countMessages(id)).toBe(0);
    }
  });
});
