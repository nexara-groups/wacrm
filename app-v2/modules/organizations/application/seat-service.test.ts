import { describe, expect, it } from "vitest";
import type { TenantContext } from "@nexara/core/context";
import { resolveSeatLimit } from "../domain/seat-limit";
import { countSeats, type SeatInvitation, type SeatMember } from "../domain/seat-usage";
import { SeatService, SeatLimitExceeded } from "./seat-service";
import type {
  CreateInvitationInput,
  DirectUserCreationInput,
  ReservedInvitation,
  SeatAuditEntry,
  SeatLimitConfig,
  SeatRepository,
  SeatUsageEvent,
} from "./ports";

const NOW = new Date("2026-09-17T00:00:00Z");

interface TenantStore {
  config: SeatLimitConfig;
  members: SeatMember[];
  invitations: SeatInvitation[];
  overSeatLimit: boolean;
  auditLog: SeatAuditEntry[];
  usageEvents: SeatUsageEvent[];
}

function defaultConfig(): SeatLimitConfig {
  return { accountSeatLimitOverride: null, planIncludedSeats: null, platformDefaultSeatLimit: 3 };
}

/**
 * In-memory fake for `SeatRepository`, tenant-scoped (a separate `TenantStore`
 * per `tenantId`, never sharing rows across tenants — see the "seat counts
 * are tenant-scoped" test below).
 *
 * ATOMICITY MODEL (for the `*IfSeatAvailable` / `reserveSeatAnd*` methods):
 * each tenant has a private lock (`withLock`), and every atomic method
 * acquires it before reading and mutating that tenant's store, releasing it
 * only after the mutation is applied. This mirrors what the real
 * implementation MUST provide via a DB transaction / row lock (per
 * SEAT_LIMITS.md §3 and the port docstring) — nothing here is "atomic" by
 * accident of JavaScript's single-threaded execution; a small artificial
 * `await` is inserted between the read and the write inside the critical
 * section specifically so that two concurrent calls genuinely interleave
 * unless the lock is doing real work. Without `withLock`, the concurrency
 * test below (`two concurrent accepts at cap-1`) would let both callers read
 * the same "1 free seat" state and both incorrectly succeed.
 */
class FakeSeatRepository implements SeatRepository {
  private readonly stores = new Map<string, TenantStore>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private nextId = 1;
  /** raw token -> invitation id, mirroring the real repository's token_hash lookup. */
  private readonly tokens = new Map<string, string>();

  /** Test helper: the raw token for a directly-seeded invitation id. Accept
   *  is token-keyed now, so a test that seeds a row must also know its
   *  token — exactly as a real invitee would. */
  tokenFor(invitationId: string): string {
    const existing = [...this.tokens.entries()].find(([, id]) => id === invitationId);
    if (existing) return existing[0];
    const token = `seeded-token-${invitationId}`;
    this.tokens.set(token, invitationId);
    return token;
  }

  seed(tenantId: string, partial: Partial<TenantStore>): void {
    this.stores.set(tenantId, {
      config: partial.config ?? defaultConfig(),
      members: partial.members ? [...partial.members] : [],
      invitations: partial.invitations ? [...partial.invitations] : [],
      overSeatLimit: partial.overSeatLimit ?? false,
      auditLog: [],
      usageEvents: [],
    });
  }

  private store(tenant: TenantContext): TenantStore {
    let store = this.stores.get(tenant.tenantId);
    if (!store) {
      store = { config: defaultConfig(), members: [], invitations: [], overSeatLimit: false, auditLog: [], usageEvents: [] };
      this.stores.set(tenant.tenantId, store);
    }
    return store;
  }

  private withLock<T>(tenant: TenantContext, fn: () => Promise<T>): Promise<T> {
    const key = tenant.tenantId;
    const prior = this.locks.get(key) ?? Promise.resolve();
    const chained = prior.then(fn, fn);
    this.locks.set(
      key,
      chained.then(
        () => undefined,
        () => undefined,
      ),
    );
    return chained;
  }

