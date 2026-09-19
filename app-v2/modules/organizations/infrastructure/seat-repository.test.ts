import { beforeEach, describe, expect, it } from "vitest";
import type { TenantContext } from "@nexara/core/context";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlSeatRepository } from "./seat-repository";
import { countSeats } from "../domain/seat-usage";
import { hashToken } from "../../identity/domain/token-hashing";
import { resolveSeatLimit } from "../domain/seat-limit";

const A: TenantContext = { tenantId: "acct-a" };
const B: TenantContext = { tenantId: "acct-b" };
const NOW = new Date("2026-09-17T00:00:00.000Z");

let db: SqlJsDatabaseProvider;
let repo: SqlSeatRepository;

/** Seeds an account with a single owner membership (mirrors contact-repository.test.ts's pattern). */
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
  await db.query(
    `insert into memberships (id, account_id, user_id, role, created_at, deactivated_at)
     values ($1, $2, $3, 'owner', 't', null)`,
    [`m-owner-${accountId}`, accountId, ownerUserId],
  );
}

/** Seeds a pending invitation and returns its RAW token — the only thing
 *  `acceptInvitationIfSeatAvailable` accepts, so the hash stored here has to
 *  be the real digest of it, not a made-up string. */
async function seedPendingInvitation(
  accountId: string,
  id: string,
  opts: { expiresAt?: string; role?: string } = {},
): Promise<string> {
  const rawToken = `raw-token-${id}`;
  await db.query(
    `insert into account_invitations
       (id, account_id, token_hash, role, created_by_user_id, label, created_at, expires_at,
        accepted_at, accepted_by_user_id, revoked_at)
     values ($1, $2, $3, $4, null, $5, 't', $6, null, null, null)`,
    [id, accountId, await hashToken(rawToken), opts.role ?? "member", `${id}@invite.test`, opts.expiresAt ?? "2099-01-01T00:00:00.000Z"],
  );
  return rawToken;
}

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repo = new SqlSeatRepository(db);
  await seedAccount("acct-a");
  await seedAccount("acct-b");
});

