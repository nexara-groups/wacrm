import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlSignupRepository } from "./signup-repository";
import type { CreateTenantInput } from "../application/ports";

const NOW = new Date("2026-09-19T00:00:00.000Z");

let db: SqlJsDatabaseProvider;
let repo: SqlSignupRepository;

function input(overrides: Partial<CreateTenantInput> = {}): CreateTenantInput {
  return {
    accountId: crypto.randomUUID(),
    accountName: "Acme Inc",
    ownerUserId: crypto.randomUUID(),
    ownerName: "Ada Owner",
    membershipId: crypto.randomUUID(),
    email: "owner@example.test",
    passwordHash: "pbkdf2-sha256$40000$c2FsdA$aGFzaA",
    now: NOW,
    ...overrides,
  };
}

async function countAll(): Promise<{
  accounts: number;
  users: number;
  credentials: number;
  memberships: number;
}> {
  const [accounts, users, credentials, memberships] = await Promise.all([
    db.query(`-- tenant-scope-exempt: whole-table count, deliberately cross-tenant — this
              -- is the atomicity proof's assertion that NO row exists anywhere, in ANY
              -- tenant, not a scoped read of one tenant's rows.
              select count(*) as n from accounts`),
    db.query(`-- tenant-scope-exempt: see accounts count above
              select count(*) as n from users`),
    db.query(`-- tenant-scope-exempt: see accounts count above
              select count(*) as n from credentials`),
    db.query(`-- tenant-scope-exempt: see accounts count above
              select count(*) as n from memberships`),
  ]);
  return {
    accounts: Number(accounts.rows[0]?.n ?? 0),
    users: Number(users.rows[0]?.n ?? 0),
    credentials: Number(credentials.rows[0]?.n ?? 0),
    memberships: Number(memberships.rows[0]?.n ?? 0),
  };
}

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repo = new SqlSignupRepository(db);
});

