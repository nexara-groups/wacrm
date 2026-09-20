import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { NO_ISSUED_AT_COLUMN, SqlRefreshTokenRepository } from "./refresh-token-repository";
import { SqlSessionRepository } from "./session-repository";
import { SqlUserRepository } from "./user-repository";
import { issueInitialRefreshToken, rotateRefreshToken, type RotationDeps } from "../domain/refresh-token-rotation";
import { generateToken, hashToken } from "../domain/token-hashing";
import type { TenantId } from "@shared/types";

let db: SqlJsDatabaseProvider;
let repo: SqlRefreshTokenRepository;
let users: SqlUserRepository;
let sessions: SqlSessionRepository;
let deps: RotationDeps;

async function seedSession(accountId: string, email: string): Promise<string> {
  const user = await users.create({
    accountId: accountId as TenantId,
    email,
    passwordHash: "x",
    role: "member",
    emailVerifiedAt: null,
  });
  const session = await sessions.create({
    userId: user.id,
    deviceId: null,
    createdAt: "2026-09-17T00:00:00.000Z",
    lastSeenAt: "2026-09-17T00:00:00.000Z",
    expiresAt: "2026-10-17T00:00:00.000Z",
  });
  return session.id;
}

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repo = new SqlRefreshTokenRepository(db);
  users = new SqlUserRepository(db);
  sessions = new SqlSessionRepository(db);
  deps = {
    port: repo,
    hashToken,
    generateToken,
    now: () => new Date("2026-09-17T00:00:00.000Z"),
    ttlMs: 30 * 24 * 60 * 60 * 1000,
  };
});

describe("SqlRefreshTokenRepository + rotation domain logic", () => {
  it("rotation issues a new token and invalidates the old one", async () => {
    const sessionId = await seedSession("acct-a", "a@x.test");
    const initial = await issueInitialRefreshToken(deps, sessionId);

    const rotated = await rotateRefreshToken(deps, initial.rawToken);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error("unreachable");
    expect(rotated.value.record.familyId).toBe(initial.record.familyId);
    expect(rotated.value.record.rotatedFrom).toBe(initial.record.id);
    expect(rotated.value.rawToken).not.toBe(initial.rawToken);

    // The old token cannot be redeemed a second time.
    const replay = await rotateRefreshToken(deps, initial.rawToken);
    expect(replay.ok).toBe(false);
  });

  it("REUSE DETECTION — replaying a used token revokes the entire family across a 3-rotation chain", async () => {
    const sessionId = await seedSession("acct-a", "a@x.test");
    const t0 = await issueInitialRefreshToken(deps, sessionId);
    const t1 = await rotateRefreshToken(deps, t0.rawToken);
    if (!t1.ok) throw new Error("unreachable");
    const t2 = await rotateRefreshToken(deps, t1.value.rawToken);
    if (!t2.ok) throw new Error("unreachable");
    const t3 = await rotateRefreshToken(deps, t2.value.rawToken);
    if (!t3.ok) throw new Error("unreachable");

    // Replay the FIRST token in the chain — already used, well behind the
    // legitimate client's current position.
    const replay = await rotateRefreshToken(deps, t0.rawToken);
    expect(replay.ok).toBe(false);

    // Every token descended from the family — including the one the
    // legitimate client currently holds (t3) — must now be revoked.
    const family = await repo.findFamily(t0.record.familyId);
    expect(family).toHaveLength(4);
    for (const token of family) {
      expect(token.revokedAt).not.toBeNull();
    }

    // The legitimate client's own latest token is now unusable too — that
    // is the point: reuse revokes the family, not just the replayed token.
    const attemptWithLatest = await rotateRefreshToken(deps, t3.value.rawToken);
    expect(attemptWithLatest.ok).toBe(false);
  });

  it("no raw token value ever reaches the database — only its hash is stored", async () => {
    const sessionId = await seedSession("acct-a", "a@x.test");
    const issued = await issueInitialRefreshToken(deps, sessionId);

    const { rows } = await db.query<Record<string, unknown>>(
      "select * from refresh_tokens where account_id = $1 and id = $2",
      ["acct-a", issued.record.id],
    );
    expect(rows).toHaveLength(1);
    const stored = rows[0] as { token_hash: string };
    expect(stored.token_hash).not.toBe(issued.rawToken);
    expect(stored.token_hash).toBe(await hashToken(issued.rawToken));
    // Belt and suspenders: the raw token string must not appear anywhere in
    // the row at all, under any column.
    const values = Object.values(rows[0] ?? {}).map(String);
    expect(values).not.toContain(issued.rawToken);
  });

  it("rejects issuing a token for an unknown session", async () => {
    await expect(
      repo.insert({
        sessionId: "ghost-session",
        tokenHash: await hashToken("whatever"),
        familyId: crypto.randomUUID(),
        rotatedFrom: null,
        issuedAt: "t",
        expiresAt: "t2",
      }),
    ).rejects.toThrow();
  });

  it("SCHEMA GAP — issuedAt does not round-trip through a read (refresh_tokens has no issued_at column)", async () => {
    const sessionId = await seedSession("acct-a", "a@x.test");
    const issued = await issueInitialRefreshToken(deps, sessionId);
    // Fresh from insert(), the in-memory value is accurate...
    expect(issued.record.issuedAt).toBe("2026-09-17T00:00:00.000Z");
    // ...but a later read-back cannot recover it, and says so plainly.
    const reread = await repo.findByTokenHash(await hashToken(issued.rawToken));
    expect(reread?.issuedAt).toBe(NO_ISSUED_AT_COLUMN);
  });

  it("TENANT ISOLATION — revoking one tenant's family never touches another tenant's tokens", async () => {
    const sessionA = await seedSession("acct-a", "a@x.test");
    const sessionB = await seedSession("acct-b", "b@x.test");
    const tokenA = await issueInitialRefreshToken(deps, sessionA);
    const tokenB = await issueInitialRefreshToken(deps, sessionB);

    await repo.revokeFamily(tokenA.record.familyId, "2026-09-17T00:00:00.000Z");

    const familyA = await repo.findFamily(tokenA.record.familyId);
    const familyB = await repo.findFamily(tokenB.record.familyId);
    expect(familyA[0]?.revokedAt).not.toBeNull();
    expect(familyB[0]?.revokedAt).toBeNull();

    const { rows } = await db.query<{ account_id: string }>(
      "select account_id from refresh_tokens where account_id in ($1, $2) order by account_id",
      ["acct-a", "acct-b"],
    );
    expect(rows.map((r) => r.account_id)).toEqual(["acct-a", "acct-b"]);
  });
});