describe("SqlSeatRepository", () => {
  it("resolves the platform default seat limit with no plan and no override", async () => {
    const config = await repo.getSeatLimitConfig(A);
    expect(config.accountSeatLimitOverride).toBeNull();
    expect(config.planIncludedSeats).toBeNull();
    expect(config.platformDefaultSeatLimit).toBe(3);
    expect(resolveSeatLimit(config)).toBe(3);
  });

  it("seat count includes the owner and pending invitations", async () => {
    const members = await repo.listMembers(A);
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("owner");
    expect(countSeats(members, [], NOW)).toBe(1);

    const invite = await repo.reserveSeatAndCreateInvitation(A, {
      email: "new@x.test",
      role: "member",
      invitedBy: "u-acct-a",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(invite).not.toBeNull();
    expect(invite?.invitation.status).toBe("pending");

    const invitations = await repo.listInvitations(A);
    expect(countSeats(await repo.listMembers(A), invitations, NOW)).toBe(2); // owner + 1 pending
  });

  it("refuses to reserve a seat once the account is at its resolved cap", async () => {
    // Cap is 3 (platform default): owner (1) + 2 invitations = at cap.
    const first = await repo.reserveSeatAndCreateInvitation(A, {
      email: "a@x.test", role: "member", invitedBy: "u-acct-a", expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const second = await repo.reserveSeatAndCreateInvitation(A, {
      email: "b@x.test", role: "member", invitedBy: "u-acct-a", expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const third = await repo.reserveSeatAndCreateInvitation(A, {
      email: "c@x.test", role: "member", invitedBy: "u-acct-a", expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
  });

  it("expired invitations release their seat", async () => {
    await seedPendingInvitation("acct-a", "inv-1", { expiresAt: "2020-01-01T00:00:00.000Z" });
    const invitations = await repo.listInvitations(A);
    // Repo reports the persisted markers only; the domain layer's own
    // expiresAt check (via countSeats) is what actually excludes it —
    // exactly like the port docstring's "even if a status column hasn't
    // caught up yet" language describes.
    expect(countSeats(await repo.listMembers(A), invitations, NOW)).toBe(1); // owner only

    // A fresh invitation CAN be reserved even though an old, expired one
    // still has a `pending`-shaped row — its seat was already released.
    const reserved = await repo.reserveSeatAndCreateInvitation(A, {
      email: "fresh@x.test", role: "member", invitedBy: "u-acct-a", expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(reserved).not.toBeNull();
  });

  it("markInvitationExpiredOrRevoked(revoked) releases the seat", async () => {
    await seedPendingInvitation("acct-a", "inv-1");
    expect(countSeats(await repo.listMembers(A), await repo.listInvitations(A), NOW)).toBe(2);

    await repo.markInvitationExpiredOrRevoked(A, "inv-1", "revoked");
    const invitations = await repo.listInvitations(A);
    expect(invitations.find((i) => i.id === "inv-1")?.status).toBe("revoked");
    expect(countSeats(await repo.listMembers(A), invitations, NOW)).toBe(1);
  });

  it("markInvitationExpiredOrRevoked(expired) also releases the seat", async () => {
    await seedPendingInvitation("acct-a", "inv-1");
    const beforeCall = new Date();
    await repo.markInvitationExpiredOrRevoked(A, "inv-1", "expired");
    const invitations = await repo.listInvitations(A);
    const marked = invitations.find((i) => i.id === "inv-1");
    // Still reported "pending" by the repo's persisted-marker view (see file
    // header gap #2's sibling note) but no longer counts as of any instant
    // from the moment it was marked onward, because its expiresAt was
    // brought into the (then-)present rather than left in the far future.
    expect(marked?.expiresAt?.getTime()).not.toBeGreaterThan(new Date().getTime());
    expect(marked?.expiresAt?.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime() - 1000);
    expect(countSeats(await repo.listMembers(A), invitations, new Date(marked!.expiresAt!.getTime() + 1))).toBe(1);
  });

  it("accepting an invitation converts a reserved seat into an active member (seat-neutral)", async () => {
    const invite = await repo.reserveSeatAndCreateInvitation(A, {
      email: "new@x.test", role: "admin", invitedBy: "u-acct-a", expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(invite).not.toBeNull();
    const before = countSeats(await repo.listMembers(A), await repo.listInvitations(A), NOW);

    const member = await repo.acceptInvitationIfSeatAvailable(A, invite!.token, NOW);
    expect(member).not.toBeNull();
    expect(member?.role).toBe("admin");
    expect(member?.status).toBe("active");

    const after = countSeats(await repo.listMembers(A), await repo.listInvitations(A), NOW);
    expect(after).toBe(before); // reserved -> active, not reserved + active

    // The invitation is now accepted, not pending.
    const invitations = await repo.listInvitations(A);
    expect(invitations.find((i) => i.id === invite!.invitation.id)?.status).toBe("accepted");
  });

  it("an invitation ID is not a credential — accepting with it instead of the token fails", async () => {
    // The property this pins: an id appears in listings, in URLs and in
    // logs, while accepting an invitation creates a user with a role inside
    // someone's account. Before the token path existed, `token_hash` held a
    // value nobody was ever given and accept was keyed on the id, so the id
    // WAS the credential. If accept ever regresses to an id lookup, this
    // fails.
    const invite = await repo.reserveSeatAndCreateInvitation(A, {
      email: "byid@x.test",
      role: "member",
      invitedBy: "u-acct-a",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(invite).not.toBeNull();

    expect(await repo.acceptInvitationIfSeatAvailable(A, invite!.invitation.id, NOW)).toBeNull();
    // ...and the real token still works, so the refusal above is about the
    // id specifically, not a broken invitation.
    expect(await repo.acceptInvitationIfSeatAvailable(A, invite!.token, NOW)).not.toBeNull();
  });

  it("the raw token is returned once and never stored — only its digest is in the row", async () => {
    const invite = await repo.reserveSeatAndCreateInvitation(A, {
      email: "digest@x.test",
      role: "member",
      invitedBy: "u-acct-a",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const { rows } = await db.query<{ token_hash: string }>(
      `select token_hash from account_invitations where account_id = $1 and id = $2`,
      ["acct-a", invite!.invitation.id],
    );
    expect(rows[0]?.token_hash).toBe(await hashToken(invite!.token));
    expect(rows[0]?.token_hash).not.toBe(invite!.token);

    // No read path hands the token back: listInvitations returns
    // SeatInvitation, which has no token field at all.
    const listed = (await repo.listInvitations(A)).find((i) => i.id === invite!.invitation.id);
    expect(listed).toBeDefined();
    expect(Object.keys(listed!)).not.toContain("token");
  });

  it("re-accepting the same invitation a second time fails (already accepted)", async () => {
    const invite = await repo.reserveSeatAndCreateInvitation(A, {
      email: "new@x.test", role: "member", invitedBy: "u-acct-a", expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    await repo.acceptInvitationIfSeatAvailable(A, invite!.token, NOW);
    const second = await repo.acceptInvitationIfSeatAvailable(A, invite!.token, NOW);
    expect(second).toBeNull();
  });

  it("CONCURRENCY — two concurrent accepts at cap-1 result in exactly one success", async () => {
    // acct-a: owner (1 active) + one direct member (1 active) = 2 active,
    // cap 3 -> exactly one more ACTIVE member fits.
    await repo.createMemberDirectly(A, { email: "second@x.test", role: "member" });
    expect(await repo.listMembers(A)).toHaveLength(2);

    const raceToken1 = await seedPendingInvitation("acct-a", "inv-race-1");
    const raceToken2 = await seedPendingInvitation("acct-a", "inv-race-2");

    const [r1, r2] = await Promise.all([
      repo.acceptInvitationIfSeatAvailable(A, raceToken1, NOW),
      repo.acceptInvitationIfSeatAvailable(A, raceToken2, NOW),
    ]);

    const successes = [r1, r2].filter((r) => r !== null);
    expect(successes).toHaveLength(1);

    const members = await repo.listMembers(A);
    expect(members.filter((m) => m.status === "active")).toHaveLength(3);

    const invitations = await repo.listInvitations(A);
    const statuses = invitations.map((i) => i.status).sort();
    expect(statuses).toEqual(["accepted", "pending"]);
  });

  it("createMemberDirectly creates an active member without a cap check", async () => {
    const member = await repo.createMemberDirectly(A, { email: "direct@x.test", role: "manager" });
    expect(member.status).toBe("active");
    expect(member.role).toBe("manager");
    expect(await repo.listMembers(A)).toHaveLength(2);
  });

  it("reactivateMemberIfSeatAvailable refuses at cap and succeeds with room", async () => {
    // Fill to cap (3): owner + 2 direct members.
    const m2 = await repo.createMemberDirectly(A, { email: "m2@x.test", role: "member" });
    await repo.createMemberDirectly(A, { email: "m3@x.test", role: "member" });
    await repo.removeMember(A, m2.id); // free one seat: 2 active now

    const deactivated = await repo.listMembers(A);
    expect(deactivated.find((m) => m.id === m2.id)?.status).toBe("deactivated");

    const reactivated = await repo.reactivateMemberIfSeatAvailable(A, m2.id);
    expect(reactivated?.status).toBe("active");

    // Now at cap (3 active) — deactivate and re-add to hit the cap exactly,
    // then confirm a further reactivation attempt of an unrelated member is refused.
    await repo.removeMember(A, m2.id);
    await repo.createMemberDirectly(A, { email: "m4@x.test", role: "member" }); // back to 3 active
    const refused = await repo.reactivateMemberIfSeatAvailable(A, m2.id);
    expect(refused).toBeNull();
  });

  it("removeMember frees a seat (over-seat-limit is self-clearing)", async () => {
    const m2 = await repo.createMemberDirectly(A, { email: "m2@x.test", role: "member" });
    await repo.createMemberDirectly(A, { email: "m3@x.test", role: "member" });
    await repo.createMemberDirectly(A, { email: "m4@x.test", role: "member" }); // 4 active, cap 3
    expect(await repo.getOverSeatLimitState(A)).toBe(true);

    await repo.removeMember(A, m2.id);
    expect(await repo.getOverSeatLimitState(A)).toBe(false);
  });

  it("recordAuditLog requires a verified platform admin and records their role", async () => {
    await db.query(
      `-- tenant-scope-exempt: platform_admins is a cross-tenant grant table by
       -- design (0004_platform_admin.sql) — a platform role is not scoped to
       -- any one account.
       insert into platform_admins (user_id, platform_role, granted_by, granted_at)
       values ($1, 'platform_admin', 'root', 't')`,
      ["staff-1"],
    );
    await expect(
      repo.recordAuditLog({
        accountId: "acct-a",
        actorUserId: "staff-1",
        action: "seat_limit_override_direct_user_creation",
        reason: "customer requested more seats",
        occurredAt: NOW,
      }),
    ).resolves.toBeUndefined();

    const { rows } = await db.query<{ platform_role: string; target_account_id: string }>(
      "select platform_role, target_account_id from platform_audit_log where target_account_id = $1",
      ["acct-a"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.platform_role).toBe("platform_admin");
  });

  it("recordAuditLog refuses an actor who is not a verified platform admin", async () => {
    await expect(
      repo.recordAuditLog({
        accountId: "acct-a",
        actorUserId: "not-a-platform-admin",
        action: "seat_limit_override_direct_user_creation",
        reason: "x",
        occurredAt: NOW,
      }),
    ).rejects.toThrow();
  });

  it("recordSeatUsageEvent appends a row", async () => {
    await repo.recordSeatUsageEvent({
      accountId: "acct-a", delta: 1, reason: "invitation_created", actorUserId: "u-acct-a", occurredAt: NOW,
    });
    const { rows } = await db.query<{ delta: number }>(
      "select delta from seat_usage_events where account_id = $1",
      ["acct-a"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delta).toBe(1);
  });

  describe("acceptInvitationByToken — the PUBLIC self-serve accept", () => {
    it("creates the users, memberships AND credentials rows atomically, from the invitation's own email", async () => {
      const invite = await repo.reserveSeatAndCreateInvitation(A, {
        email: "newmember@x.test",
        role: "admin",
        invitedBy: "u-acct-a",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      expect(invite).not.toBeNull();

      const result = await repo.acceptInvitationByToken(invite!.token, "fake-hash-1", NOW);
      expect(result.kind).toBe("accepted");
      if (result.kind !== "accepted") throw new Error("expected the accept to succeed");
      expect(result.tenantId).toBe("acct-a");
      expect(result.email).toBe("newmember@x.test");
      expect(result.member.role).toBe("admin");
      expect(result.member.status).toBe("active");

      // The credential — the whole point of this method — exists, under the
      // INVITATION's email (never anything the caller could have supplied;
      // this method takes no email parameter at all) and the hash passed
      // in verbatim (hashing itself is the service layer's job, never this
      // repository's).
      const { rows: credRows } = await db.query<{
        email: string;
        tenant_id: string;
        password_hash: string;
        role: string;
      }>(`select email, tenant_id, password_hash, role from credentials where user_id = $1`, [
        result.member.userId,
      ]);
      expect(credRows).toHaveLength(1);
      expect(credRows[0]?.email).toBe("newmember@x.test");
      expect(credRows[0]?.tenant_id).toBe("acct-a");
      expect(credRows[0]?.password_hash).toBe("fake-hash-1");
      expect(credRows[0]?.role).toBe("admin");

      const invitations = await repo.listInvitations(A);
      expect(invitations.find((i) => i.id === invite!.invitation.id)?.status).toBe("accepted");
    });

    it("reports an unknown token as invalid_or_expired", async () => {
      expect(await repo.acceptInvitationByToken("not-a-real-token", "hash", NOW)).toEqual({
        kind: "invalid_or_expired",
      });
    });

    it("reports an expired invitation as invalid_or_expired", async () => {
      const rawToken = await seedPendingInvitation("acct-a", "inv-expired", {
        expiresAt: "2020-01-01T00:00:00.000Z",
      });
      expect(await repo.acceptInvitationByToken(rawToken, "hash", NOW)).toEqual({ kind: "invalid_or_expired" });
    });

    it("reports a revoked invitation as invalid_or_expired", async () => {
      const invite = await repo.reserveSeatAndCreateInvitation(A, {
        email: "rev@x.test",
        role: "member",
        invitedBy: "u-acct-a",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      await repo.markInvitationExpiredOrRevoked(A, invite!.invitation.id, "revoked");
      expect(await repo.acceptInvitationByToken(invite!.token, "hash", NOW)).toEqual({
        kind: "invalid_or_expired",
      });
    });

    it("cannot be replayed after it already succeeded once", async () => {
      const invite = await repo.reserveSeatAndCreateInvitation(A, {
        email: "replay@x.test",
        role: "member",
        invitedBy: "u-acct-a",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      const first = await repo.acceptInvitationByToken(invite!.token, "hash-1", NOW);
      expect(first.kind).toBe("accepted");

      const second = await repo.acceptInvitationByToken(invite!.token, "hash-2", NOW);
      expect(second.kind).not.toBe("accepted");

      const { rows } = await db.query<{ count: number }>(
        `-- tenant-scope-exempt: test-only assertion that credentials.email is
         -- globally unique (0013_global_email_uniqueness.sql) — deliberately
         -- cross-tenant, proving no second row was created ANYWHERE
         select count(*) as count from credentials where email = $1`,
        ["replay@x.test"],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it("ATOMICITY — a duplicate credential email rolls back the whole accept: invitation stays pending, no membership created, no seat consumed", async () => {
      // Someone in a DIFFERENT tenant already holds a credential at the
      // address this invitation was sent to — `credentials.email` is
      // globally unique (0013_global_email_uniqueness.sql), so the
      // credentials insert below WILL violate it.
      await db.query(
        `insert into credentials (user_id, tenant_id, email, password_hash, role, verified_at)
         values ($1, $2, $3, $4, 'member', null)`,
        ["existing-user", "acct-b", "collide@x.test", "existing-hash"],
      );

      const invite = await repo.reserveSeatAndCreateInvitation(A, {
        email: "collide@x.test",
        role: "member",
        invitedBy: "u-acct-a",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      expect(invite).not.toBeNull();
      const before = countSeats(await repo.listMembers(A), await repo.listInvitations(A), NOW);

      const result = await repo.acceptInvitationByToken(invite!.token, "new-hash", NOW);
      expect(result).toEqual({ kind: "email_taken" });

      // The invitation itself: still pending, NOT accepted — the claim
      // UPDATE was part of the same batch that rolled back.
      const invitations = await repo.listInvitations(A);
      expect(invitations.find((i) => i.id === invite!.invitation.id)?.status).toBe("pending");

      // No membership/user was created by the failed attempt — the owner
      // is still the only member.
      const members = await repo.listMembers(A);
      expect(members).toHaveLength(1);

      // Seat accounting is exactly what it was before the attempt (still
      // reserved by the still-pending invitation, nothing more).
      const after = countSeats(members, invitations, NOW);
      expect(after).toBe(before);

      // Exactly the ORIGINAL credential row exists for that address —
      // nothing extra, nothing half-written.
      const { rows: credRows } = await db.query<{ tenant_id: string }>(
        `select tenant_id from credentials where email = $1`,
        ["collide@x.test"],
      );
      expect(credRows).toHaveLength(1);
      expect(credRows[0]?.tenant_id).toBe("acct-b");
    });

    it("AT CAP — accepting once active membership already fills the resolved cap fails cleanly and consumes nothing", async () => {
      // Reserve the invitation FIRST, while a seat is still free (mirrors
      // "the cap was lowered, or another invite accepted first, since this
      // one was sent" — SEAT_LIMITS.md §3).
      const invite = await repo.reserveSeatAndCreateInvitation(A, {
        email: "capped@x.test",
        role: "member",
        invitedBy: "u-acct-a",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      expect(invite).not.toBeNull();

      // Fill the account to its ACTIVE-member cap via the cap-bypassing
      // direct-creation path (owner + 2 = 3 = the platform default cap).
      await repo.createMemberDirectly(A, { email: "direct1@x.test", role: "member" });
      await repo.createMemberDirectly(A, { email: "direct2@x.test", role: "member" });
      expect((await repo.listMembers(A)).filter((m) => m.status === "active")).toHaveLength(3);

      const result = await repo.acceptInvitationByToken(invite!.token, "hash", NOW);
      expect(result).toEqual({ kind: "seat_unavailable" });

      // Nothing was consumed: invitation still pending, member count
      // unchanged, and no credential was created for the invitee.
      const invitations = await repo.listInvitations(A);
      expect(invitations.find((i) => i.id === invite!.invitation.id)?.status).toBe("pending");
      expect(await repo.listMembers(A)).toHaveLength(3);

      const { rows } = await db.query<{ email: string }>(
        `-- tenant-scope-exempt: test-only assertion that no credential was
         -- created anywhere for this address — deliberately cross-tenant
         select email from credentials where email = $1`,
        ["capped@x.test"],
      );
      expect(rows).toHaveLength(0);
    });

    it("resolves the tenant from the token itself — no tenant is passed in, and cross-tenant tokens still work", async () => {
      const inviteA = await repo.reserveSeatAndCreateInvitation(A, {
        email: "cross-a@x.test",
        role: "member",
        invitedBy: "u-acct-a",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      const inviteB = await repo.reserveSeatAndCreateInvitation(B, {
        email: "cross-b@x.test",
        role: "member",
        invitedBy: "u-acct-b",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });

      const resultA = await repo.acceptInvitationByToken(inviteA!.token, "hash-a", NOW);
      const resultB = await repo.acceptInvitationByToken(inviteB!.token, "hash-b", NOW);
      expect(resultA.kind).toBe("accepted");
      expect(resultB.kind).toBe("accepted");
      if (resultA.kind !== "accepted" || resultB.kind !== "accepted") throw new Error("expected both to accept");
      expect(resultA.tenantId).toBe("acct-a");
      expect(resultB.tenantId).toBe("acct-b");
    });
  });

  describe("TENANT ISOLATION — both directions, every method", () => {
    it("listMembers / listInvitations never cross accounts", async () => {
      await repo.createMemberDirectly(A, { email: "a2@x.test", role: "member" });
      await repo.reserveSeatAndCreateInvitation(B, {
        email: "b-invite@x.test", role: "member", invitedBy: "u-acct-b", expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      expect(await repo.listMembers(A)).toHaveLength(2);
      expect(await repo.listMembers(B)).toHaveLength(1);
      expect(await repo.listInvitations(A)).toHaveLength(0);
      expect(await repo.listInvitations(B)).toHaveLength(1);
    });

    it("acceptInvitationIfSeatAvailable cannot be used across a tenant boundary", async () => {
      const invite = await repo.reserveSeatAndCreateInvitation(A, {
        email: "a@x.test", role: "member", invitedBy: "u-acct-a", expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      // Tenant B presenting tenant A's invitation id must not succeed.
      expect(await repo.acceptInvitationIfSeatAvailable(B, invite!.token, NOW)).toBeNull();
      // It is still acceptable under its real tenant afterwards.
      expect(await repo.acceptInvitationIfSeatAvailable(A, invite!.token, NOW)).not.toBeNull();
    });

    it("markInvitationExpiredOrRevoked / removeMember / reactivateMemberIfSeatAvailable are no-ops across tenants", async () => {
      const invite = await repo.reserveSeatAndCreateInvitation(A, {
        email: "a@x.test", role: "member", invitedBy: "u-acct-a", expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      await repo.markInvitationExpiredOrRevoked(B, invite!.invitation.id, "revoked");
      expect((await repo.listInvitations(A)).find((i) => i.id === invite!.invitation.id)?.status).toBe("pending");

      const member = await repo.createMemberDirectly(A, { email: "m2@x.test", role: "member" });
      await repo.removeMember(B, member.id);
      expect((await repo.listMembers(A)).find((m) => m.id === member.id)?.status).toBe("active");

      await db.query(`update memberships set deactivated_at = 't' where account_id = $1 and id = $2`, [
        "acct-a",
        member.id,
      ]);
      expect(await repo.reactivateMemberIfSeatAvailable(B, member.id)).toBeNull();
      expect((await repo.listMembers(A)).find((m) => m.id === member.id)?.status).toBe("deactivated");
    });

    it("getSeatLimitConfig / getOverSeatLimitState are per-account", async () => {
      await db.query(
        `update accounts set seat_limit_override = $2
          -- tenant-scope-exempt: accounts IS the tenant root; its tenant column is id
          where id = $1`,
        ["acct-a", 10],
      );
      const configA = await repo.getSeatLimitConfig(A);
      const configB = await repo.getSeatLimitConfig(B);
      expect(configA.accountSeatLimitOverride).toBe(10);
      expect(configB.accountSeatLimitOverride).toBeNull();
    });
  });
});
