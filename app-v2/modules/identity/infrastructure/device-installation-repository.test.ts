import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlDeviceInstallationRepository } from "./device-installation-repository";
import { SqlUserRepository } from "./user-repository";
import type { TenantId, UserId } from "@shared/types";

let db: SqlJsDatabaseProvider;
let repo: SqlDeviceInstallationRepository;
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
  repo = new SqlDeviceInstallationRepository(db);
  users = new SqlUserRepository(db);
});

describe("SqlDeviceInstallationRepository", () => {
  it("creates a new installation on first upsert", async () => {
    const userId = await seedUser("acct-a", "a@x.test");
    const created = await repo.upsert({
      userId,
      accountId: "acct-a" as TenantId,
      platform: "ios",
      pushToken: "push-1",
      deviceId: "device-1",
      appVersion: "1.0.0",
      enabled: true,
    });
    expect(created.platform).toBe("ios");
    expect(created.enabled).toBe(true);
    expect(created.lastSeenAt).toEqual(expect.any(String));
  });

  it("upserting the same (user, device) again updates the same row rather than creating a new one", async () => {
    const userId = await seedUser("acct-a", "a@x.test");
    const first = await repo.upsert({
      userId, accountId: "acct-a" as TenantId, platform: "ios", pushToken: "push-1",
      deviceId: "device-1", appVersion: "1.0.0", enabled: true,
    });
    const second = await repo.upsert({
      userId, accountId: "acct-a" as TenantId, platform: "ios", pushToken: "push-2",
      deviceId: "device-1", appVersion: "1.1.0", enabled: true,
    });
    expect(second.id).toBe(first.id);
    expect(second.pushToken).toBe("push-2");
    expect(second.appVersion).toBe("1.1.0");

    const all = await repo.listForUser(userId);
    expect(all).toHaveLength(1);
  });

  it("setEnabled and touch update in place", async () => {
    const userId = await seedUser("acct-a", "a@x.test");
    const created = await repo.upsert({
      userId, accountId: "acct-a" as TenantId, platform: "android", pushToken: null,
      deviceId: "device-1", appVersion: null, enabled: true,
    });
    await repo.setEnabled(created.id, false);
    await repo.touch(created.id, "2026-09-18T00:00:00.000Z");

    const [reread] = await repo.listForUser(userId);
    expect(reread?.enabled).toBe(false);
    expect(reread?.lastSeenAt).toBe("2026-09-18T00:00:00.000Z");
  });

  it("TENANT ISOLATION — listForUser never crosses accounts", async () => {
    const userA = await seedUser("acct-a", "a@x.test");
    const userB = await seedUser("acct-b", "b@x.test");
    await repo.upsert({
      userId: userA, accountId: "acct-a" as TenantId, platform: "ios", pushToken: null,
      deviceId: "device-1", appVersion: null, enabled: true,
    });
    await repo.upsert({
      userId: userB, accountId: "acct-b" as TenantId, platform: "ios", pushToken: null,
      deviceId: "device-1", appVersion: null, enabled: true,
    });

    expect(await repo.listForUser(userA)).toHaveLength(1);
    expect(await repo.listForUser(userB)).toHaveLength(1);

    const { rows } = await db.query<{ account_id: string }>(
      "select account_id from device_installations where account_id in ($1, $2) order by account_id",
      ["acct-a", "acct-b"],
    );
    expect(rows.map((r) => r.account_id)).toEqual(["acct-a", "acct-b"]);
  });
});
