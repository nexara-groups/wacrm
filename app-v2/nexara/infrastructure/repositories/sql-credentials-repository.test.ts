import { describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlCredentialsRepository } from "./sql-credentials-repository";

/**
 * These tests exist because the credentials tables were absent from this
 * repo's migration stream entirely: the repository, the container wiring and
 * the auth provider all existed, and every query targeted a table that was
 * never created. Nobody could have logged in, and nothing failed until
 * runtime. Running this repository against the real migrated schema is the
 * only thing that catches that class of gap.
 */
const TENANT = { tenantId: "acct-a" as never };
const OTHER = { tenantId: "acct-b" as never };

async function freshRepo() {
  const db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  return { db, repo: new SqlCredentialsRepository(db) };
}

describe("SqlCredentialsRepository against the real migrated schema", () => {
  it("creates a credential and finds it by email", async () => {
    const { db, repo } = await freshRepo();
    await repo.create(TENANT, {
      userId: "u1",
      email: "asha@example.test",
      passwordHash: "hash-1",
      role: "owner",
      verifiedAt: null,
    } as never);
    const found = await repo.findByEmail(TENANT, "asha@example.test");
    expect(found).not.toBeNull();
    expect(found?.passwordHash).toBe("hash-1");
    expect(found?.role).toBe("owner");
    await db.dispose();
  });

  it("finds by user id", async () => {
    const { db, repo } = await freshRepo();
    await repo.create(TENANT, {
      userId: "u1", email: "a@x.test", passwordHash: "h", role: "member", verifiedAt: null,
    } as never);
    expect(await repo.findByUserId(TENANT, "u1" as never)).not.toBeNull();
    await db.dispose();
  });

  it("TENANT ISOLATION — another tenant cannot read the credential", async () => {
    const { db, repo } = await freshRepo();
    await repo.create(TENANT, {
      userId: "u1", email: "a@x.test", passwordHash: "h", role: "member", verifiedAt: null,
    } as never);
    expect(await repo.findByEmail(OTHER, "a@x.test")).toBeNull();
    expect(await repo.findByUserId(OTHER, "u1" as never)).toBeNull();
    await db.dispose();
  });

  it("an email identifies exactly ONE credential system-wide — a second tenant cannot reuse it", async () => {
    // This test previously asserted the OPPOSITE: that the same address could
    // exist in two tenants. That property is what made multi-tenant login
    // impossible — someone types an email and a password, and nothing in the
    // request says which tenant they meant, so the old code hard-wired one
    // tenant per deployment.
    //
    // Global uniqueness is not a new restriction. 0002_organizations.sql
    // already locks "one account per user" with a UNIQUE index on
    // memberships(user_id); this states the same rule where login can act on
    // it. See 0013_global_email_uniqueness.sql.
    const { db, repo } = await freshRepo();
    await repo.create(TENANT, {
      userId: "u1", email: "shared@x.test", passwordHash: "h1", role: "owner", verifiedAt: null,
    } as never);

    await expect(
      repo.create(OTHER, {
        userId: "u2", email: "shared@x.test", passwordHash: "h2", role: "owner", verifiedAt: null,
      } as never),
    ).rejects.toThrow();

    // The original credential is untouched by the failed attempt.
    expect((await repo.findByEmail(TENANT, "shared@x.test"))?.passwordHash).toBe("h1");
    await db.dispose();
  });

  it("findByEmailAnyTenant resolves the owning tenant, which is what login needs", async () => {
    // Login's first problem is "who is this?", and the answer includes which
    // tenant. Every other repository method takes the tenant as an input;
    // this one produces it.
    const { db, repo } = await freshRepo();
    await repo.create(OTHER, {
      userId: "u9", email: "finder@x.test", passwordHash: "h9", role: "admin", verifiedAt: null,
    } as never);

    const found = await repo.findByEmailAnyTenant("finder@x.test");
    expect(found?.tenantId).toBe(OTHER.tenantId);
    expect(found?.userId).toBe("u9");
    expect(await repo.findByEmailAnyTenant("nobody@x.test")).toBeNull();
    await db.dispose();
  });

  it("bumping the session version invalidates issued tokens", async () => {
    const { db, repo } = await freshRepo();
    await repo.create(TENANT, {
      userId: "u1", email: "a@x.test", passwordHash: "h", role: "member", verifiedAt: null,
    } as never);
    const before = await repo.findByUserId(TENANT, "u1" as never);
    await repo.revokeSessions(TENANT, "u1" as never);
    const after = await repo.findByUserId(TENANT, "u1" as never);
    expect(after!.sessionVersion).toBeGreaterThan(before!.sessionVersion);
    await db.dispose();
  });
});
