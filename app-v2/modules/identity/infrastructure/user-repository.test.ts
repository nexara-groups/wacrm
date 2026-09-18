import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { NO_PASSWORD_COLUMN, SqlUserRepository } from "./user-repository";
import type { TenantId, UserId } from "@shared/types";

let db: SqlJsDatabaseProvider;
let repo: SqlUserRepository;

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repo = new SqlUserRepository(db);
});

describe("SqlUserRepository", () => {
  it("creates and reads back a user by id and by email", async () => {
    const created = await repo.create({
      accountId: "acct-a" as TenantId,
      email: "asha@x.test",
      passwordHash: "irrelevant-see-schema-gap",
      role: "owner",
      emailVerifiedAt: null,
    });
    expect(created.email).toBe("asha@x.test");
    expect(created.role).toBe("owner");
    expect(created.emailVerifiedAt).toBeNull();

    const byId = await repo.findById(created.id);
    expect(byId?.email).toBe("asha@x.test");

    const byEmail = await repo.findByEmail("acct-a" as TenantId, "asha@x.test");
    expect(byEmail?.id).toBe(created.id);
  });

  it("SCHEMA GAP — passwordHash never round-trips (users has no password column)", async () => {
    const created = await repo.create({
      accountId: "acct-a" as TenantId,
      email: "gap@x.test",
      passwordHash: "s3cr3t-should-never-be-stored-or-returned",
      role: "member",
      emailVerifiedAt: null,
    });
    // The repository must not echo back, nor silently persist, the input's
    // passwordHash — see user-repository.ts's file header.
    expect(created.passwordHash).toBe(NO_PASSWORD_COLUMN);
    const reread = await repo.findById(created.id);
    expect(reread?.passwordHash).toBe(NO_PASSWORD_COLUMN);

    // Confirm directly against the row: the raw value passed to `create`
    // must not appear anywhere in the `users` table.
    const { rows } = await db.query<Record<string, unknown>>(
      "select * from users where tenant_id = $1 and user_id = $2",
      ["acct-a", created.id],
    );
    const values = Object.values(rows[0] ?? {}).map(String);
    expect(values).not.toContain("s3cr3t-should-never-be-stored-or-returned");

    // updatePasswordHash is a documented no-op — resolves without throwing.
    await expect(repo.updatePasswordHash(created.id, "another-secret")).resolves.toBeUndefined();
  });

  it("marks email verified", async () => {
    const created = await repo.create({
      accountId: "acct-a" as TenantId,
      email: "verify@x.test",
      passwordHash: "x",
      role: "member",
      emailVerifiedAt: null,
    });
    await repo.markEmailVerified(created.id, "2026-09-17T00:00:00.000Z");
    const reread = await repo.findById(created.id);
    expect(reread?.emailVerifiedAt).toBe("2026-09-17T00:00:00.000Z");
  });

  it("TENANT ISOLATION — findByEmail is scoped per account, both directions", async () => {
    await repo.create({
      accountId: "acct-a" as TenantId,
      email: "shared@x.test",
      passwordHash: "x",
      role: "member",
      emailVerifiedAt: null,
    });
    const b = await repo.create({
      accountId: "acct-b" as TenantId,
      email: "shared@x.test",
      passwordHash: "x",
      role: "member",
      emailVerifiedAt: null,
    });

    const foundInA = await repo.findByEmail("acct-a" as TenantId, "shared@x.test");
    const foundInB = await repo.findByEmail("acct-b" as TenantId, "shared@x.test");
    expect(foundInA?.accountId).toBe("acct-a");
    expect(foundInB?.accountId).toBe("acct-b");
    expect(foundInA?.id).not.toBe(foundInB?.id);
    expect(foundInB?.id).toBe(b.id);

    // Neither tenant's user is visible under a third, unrelated tenant.
    expect(await repo.findByEmail("acct-c" as TenantId, "shared@x.test")).toBeNull();
  });

  it("returns null for an unknown id or email", async () => {
    expect(await repo.findById("nope" as UserId)).toBeNull();
    expect(await repo.findByEmail("acct-a" as TenantId, "nope@x.test")).toBeNull();
  });
});
