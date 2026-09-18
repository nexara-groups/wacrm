import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { createAuditEntry } from "../domain/audit";
import { SqlPlatformAuditLogRepository } from "./audit-log-repository";

let db: SqlJsDatabaseProvider;
let repo: SqlPlatformAuditLogRepository;

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repo = new SqlPlatformAuditLogRepository(db);
});

describe("SqlPlatformAuditLogRepository — real schema (0004_platform_admin.sql)", () => {
  it("append persists every field, round-tripped exactly", async () => {
    const entry = createAuditEntry({
      id: "audit-1",
      actor: "staff-1",
      platformRole: "platform_support",
      action: "cross_account:read_reports",
      targetAccountId: "tenant-1",
      targetResource: "fleet_overview",
      reason: "routine oversight",
      ip: "203.0.113.7",
      userAgent: "test-agent/1.0",
      requestId: "req-1",
      occurredAt: new Date("2026-09-17T00:00:00.000Z"),
    });

    await repo.append(entry);

    const all = await repo.listAll();
    expect(all).toEqual([entry]);
  });

  it("append is the only write member — the append-only invariant holds against the real table (no update/delete code path exists)", async () => {
    const entry = createAuditEntry({
      id: "audit-2",
      actor: "staff-1",
      platformRole: "platform_admin",
      action: "tenant:suspend",
      requestId: "req-2",
      occurredAt: new Date("2026-09-17T01:00:00.000Z"),
    });
    await repo.append(entry);
    // There is no repo.update/.delete to call — this is a structural
    // assertion the compiler enforces (see domain/audit.test.ts); here we
    // just confirm two appends accumulate rather than overwrite.
    const entry2 = createAuditEntry({
      id: "audit-3",
      actor: "staff-1",
      platformRole: "platform_admin",
      action: "tenant:suspend",
      requestId: "req-3",
      occurredAt: new Date("2026-09-17T02:00:00.000Z"),
    });
    await repo.append(entry2);
    expect(await repo.listAll()).toHaveLength(2);
  });

  it("listForAccount filters to one target account, across unrelated entries", async () => {
    await repo.append(
      createAuditEntry({
        id: "a1",
        actor: "staff-1",
        platformRole: "platform_support",
        action: "cross_account:read_metadata",
        targetAccountId: "acct-a",
        requestId: "r1",
        occurredAt: new Date("2026-09-17T00:00:00.000Z"),
      }),
    );
    await repo.append(
      createAuditEntry({
        id: "a2",
        actor: "staff-1",
        platformRole: "platform_support",
        action: "cross_account:read_metadata",
        targetAccountId: "acct-b",
        requestId: "r2",
        occurredAt: new Date("2026-09-17T00:01:00.000Z"),
      }),
    );
    await repo.append(
      createAuditEntry({
        id: "a3",
        actor: "staff-1",
        platformRole: "platform_support",
        action: "platform_role:grant",
        targetAccountId: null,
        requestId: "r3",
        occurredAt: new Date("2026-09-17T00:02:00.000Z"),
      }),
    );

    const forA = await repo.listForAccount("acct-a");
    expect(forA.map((e) => e.id)).toEqual(["a1"]);
  });
});