  private async settle(): Promise<void> {
    // Artificial interleaving point: without the per-tenant lock above, two
    // concurrent callers would both pass this await having read the same
    // pre-mutation state.
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async getSeatLimitConfig(tenant: TenantContext): Promise<SeatLimitConfig> {
    return this.store(tenant).config;
  }

  async listMembers(tenant: TenantContext): Promise<readonly SeatMember[]> {
    return this.store(tenant).members;
  }

  async listInvitations(tenant: TenantContext): Promise<readonly SeatInvitation[]> {
    return this.store(tenant).invitations;
  }

  async reserveSeatAndCreateInvitation(
    tenant: TenantContext,
    input: CreateInvitationInput,
  ): Promise<ReservedInvitation | null> {
    return this.withLock(tenant, async () => {
      const store = this.store(tenant);
      const limit = resolveSeatLimit(store.config);
      const used = countSeats(store.members, store.invitations, NOW);
      await this.settle();
      if (used >= limit) return null;
      const rawToken = `token-${this.nextId}`;
      const invitation: SeatInvitation = {
        id: `invite-${this.nextId++}`,
        status: "pending",
        email: input.email,
        role: input.role,
        invitedBy: input.invitedBy,
        createdAt: NOW,
        expiresAt: input.expiresAt,
      };
      store.invitations.push(invitation);
      this.tokens.set(rawToken, invitation.id);
      return { invitation, token: rawToken };
    });
  }

  async acceptInvitationIfSeatAvailable(
    tenant: TenantContext,
    rawToken: string,
    now: Date,
  ): Promise<SeatMember | null> {
    return this.withLock(tenant, async () => {
      const store = this.store(tenant);
      // Mirrors the real repository: the token is the only way in, so an
      // unknown one finds nothing rather than falling back to an id lookup.
      const invitationId = this.tokens.get(rawToken);
      if (invitationId === undefined) return null;
      const invitation = store.invitations.find((i) => i.id === invitationId);
      if (!invitation || invitation.status !== "pending") return null;

      const limit = resolveSeatLimit(store.config);
      // Accept-time re-check compares LIVE ACTIVE MEMBER COUNT against the
      // resolved limit, not the invitation-inclusive total. The invitation
      // being accepted already reserved its own seat at creation time (that
      // is what gates *new invitations* — see reserveSeatAndCreateInvitation
      // above, which uses the full members+invitations total); other STILL
      // pending invitations do not further block THIS accept. This is what
      // makes "cap re-enforced at acceptance" meaningful independently of
      // "cap enforced at creation": if the cap was lowered since this
      // invitation was created, or if create-time reservation was ever
      // bypassed/raced (SEAT_LIMITS.md §3's own example — "at 2 of 3 seats
      // used, two invitations both accepted is 4 seats without [the
      // re-check]"), the active-member headcount at the moment of accept is
      // the true, final gate.
      const activeMembers = store.members.filter((m) => m.status === "active" && !m.isPlatformStaff).length;
      await this.settle();
      if (activeMembers >= limit) return null;

      const memberId = `member-${this.nextId++}`;
      const newMember: SeatMember = { id: memberId, userId: `user-${memberId}`, joinedAt: NOW, status: "active", role: "member", isPlatformStaff: false };
      store.members.push(newMember);
      store.invitations = store.invitations.map((i) => (i.id === invitationId ? { ...i, status: "accepted" } : i));
      void now;
      return newMember;
    });
  }

  async markInvitationExpiredOrRevoked(
    tenant: TenantContext,
    invitationId: string,
    status: "expired" | "revoked",
  ): Promise<void> {
    const store = this.store(tenant);
    store.invitations = store.invitations.map((i) => (i.id === invitationId ? { ...i, status } : i));
  }

  async createMemberDirectly(tenant: TenantContext, input: DirectUserCreationInput): Promise<SeatMember> {
    const store = this.store(tenant);
    const directMemberId = `member-${this.nextId++}`;
    const newMember: SeatMember = {
      id: directMemberId,
      userId: `user-${directMemberId}`,
      joinedAt: NOW,
      status: "active",
      role: input.role,
      isPlatformStaff: false,
    };
    store.members.push(newMember);
    return newMember;
  }

  async reactivateMemberIfSeatAvailable(tenant: TenantContext, memberId: string): Promise<SeatMember | null> {
    return this.withLock(tenant, async () => {
      const store = this.store(tenant);
      const member = store.members.find((m) => m.id === memberId);
      if (!member || member.status === "active") return null;
      const limit = resolveSeatLimit(store.config);
      const activeMembers = store.members.filter((m) => m.status === "active" && !m.isPlatformStaff).length;
      if (activeMembers >= limit) return null;
      store.members = store.members.map((m) => (m.id === memberId ? { ...m, status: "active" } : m));
      return { ...member, status: "active" };
    });
  }

  async removeMember(tenant: TenantContext, memberId: string): Promise<void> {
    const store = this.store(tenant);
    store.members = store.members.map((m) => (m.id === memberId ? { ...m, status: "removed" } : m));
  }

  async getOverSeatLimitState(tenant: TenantContext): Promise<boolean> {
    return this.store(tenant).overSeatLimit;
  }

  async setOverSeatLimitState(tenant: TenantContext, isOverSeatLimit: boolean): Promise<void> {
    this.store(tenant).overSeatLimit = isOverSeatLimit;
  }

  async recordAuditLog(entry: SeatAuditEntry): Promise<void> {
    const store = this.stores.get(entry.accountId);
    if (store) store.auditLog.push(entry);
  }

  async recordSeatUsageEvent(event: SeatUsageEvent): Promise<void> {
    const store = this.stores.get(event.accountId);
    if (store) store.usageEvents.push(event);
  }

  // Test-only accessors.
  auditLogFor(tenantId: string): readonly SeatAuditEntry[] {
    return this.stores.get(tenantId)?.auditLog ?? [];
  }
  usageEventsFor(tenantId: string): readonly SeatUsageEvent[] {
    return this.stores.get(tenantId)?.usageEvents ?? [];
  }
  rawStore(tenantId: string): TenantStore | undefined {
    return this.stores.get(tenantId);
  }
}

function tenant(tenantId: string): TenantContext {
  return { tenantId };
}

function makeService(repo: FakeSeatRepository): SeatService {
  return new SeatService({ repository: repo, clock: () => NOW });
}

function activeMember(id: string, overrides: Partial<SeatMember> = {}): SeatMember {
  return {
    id,
    userId: `user-${id}`,
    joinedAt: NOW,
    status: "active",
    role: "member",
    isPlatformStaff: false,
    ...overrides,
  };
}

describe("SeatService — SEAT_LIMITS.md §3 / §7", () => {
  it("cap enforced at invitation creation", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", {
      config: { accountSeatLimitOverride: null, planIncludedSeats: null, platformDefaultSeatLimit: 3 },
      members: [activeMember("m1"), activeMember("m2"), activeMember("m3")],
    });
    const service = makeService(repo);

    const result = await service.createInvitation(tenant("acct-1"), {
      email: "new@example.com",
      role: "member",
      invitedBy: "user-1",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SeatLimitExceeded);
      expect(result.error.message).toBe("You've used all 3 user seats on your plan. Remove a user or upgrade to add more.");
    }
  });

  it("allows invitation creation under the cap and reserves the seat (pending invitations count)", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", { members: [activeMember("m1")] });
    const service = makeService(repo);

    const result = await service.createInvitation(tenant("acct-1"), {
      email: "new@example.com",
      role: "member",
      invitedBy: "user-1",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    expect(await service.usedSeats(tenant("acct-1"))).toBe(2); // 1 member + 1 pending invitation
  });

  it("cap RE-enforced at invitation acceptance, even though creation was allowed at the time", async () => {
    const repo = new FakeSeatRepository();
    // Invitation was validly created back when the account had 2 seats free.
    repo.seed("acct-1", {
      members: [activeMember("m1")],
      invitations: [{ id: "invite-1", status: "pending", email: "invitee@example.test", role: "member", invitedBy: "user-1", createdAt: NOW, expiresAt: null }],
    });
    const service = makeService(repo);

    // The account owner then filled the account up to the cap through
    // another path (direct creation) before this invitation was accepted.
    // The first lands within the cap; the second is only possible with an
    // audited platform override (§3), which is what actually pushes ACTIVE
    // member headcount to the cap. Without the override the second call is
    // correctly refused, the account never fills, and the accept below would
    // legitimately succeed — the reserved seat simply converts to a member.
    await service.directUserCreation(tenant("acct-1"), { email: "a@x.com", role: "member" });
    await service.directUserCreation(
      tenant("acct-1"),
      { email: "b@x.com", role: "member" },
      { actorUserId: "platform-1", reason: "customer onboarding escalation" },
    );

    const result = await service.acceptInvitation(tenant("acct-1"), repo.tokenFor("invite-1"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("This workspace has no free seats. Ask the account owner to free one or upgrade.");
    }
  });

  it("accepting a validly reserved invitation under the cap succeeds", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", {
      members: [activeMember("m1")],
      invitations: [{ id: "invite-1", status: "pending", email: "invitee@example.test", role: "member", invitedBy: "user-1", createdAt: NOW, expiresAt: null }],
    });
    const service = makeService(repo);

    const result = await service.acceptInvitation(tenant("acct-1"), repo.tokenFor("invite-1"));

    expect(result.ok).toBe(true);
  });

  it(
    "two concurrent accepts at (cap - 1) active members: exactly one succeeds. " +
      "Models SEAT_LIMITS.md §3's own example — 'at 2 of 3 seats used, two " +
      "invitations both accepted is 4 seats without [the re-check]' — by " +
      "racing two real accept calls through the fake's per-tenant lock " +
      "(see FakeSeatRepository's ATOMICITY MODEL comment above). The " +
      "contract this proves: whatever persistence layer implements " +
      "SeatRepository MUST serialize acceptInvitationIfSeatAvailable per " +
      "account (a DB transaction / row lock), the same class of requirement " +
      "as the credit wallet's hot row (DATABASE_DECISION.md).",
    async () => {
      const repo = new FakeSeatRepository();
      repo.seed("acct-1", {
        members: [activeMember("m1"), activeMember("m2")], // cap - 1 = 2 active members, cap = 3
        invitations: [
          { id: "invite-A", status: "pending", email: "invitee@example.test", role: "member", invitedBy: "user-1", createdAt: NOW, expiresAt: null },
          { id: "invite-B", status: "pending", email: "invitee@example.test", role: "member", invitedBy: "user-1", createdAt: NOW, expiresAt: null },
        ],
      });
      const service = makeService(repo);

      const [resultA, resultB] = await Promise.all([
        service.acceptInvitation(tenant("acct-1"), repo.tokenFor("invite-A")),
        service.acceptInvitation(tenant("acct-1"), repo.tokenFor("invite-B")),
      ]);

      const outcomes = [resultA.ok, resultB.ok];
      expect(outcomes.filter((ok) => ok === true)).toHaveLength(1);
      expect(outcomes.filter((ok) => ok === false)).toHaveLength(1);

      // Final state never exceeded the cap.
      const finalMembers = repo.rawStore("acct-1")!.members.filter((m) => m.status === "active").length;
      expect(finalMembers).toBe(3);
    },
  );

  it("reactivating a member at cap is refused", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", {
      members: [activeMember("m1"), activeMember("m2"), activeMember("m3"), { id: "m4", userId: "user-m4", joinedAt: NOW, status: "deactivated", role: "member", isPlatformStaff: false }],
    });
    const service = makeService(repo);

    const result = await service.reactivateMember(tenant("acct-1"), "m4");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(SeatLimitExceeded);
  });

  it("reactivating a member under the cap succeeds and consumes a seat", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", {
      members: [activeMember("m1"), { id: "m2", userId: "user-m2", joinedAt: NOW, status: "deactivated", role: "member", isPlatformStaff: false }],
    });
    const service = makeService(repo);

    const result = await service.reactivateMember(tenant("acct-1"), "m2");

    expect(result.ok).toBe(true);
    expect(await service.usedSeats(tenant("acct-1"))).toBe(2);
  });

  it("over_seat_limit blocks new invitations", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", {
      members: [activeMember("m1"), activeMember("m2")],
      overSeatLimit: true,
    });
    const service = makeService(repo);

    const result = await service.createInvitation(tenant("acct-1"), {
      email: "x@x.com",
      role: "member",
      invitedBy: "user-1",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });

    expect(result.ok).toBe(false);
  });

  it("over_seat_limit blocks reactivation", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", {
      members: [{ id: "m1", userId: "user-m1", joinedAt: NOW, status: "deactivated", role: "member", isPlatformStaff: false }],
      overSeatLimit: true,
    });
    const service = makeService(repo);

    const result = await service.reactivateMember(tenant("acct-1"), "m1");

    expect(result.ok).toBe(false);
  });

  it("over_seat_limit clears when a member is removed and usage drops to the cap", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", {
      config: defaultConfig(), // cap = 3
      members: [activeMember("m1"), activeMember("m2"), activeMember("m3"), activeMember("m4")], // 4 active, over by 1
      overSeatLimit: true,
    });
    const service = makeService(repo);

    const stillOver = await service.recomputeOverSeatLimitState(tenant("acct-1"));
    expect(stillOver).toBe(true);

    const clearedAfterRemoval = await service.removeMemberAndRecompute(tenant("acct-1"), "m4");
    expect(clearedAfterRemoval).toBe(false);
    expect(await repo.getOverSeatLimitState(tenant("acct-1"))).toBe(false);

    // Downgrade never removes an existing member on its own — only the
    // explicit, human-initiated removal above touched membership.
    const remainingActive = repo.rawStore("acct-1")!.members.filter((m) => m.status === "active");
    expect(remainingActive).toHaveLength(3);
    expect(remainingActive.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("downgrade (recomputeOverSeatLimitState) never removes an existing member, even far over cap", async () => {
    const repo = new FakeSeatRepository();
    const tenMembers = Array.from({ length: 10 }, (_, i) => activeMember(`m${i}`));
    repo.seed("acct-1", { config: defaultConfig(), members: tenMembers }); // cap 3, 10 active
    const service = makeService(repo);

    const isOver = await service.recomputeOverSeatLimitState(tenant("acct-1"));

    expect(isOver).toBe(true);
    const activeCount = repo.rawStore("acct-1")!.members.filter((m) => m.status === "active").length;
    expect(activeCount).toBe(10); // nobody was removed
  });

  it("override requires a reason: refused without one, even from a platform actor", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", { members: [activeMember("m1"), activeMember("m2"), activeMember("m3")] });
    const service = makeService(repo);

    const result = await service.directUserCreation(
      tenant("acct-1"),
      { email: "x@x.com", role: "member" },
      { actorUserId: "platform-admin-1", reason: "" },
    );

    expect(result.ok).toBe(false);
    expect(repo.auditLogFor("acct-1")).toHaveLength(0);
  });

  it("override with a reason bypasses the cap and writes an audit record", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", { members: [activeMember("m1"), activeMember("m2"), activeMember("m3")] });
    const service = makeService(repo);

    const result = await service.directUserCreation(
      tenant("acct-1"),
      { email: "x@x.com", role: "member" },
      { actorUserId: "platform-admin-1", reason: "Customer paid for an extra seat over the phone" },
    );

    expect(result.ok).toBe(true);
    const audit = repo.auditLogFor("acct-1");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe("Customer paid for an extra seat over the phone");
    expect(audit[0]?.actorUserId).toBe("platform-admin-1");
    expect(audit[0]?.action).toBe("seat_limit_override_direct_user_creation");

    const usageEvents = repo.usageEventsFor("acct-1");
    expect(usageEvents.some((e) => e.reason === "Customer paid for an extra seat over the phone")).toBe(true);
  });

  it("direct user creation within the cap succeeds without needing an override", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", { members: [activeMember("m1")] });
    const service = makeService(repo);

    const result = await service.directUserCreation(tenant("acct-1"), { email: "x@x.com", role: "member" });

    expect(result.ok).toBe(true);
    expect(repo.auditLogFor("acct-1")).toHaveLength(0); // no override, no audit needed
  });

  it("seat counts are tenant-scoped: one account's usage never leaks into another's", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", { members: [activeMember("m1"), activeMember("m2"), activeMember("m3")] }); // at cap
    repo.seed("acct-2", { members: [activeMember("m1")] }); // 1 used, plenty of room
    const service = makeService(repo);

    const acct1Result = await service.createInvitation(tenant("acct-1"), {
      email: "x@x.com",
      role: "member",
      invitedBy: "u1",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });
    const acct2Result = await service.createInvitation(tenant("acct-2"), {
      email: "y@x.com",
      role: "member",
      invitedBy: "u1",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });

    expect(acct1Result.ok).toBe(false); // acct-1 is at its own cap
    expect(acct2Result.ok).toBe(true); // acct-2's cap is untouched by acct-1's usage
    expect(await service.usedSeats(tenant("acct-1"))).toBe(3);
    expect(await service.usedSeats(tenant("acct-2"))).toBe(2);
  });

  it("expired/revoked invitations release their seat, freeing room for a new invitation", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", {
      members: [activeMember("m1"), activeMember("m2")],
      invitations: [{ id: "invite-1", status: "pending", email: "invitee@example.test", role: "member", invitedBy: "user-1", createdAt: NOW, expiresAt: null }], // usage = 3 = cap
    });
    const service = makeService(repo);

    const blocked = await service.createInvitation(tenant("acct-1"), {
      email: "a@x.com",
      role: "member",
      invitedBy: "u1",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(blocked.ok).toBe(false);

    await repo.markInvitationExpiredOrRevoked(tenant("acct-1"), "invite-1", "revoked");
    expect(await service.usedSeats(tenant("acct-1"))).toBe(2);

    const nowAllowed = await service.createInvitation(tenant("acct-1"), {
      email: "b@x.com",
      role: "member",
      invitedBy: "u1",
      expiresAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(nowAllowed.ok).toBe(true);
  });

  it("owner counts toward the cap (assertCanAddSeat refuses when the owner alone plus others reach it)", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", {
      members: [
        activeMember("owner-1", { role: "owner" }),
        activeMember("m2"),
        activeMember("m3"),
      ],
    });
    const service = makeService(repo);

    const result = await service.assertCanAddSeat(tenant("acct-1"));

    expect(result.ok).toBe(false);
  });

  it("account seat_limit_override takes precedence over the plan when resolving the limit used for enforcement", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", {
      config: { accountSeatLimitOverride: 5, planIncludedSeats: 3, platformDefaultSeatLimit: 3 },
      members: [activeMember("m1"), activeMember("m2"), activeMember("m3")], // over the plan's 3, under the override's 5
    });
    const service = makeService(repo);

    const result = await service.assertCanAddSeat(tenant("acct-1"));

    expect(result.ok).toBe(true); // allowed because the override (5) wins over the plan (3)
  });

  it("plain-English refusal at the cap matches the spec's exact wording", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", { members: [activeMember("m1"), activeMember("m2"), activeMember("m3")] });
    const service = makeService(repo);

    const result = await service.assertCanAddSeat(tenant("acct-1"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("You've used all 3 user seats on your plan. Remove a user or upgrade to add more.");
      expect(result.error.seatLimit).toBe(3);
      expect(result.error.seatsUsed).toBe(3);
    }
  });
});