describe("SqlSignupRepository", () => {
  it("creates all four rows — accounts, users, credentials, memberships — for one signup", async () => {
    const before = await countAll();
    expect(before).toEqual({ accounts: 0, users: 0, credentials: 0, memberships: 0 });

    const tenantInput = input();
    const result = await repo.createTenant(tenantInput);
    expect(result.kind).toBe("created");

    const after = await countAll();
    expect(after).toEqual({ accounts: 1, users: 1, credentials: 1, memberships: 1 });

    const account = (
      await db.query(
        `-- tenant-scope-exempt: accounts IS the tenant root; its tenant column is id, filtered on below
         select * from accounts where id = $1`,
        [tenantInput.accountId],
      )
    ).rows[0];
    expect(account?.owner_user_id).toBe(tenantInput.ownerUserId);
    expect(account?.name).toBe("Acme Inc");
    // No plan, no seat override — a brand-new tenant gets only the
    // platform default, never a purchased plan (billing is out of scope).
    expect(account?.plan_id).toBeNull();
    expect(account?.seat_limit_override ?? null).toBeNull();

    const user = (
      await db.query(`select * from users where user_id = $1 and tenant_id = $2`, [
        tenantInput.ownerUserId,
        tenantInput.accountId,
      ])
    ).rows[0];
    expect(user?.tenant_id).toBe(tenantInput.accountId);
    expect(user?.role).toBe("owner");
    // Marked verified at creation — see SqlSignupRepository's header for why.
    expect(user?.email_verified_at).not.toBeNull();

    const credential = (
      await db.query(`select * from credentials where user_id = $1 and tenant_id = $2`, [
        tenantInput.ownerUserId,
        tenantInput.accountId,
      ])
    ).rows[0];
    expect(credential?.tenant_id).toBe(tenantInput.accountId);
    expect(credential?.email).toBe("owner@example.test");
    expect(credential?.password_hash).toBe(tenantInput.passwordHash);
    expect(credential?.role).toBe("owner");
    expect(credential?.verified_at).not.toBeNull();

    const membership = (
      await db.query(`select * from memberships where id = $1 and account_id = $2`, [
        tenantInput.membershipId,
        tenantInput.accountId,
      ])
    ).rows[0];
    expect(membership?.account_id).toBe(tenantInput.accountId);
    expect(membership?.user_id).toBe(tenantInput.ownerUserId);
    expect(membership?.role).toBe("owner");
    expect(membership?.deactivated_at).toBeNull();
  });

  it("autoVerifyEmail: false creates the owner UNVERIFIED — users.email_verified_at and credentials.verified_at both null", async () => {
    const tenantInput = input({ email: "pending-verify@example.test", autoVerifyEmail: false });
    const result = await repo.createTenant(tenantInput);
    expect(result.kind).toBe("created");

    const user = (
      await db.query(`select * from users where user_id = $1 and tenant_id = $2`, [
        tenantInput.ownerUserId,
        tenantInput.accountId,
      ])
    ).rows[0];
    expect(user?.email_verified_at).toBeNull();

    const credential = (
      await db.query(`select * from credentials where user_id = $1 and tenant_id = $2`, [
        tenantInput.ownerUserId,
        tenantInput.accountId,
      ])
    ).rows[0];
    expect(credential?.verified_at).toBeNull();
  });

  it("omitting autoVerifyEmail keeps the original auto-verify behavior", async () => {
    const tenantInput = input({ email: "default-behavior@example.test" });
    expect(tenantInput.autoVerifyEmail).toBeUndefined();
    await repo.createTenant(tenantInput);

    const credential = (
      await db.query(`select * from credentials where user_id = $1 and tenant_id = $2`, [
        tenantInput.ownerUserId,
        tenantInput.accountId,
      ])
    ).rows[0];
    expect(credential?.verified_at).not.toBeNull();
  });

  it("lets two different signups create two fully separate tenants", async () => {
    const first = await repo.createTenant(input({ email: "first@example.test" }));
    const second = await repo.createTenant(input({ email: "second@example.test" }));
    expect(first.kind).toBe("created");
    expect(second.kind).toBe("created");

    const after = await countAll();
    expect(after).toEqual({ accounts: 2, users: 2, credentials: 2, memberships: 2 });
  });

  it("THE ATOMICITY PROOF — a duplicate email creates NOTHING: not the account, not the user, not the membership", async () => {
    const firstAccountId = crypto.randomUUID();
    const first = await repo.createTenant(
      input({ accountId: firstAccountId, email: "dup@example.test" }),
    );
    expect(first.kind).toBe("created");

    const afterFirst = await countAll();
    expect(afterFirst).toEqual({ accounts: 1, users: 1, credentials: 1, memberships: 1 });

    // Same email (case-insensitive collision is the caller's job to
    // normalize — SignupService does that; this repository test drives the
    // exact byte-for-byte duplicate to isolate the DB-level guarantee),
    // different account/user/membership ids entirely.
    const second = await repo.createTenant(
      input({
        accountId: crypto.randomUUID(),
        ownerUserId: crypto.randomUUID(),
        membershipId: crypto.randomUUID(),
        email: "dup@example.test",
        accountName: "A Totally Different Company",
      }),
    );

    expect(second.kind).toBe("email_taken");

    // The single most important assertion in this task: row counts are
    // EXACTLY what they were after the first signup. No half-created
    // second account, no orphaned user, no orphaned membership — the
    // failed attempt left no trace in any of the four tables.
    const afterSecond = await countAll();
    expect(afterSecond).toEqual({ accounts: 1, users: 1, credentials: 1, memberships: 1 });

    // The original tenant is completely untouched (same account row, same
    // name — the second attempt's data never leaked into it).
    const account = (
      await db.query(
        `-- tenant-scope-exempt: accounts IS the tenant root; its tenant column is id, filtered on below
         select * from accounts where id = $1`,
        [firstAccountId],
      )
    ).rows[0];
    expect(account?.name).toBe("Acme Inc");
  });

  it("recognises a terse unique-constraint error that never names the table or column", async () => {
    // D1 can return a shorter message for a failure inside a batch than
    // sql.js does. The detection used to require the words "credentials" AND
    // "email" to both appear, so a message like the one below fell through,
    // got rethrown, and turned the most common signup error — someone already
    // has an account — into a 500 instead of "try logging in instead".
    //
    // Driven through a stub provider because the point is the SHAPE of the
    // error, which a real sql.js failure cannot produce.
    const terse = {
      name: "provider",
      async query() {
        throw new Error("D1_ERROR: UNIQUE constraint failed: SQLITE_CONSTRAINT");
      },
      async batch() {
        throw new Error("D1_ERROR: UNIQUE constraint failed: SQLITE_CONSTRAINT");
      },
    };
    const repo = new SqlSignupRepository(terse as never);

    const result = await repo.createTenant({
      accountId: "acct-terse",
      accountName: "Terse Co",
      ownerUserId: "user-terse",
      email: "terse@x.test",
      passwordHash: "pbkdf2-sha256$1000$aaaa$bbbb",
      membershipId: "mem-terse",
      now: new Date(),
    } as never);

    expect(result.kind).toBe("email_taken");
  });

  it("rejects a genuinely unrelated database failure instead of misreporting it as a duplicate email", async () => {
    // Force a real, unrelated failure: a `null` account name violates
    // `accounts.name NOT NULL`. This must reject with the underlying error,
    // not a false-positive "email_taken".
    await expect(
      repo.createTenant(input({ accountName: null as unknown as string })),
    ).rejects.toThrow();

    const after = await countAll();
    expect(after).toEqual({ accounts: 0, users: 0, credentials: 0, memberships: 0 });
  });
});
