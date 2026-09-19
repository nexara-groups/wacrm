import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlAccountDirectoryRepository } from "./account-directory-repository";

let db: SqlJsDatabaseProvider;
let repo: SqlAccountDirectoryRepository;

/** Mirrors seat-repository.test.ts's seedAccount pattern. */
async function seedAccount(accountId: string): Promise<void> {
  const ownerUserId = `u-${accountId}`;
  await db.query(
    `insert into users (user_id, tenant_id, email, role, created_at, updated_at)
     values ($1, $2, $3, 'owner', 't', 't')`,
    [ownerUserId, accountId, `owner@${accountId}.test`],
  );
  await db.query(
    `-- tenant-scope-exempt: accounts IS the tenant root; its tenant column is id
     insert into accounts (id, name, owner_user_id, created_at, updated_at)
     values ($1, $1, $2, 't', 't')`,
    [accountId, ownerUserId],
  );
}

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repo = new SqlAccountDirectoryRepository(db);
});

describe("SqlAccountDirectoryRepository", () => {
  it("returns no accounts and no next cursor when the table is empty", async () => {
    const page = await repo.listAccountIds(null, 10);
    expect(page).toEqual({ accountIds: [], nextCursor: null });
  });

  it("returns every account in one page when it fits under the limit", async () => {
    await seedAccount("acct-a");
    await seedAccount("acct-b");
    await seedAccount("acct-c");

    const page = await repo.listAccountIds(null, 10);

    expect(page.accountIds).toEqual(["acct-a", "acct-b", "acct-c"]);
    expect(page.nextCursor).toBeNull();
  });

  it("pages through accounts in ascending id order, never repeating or skipping one", async () => {
    for (const id of ["acct-a", "acct-b", "acct-c", "acct-d", "acct-e"]) {
      await seedAccount(id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<ReturnType<typeof repo.listAccountIds>> = await repo.listAccountIds(cursor, 2);
      seen.push(...page.accountIds);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual(["acct-a", "acct-b", "acct-c", "acct-d", "acct-e"]);
  });

  it("reports no next cursor once the last page exactly fills the limit", async () => {
    await seedAccount("acct-a");
    await seedAccount("acct-b");

    const page = await repo.listAccountIds(null, 2);

    expect(page).toEqual({ accountIds: ["acct-a", "acct-b"], nextCursor: null });
  });

  it("floors a fractional or zero limit to a valid page size rather than erroring", async () => {
    await seedAccount("acct-a");
    await seedAccount("acct-b");

    const page = await repo.listAccountIds(null, 0.4);

    expect(page.accountIds).toEqual(["acct-a"]);
    expect(page.nextCursor).toBe("acct-a");
  });
});
