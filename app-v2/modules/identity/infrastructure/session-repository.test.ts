import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlSessionRepository } from "./session-repository";
import { SqlUserRepository } from "./user-repository";
import type { TenantId, UserId } from "@shared/types";

let db: SqlJsDatabaseProvider;
let sessions: SqlSessionRepository;
let users: SqlUserRepository;

async function seedUser(accountId: string, email: string): Promise<UserId> {
  const created = await users.create({
    accountId: accountId as TenantId,
    email,
    passwordHash: "x",
    role: "member",
    emailVerifiedAt: null,
  });
  return created.id;
}

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  sessions = new SqlSessionRepository(db);
  users = new SqlUserRepository(db);
});

describe("SqlSessionRepository", () => {
  it("creates and reads back a session, deriving account_id from the owning user", async () => {
    const userId = await seedUser("acct-a", "a@x.test");
    const session = await sessions.create({
      userId,
      deviceId: "device-1",
      createdAt: "2026-09-17T00:00:00.000Z",
      lastSeenAt: "2026-09-17T00:00:00.000Z",
      expiresAt: "2026-10-17T00:00:00.000Z",
    });
    expect(session.userId).toBe(userId);
    expect(session.revokedAt).toBeNull();

    const { rows } = await db.query<{ account_id: string }>(
      "select account_id from sessions where account_id = $1 and id = $2",
      ["acct-a", session.id],
    );
    expect(rows[0]?.account_id).toBe("acct-a");

    const reread = await sessions.findById(session.id);
    expect(reread?.deviceId).toBe("device-1");
  });

  it("rejects creating a session for an unknown user", async () => {
    await expect(
      sessions.create({
        userId: "ghost" as UserId,
        deviceId: null,
        createdAt: "t",
        lastSeenAt: "t",
        expiresAt: "t",
      }),
    ).rejects.toThrow();
  });

  it("touches and revokes a session", async () => {
    const userId = await seedUser("acct-a", "a@x.test");
    const session = await sessions.create({
      userId,
      deviceId: null,
      createdAt: "2026-09-17T00:00:00.000Z",
      lastSeenAt: "2026-09-17T00:00:00.000Z",
      expiresAt: "2026-10-17T00:00:00.000Z",
    });
    await sessions.touch(session.id, "2026-09-18T00:00:00.000Z");
    expect((await sessions.findById(session.id))?.lastSeenAt).toBe("2026-09-18T00:00:00.000Z");

    await sessions.revoke(session.id, "2026-09-19T00:00:00.000Z");
    expect((await sessions.findById(session.id))?.revokedAt).toBe("2026-09-19T00:00:00.000Z");
  });

  it("revokeAllForUser revokes every session for that user only", async () => {
    const userA = await seedUser("acct-a", "a@x.test");
    const userB = await seedUser("acct-b", "b@x.test");
    const s1 = await sessions.create({
      userId: userA, deviceId: "d1", createdAt: "t", lastSeenAt: "t", expiresAt: "t2",
    });
    const s2 = await sessions.create({
      userId: userA, deviceId: "d2", createdAt: "t", lastSeenAt: "t", expiresAt: "t2",
    });
    const other = await sessions.create({
      userId: userB, deviceId: "d1", createdAt: "t", lastSeenAt: "t", expiresAt: "t2",
    });

    await sessions.revokeAllForUser(userA, "revoked-at");
    expect((await sessions.findById(s1.id))?.revokedAt).toBe("revoked-at");
    expect((await sessions.findById(s2.id))?.revokedAt).toBe("revoked-at");
    expect((await sessions.findById(other.id))?.revokedAt).toBeNull();
  });

  it("TENANT ISOLATION — listForUser only ever returns that user's own sessions", async () => {
    const userA = await seedUser("acct-a", "a@x.test");
    const userB = await seedUser("acct-b", "b@x.test");
    await sessions.create({ userId: userA, deviceId: "d1", createdAt: "t", lastSeenAt: "t", expiresAt: "t2" });
    await sessions.create({ userId: userB, deviceId: "d1", createdAt: "t", lastSeenAt: "t", expiresAt: "t2" });

    const listA = await sessions.listForUser(userA);
    const listB = await sessions.listForUser(userB);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0]?.userId).toBe(userA);
    expect(listB[0]?.userId).toBe(userB);

    // Confirm the underlying rows really did land under separate accounts.
    const { rows } = await db.query<{ account_id: string }>(
      "select account_id from sessions where account_id in ($1, $2) order by account_id",
      ["acct-a", "acct-b"],
    );
    expect(rows.map((r) => r.account_id)).toEqual(["acct-a", "acct-b"]);
  });
});
