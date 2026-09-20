import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlEmailTokenRepository } from "./email-token-repository";
import { SqlUserRepository } from "./user-repository";
import { consumeEmailToken, issueEmailToken, type EmailTokenDeps } from "../domain/email-tokens";
import { generateToken, hashToken } from "../domain/token-hashing";
import type { TenantId, UserId } from "@shared/types";

let db: SqlJsDatabaseProvider;
let repo: SqlEmailTokenRepository;
let users: SqlUserRepository;
let deps: EmailTokenDeps;
let clockNow = new Date("2026-09-17T00:00:00.000Z");

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
  repo = new SqlEmailTokenRepository(db);
  users = new SqlUserRepository(db);
  clockNow = new Date("2026-09-17T00:00:00.000Z");
  deps = { port: repo, hashToken, generateToken, now: () => clockNow };
});

describe("SqlEmailTokenRepository + domain email-token logic", () => {
  it("issues and consumes a single-use token", async () => {
    const userId = await seedUser("acct-a", "a@x.test");
    const issued = await issueEmailToken(deps, userId, "reset");

    const consumed = await consumeEmailToken(deps, issued.rawToken, "reset");
    expect(consumed.ok).toBe(true);

    // Single-use: a second attempt with the same raw token must fail.
    const second = await consumeEmailToken(deps, issued.rawToken, "reset");
    expect(second.ok).toBe(false);
  });

  it("is TTL-bounded — an expired token is rejected even though never consumed", async () => {
    const userId = await seedUser("acct-a", "a@x.test");
    const issued = await issueEmailToken(deps, userId, "verify", 1000); // 1s TTL

    clockNow = new Date(clockNow.getTime() + 2000); // advance past expiry
    const result = await consumeEmailToken(deps, issued.rawToken, "verify");
    expect(result.ok).toBe(false);
  });

  it("rejects a token consumed under the wrong type", async () => {
    const userId = await seedUser("acct-a", "a@x.test");
    const issued = await issueEmailToken(deps, userId, "invite");
    const result = await consumeEmailToken(deps, issued.rawToken, "reset");
    expect(result.ok).toBe(false);
  });

  it("no raw token value ever reaches the database — only its hash is stored", async () => {
    const userId = await seedUser("acct-a", "a@x.test");
    const issued = await issueEmailToken(deps, userId, "reset");

    const { rows } = await db.query<Record<string, unknown>>(
      "select * from email_tokens where account_id = $1 and id = $2",
      ["acct-a", issued.record.id],
    );
    expect(rows).toHaveLength(1);
    const stored = rows[0] as { token_hash: string };
    expect(stored.token_hash).not.toBe(issued.rawToken);
    expect(stored.token_hash).toBe(await hashToken(issued.rawToken));
    const values = Object.values(rows[0] ?? {}).map(String);
    expect(values).not.toContain(issued.rawToken);
  });

  it("rejects issuing a token for an unknown user", async () => {
    await expect(
      repo.insert({
        userId: "ghost" as UserId,
        type: "reset",
        tokenHash: await hashToken("whatever"),
        createdAt: "t",
        expiresAt: "t2",
      }),
    ).rejects.toThrow();
  });

  it("TENANT ISOLATION — a token issued for one tenant's user is stored under that tenant only", async () => {
    const userA = await seedUser("acct-a", "a@x.test");
    const userB = await seedUser("acct-b", "b@x.test");
    const issuedA = await issueEmailToken(deps, userA, "reset");
    const issuedB = await issueEmailToken(deps, userB, "reset");

    const { rows } = await db.query<{ account_id: string; id: string }>(
      "select account_id, id from email_tokens where id in ($1, $2) order by account_id",
      [issuedA.record.id, issuedB.record.id],
    );
    expect(rows).toEqual([
      { account_id: "acct-a", id: issuedA.record.id },
      { account_id: "acct-b", id: issuedB.record.id },
    ]);
  });
});
