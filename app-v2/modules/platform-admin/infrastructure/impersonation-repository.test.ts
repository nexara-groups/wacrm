import { beforeEach, describe, expect, it } from "vitest";
import type { VerifiedPlatformPrincipal } from "@nexara/core/rbac";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlPlatformAuditLogRepository } from "./audit-log-repository";
import { SqlImpersonationRepository } from "./impersonation-repository";

const ADMIN: VerifiedPlatformPrincipal = {
  userId: "staff-admin",
  tenantId: "n/a",
  email: "admin@nexara.test",
  platformRole: "platform_admin",
};

let db: SqlJsDatabaseProvider;
let repo: SqlImpersonationRepository;
let auditLog: SqlPlatformAuditLogRepository;

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repo = new SqlImpersonationRepository(db);
  auditLog = new SqlPlatformAuditLogRepository(db);
});

describe("SqlImpersonationRepository — real schema (platform_impersonation_sessions)", () => {
  it("startImpersonation persists a session capped at exactly 60 minutes", async () => {
    const session = await repo.startImpersonation(ADMIN, "acct-x", "user-in-acct-x", "debugging a customer ticket");

    expect(session.actorUserId).toBe("staff-admin");
    expect(session.targetAccountId).toBe("acct-x");
    expect(session.targetUserId).toBe("user-in-acct-x");
    expect(session.endedAt).toBeNull();

    const startedAt = new Date(session.startedAt).getTime();
    const expiresAt = new Date(session.expiresAt).getTime();
    expect(expiresAt - startedAt).toBe(60 * 60 * 1000);
  });

  it("the 60-minute cap is unconditional — the port exposes no TTL parameter a caller could override", async () => {
    // Type-level: startImpersonation's signature takes no ttl argument at
    // all (application/ports.ts), so there is nothing to pass here that
    // could produce a longer session. Confirmed at runtime for good measure.
    const s1 = await repo.startImpersonation(ADMIN, "acct-a", "user-a", "reason a");
    const s2 = await repo.startImpersonation(ADMIN, "acct-b", "user-b", "reason b");
    for (const s of [s1, s2]) {
      expect(new Date(s.expiresAt).getTime() - new Date(s.startedAt).getTime()).toBe(60 * 60 * 1000);
    }
  });

  it("endImpersonation records ended_at/ended_reason and audits both start and end", async () => {
    const session = await repo.startImpersonation(ADMIN, "acct-y", "user-y", "start reason");
    await repo.endImpersonation(ADMIN, session.id, "done investigating");

    const entries = await auditLog.listAll();
    const startEntry = entries.find((e) => e.action === "tenant:impersonate:start" && e.targetResource === "user-y");
    const endEntry = entries.find((e) => e.action === "tenant:impersonate:end" && e.targetResource === session.id);
    expect(startEntry?.targetAccountId).toBe("acct-y");
    expect(endEntry?.targetAccountId).toBe("acct-y");
    expect(endEntry?.reason).toBe("done investigating");
  });

  it("endImpersonation on an unknown session id throws NOT_FOUND rather than silently no-op-ing", async () => {
    await expect(repo.endImpersonation(ADMIN, "no-such-session", "n/a")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
