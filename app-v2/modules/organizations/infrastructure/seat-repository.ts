/**
 * SQL implementation of `SeatRepository` over `AtomicBatchDatabaseProvider`.
 *
 * Schema: db/migrations/d1/0002_organizations.sql (`accounts`, `memberships`,
 * `account_invitations`) and 0003_seat_limits.sql (`platform_settings`,
 * `plans`, `accounts.seat_limit_*`, `seat_usage_events`); `platform_admins`
 * / `platform_audit_log` come from 0004_platform_admin.sql.
 *
 * Multi-statement writes use `batch()`, never an interactive transaction —
 * see modules/contacts/infrastructure/contact-repository.ts's file header:
 * D1 has no interactive transactions, so `batch()` is the only atomic
 * multi-statement primitive available on every candidate store.
 *
 * -----------------------------------------------------------------------
 * THE ACCEPT-TIME RACE — how atomicity is actually achieved
 * -----------------------------------------------------------------------
 * `reserveSeatAndCreateInvitation`, `acceptInvitationIfSeatAvailable` and
 * `reactivateMemberIfSeatAvailable` are documented as ATOMIC against
 * concurrent callers (SEAT_LIMITS.md §3/§7). The real guarantee does NOT
 * come from wrapping a read-then-write JS sequence in a transaction (D1 has
 * none, per above) — it comes from expressing "check the cap, then act" as
 * ONE self-gating SQL statement per seat-consuming effect:
 *   - `reserveSeatAndCreateInvitation` is a single
 *     `INSERT ... SELECT ... WHERE <cap not exceeded>`, so the invitation is
 *     inserted only if the WHERE clause's live subqueries are still true at
 *     the instant the storage engine evaluates them — there is no window
 *     between "check" and "act" for a second caller to land in.
 *   - `acceptInvitationIfSeatAvailable` claims the invitation with a single
 *     `UPDATE ... WHERE <invitation is still pending> AND <cap not
 *     exceeded>`, checked via its `rowCount` (0 or 1, never partial). The
 *     user/membership rows that follow it in the same `batch()` are
 *     themselves gated by `WHERE EXISTS (... accepted_by_user_id = <this
 *     attempt's userId>)`, so if the claim UPDATE affected 0 rows, the
 *     follow-up inserts affect 0 rows too — the whole batch is a no-op, not
 *     a partial one, without needing to inspect intermediate results to
 *     decide whether to run them.
 *   - `reactivateMemberIfSeatAvailable` is the same pattern as the accept
 *     claim: one conditional `UPDATE`, `rowCount` says whether it won.
 * This is what makes "exactly one success" hold under any store that
 * executes a single statement atomically (SQLite/D1's single-writer model;
 * Postgres row locking) — not an accident of one process's single-threaded
 * JS. The one JS-level addition, `withTenantLock` below, exists ONLY to
 * keep `sql.js` (a single, shared connection in tests/dev) from raising
 * "cannot start a transaction within a transaction" when two `batch()`
 * calls for the SAME tenant are actually issued concurrently in a test —
 * it serializes *when* those atomic statements run on one connection, it is
 * not what makes them correct.
 *
 * -----------------------------------------------------------------------
 * SCHEMA GAPS — flagged, not invented. See also the two identity-module
 * gaps documented in modules/identity/infrastructure/user-repository.ts and
 * refresh-token-repository.ts.
 * -----------------------------------------------------------------------
 * 1. `getOverSeatLimitState`/`setOverSeatLimitState` — the port docstring
 *    calls this "the persisted `over_seat_limit` flag ... kept in sync with
 *    `computeOverSeatLimitStatus`", i.e. a cached projection for fast fleet
 *    reads. No such column exists anywhere in the migrations (`accounts`
 *    gained only `seat_limit_override/_reason/_set_by/_set_at` in
 *    0003_seat_limits.sql — no boolean flag). Rather than invent one,
 *    `getOverSeatLimitState` recomputes the status live from current usage
 *    vs. the resolved limit every call (still correct — `SeatService`
 *    already recomputes both independently in `assertCanAddSeat` — just not
 *    a cheap cached read), and `setOverSeatLimitState` is a documented
 *    no-op. A real fix needs a migration to add the column.
 * 2. `SeatMemberStatus` has three values (`active`/`removed`/`deactivated`)
 *    but `memberships` (0002_organizations.sql) has only one nullable
 *    `deactivated_at` timestamp — there is no way to distinguish "removed"
 *    from "deactivated" in storage. `countSeats` (domain/seat-usage.ts)
 *    treats both identically (neither counts), so this has no effect on
 *    seat accounting; `removeMember` sets `deactivated_at` and every read
 *    reports such a row as `"deactivated"`, never `"removed"` — flagged
 *    here rather than silently picking one of the two labels as if the
 *    schema distinguished them.
 * 3. `CreateInvitationInput.email` has no backing column: `account_invitations`
 *    (0002_organizations.sql) has no `email` column, only a generic,
 *    unused-by-any-other-port-method `label TEXT`. Rather than invent a
 *    column, or worse, silently drop the email on the floor, this
 *    repository stores it in `label` — a column that is otherwise unused
 *    by this port and whose generic name does not misrepresent what is
 *    being stored the way e.g. commandeering `memberships.role` would.
 * 4. `reserveSeatAndCreateInvitation` cannot return a redemption token:
 *    `SeatInvitation` (domain/seat-usage.ts) has no token field, and
 *    `CreateInvitationInput` supplies no token/tokenHash either — yet
 *    `account_invitations.token_hash` is `NOT NULL UNIQUE`. Since nothing in
 *    this port ever looks an invitation up by token (`acceptInvitationIfSeatAvailable`
 *    takes an `invitationId`, not a token), this repository writes a random,
 *    internal-only placeholder there purely to satisfy the constraint; it is
 *    never a real secret (nothing derives it from anything sensitive) and is
 *    discarded immediately. Whatever actually emails the invitee a working
 *    link (not implemented by any port method given to this task) will need
 *    its own token issuance — most naturally the identity module's own
 *    `email_tokens` (type `"invite"`), which is a wholly separate mechanism
 *    already wired for exactly this in `IdentityService.inviteUser`.
 */
import type { AtomicBatchDatabaseProvider, Row } from "@nexara/core/database";
import type { TenantContext } from "@nexara/core/context";
import { isRole, type Role } from "@nexara/core/rbac";
import { AppError } from "@shared/errors";
import { resolveSeatLimit } from "../domain/seat-limit";
import { countSeats, type SeatInvitation, type SeatMember } from "../domain/seat-usage";
import { computeOverSeatLimitStatus } from "../domain/over-seat-limit";
import type {
  CreateInvitationInput,
  DirectUserCreationInput,
  SeatAuditEntry,
  SeatLimitConfig,
  SeatRepository,
  SeatUsageEvent,
} from "../application/ports";

function text(value: unknown): string {
  return String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRole(value: unknown): Role {
  const raw = text(value);
  return isRole(raw) ? raw : "member";
}

function toSeatMember(row: Row): SeatMember {
  return {
    id: text(row.id),
    status: row.deactivated_at === null || row.deactivated_at === undefined ? "active" : "deactivated",
    role: toRole(row.role),
    isPlatformStaff: Number(row.is_platform_staff ?? 0) !== 0,
  };
}

function toSeatInvitation(row: Row): SeatInvitation {
  const status =
    row.revoked_at !== null && row.revoked_at !== undefined
      ? "revoked"
      : row.accepted_at !== null && row.accepted_at !== undefined
        ? "accepted"
        : "pending";
  const expiresAtRaw = nullableText(row.expires_at);
  return {
    id: text(row.id),
    status,
    expiresAt: expiresAtRaw === null ? null : new Date(expiresAtRaw),
  };
}

/** Subquery: active, non-platform-staff member count for account `$n`. */
function activeMemberCountSubquery(placeholder: string): string {
  return `(
    select count(*) from memberships m
      left join platform_admins pa on pa.user_id = m.user_id and pa.revoked_at is null
     where m.account_id = ${placeholder} and m.deactivated_at is null and pa.user_id is null
  )`;
}

/** Subquery: resolved seat limit for account `$n` — SEAT_LIMITS.md §2. */
function resolvedSeatLimitSubquery(placeholder: string): string {
  return `(
    -- tenant-scope-exempt: accounts IS the tenant root; its tenant column is id
    select coalesce(a.seat_limit_override, p.included_seats, ps.default_seat_limit)
      from accounts a
      left join plans p on p.id = a.plan_id
      cross join platform_settings ps
     where a.id = ${placeholder}
  )`;
}

export class SqlSeatRepository implements SeatRepository {
  constructor(private readonly db: AtomicBatchDatabaseProvider) {}

  /**
   * Serializes calls per tenant so two `batch()` invocations never overlap
   * on `sql.js`'s single shared connection — see the file header's "THE
   * ACCEPT-TIME RACE" note for why this is a test-harness accommodation,
   * not the source of correctness.
   */
  private readonly locks = new Map<string, Promise<unknown>>();
  private withTenantLock<T>(tenant: TenantContext, fn: () => Promise<T>): Promise<T> {
    const key = tenant.tenantId;
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    this.locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async getSeatLimitConfig(tenant: TenantContext): Promise<SeatLimitConfig> {
    const { rows } = await this.db.query<Row>(
      `-- tenant-scope-exempt: accounts IS the tenant root; its tenant column is id
       select a.seat_limit_override as seat_limit_override,
              p.included_seats as plan_included_seats,
              ps.default_seat_limit as platform_default_seat_limit
         from accounts a
         left join plans p on p.id = a.plan_id
         cross join platform_settings ps
        where a.id = $1`,
      [tenant.tenantId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`unknown account ${tenant.tenantId}`);
    }
    return {
      accountSeatLimitOverride:
        row.seat_limit_override === null || row.seat_limit_override === undefined
          ? null
          : Number(row.seat_limit_override),
      planIncludedSeats:
        row.plan_included_seats === null || row.plan_included_seats === undefined
          ? null
          : Number(row.plan_included_seats),
      platformDefaultSeatLimit: Number(row.platform_default_seat_limit),
    };
  }

  async listMembers(tenant: TenantContext): Promise<readonly SeatMember[]> {
    const { rows } = await this.db.query<Row>(
      `select m.id as id, m.role as role, m.deactivated_at as deactivated_at,
              case when pa.user_id is not null and pa.revoked_at is null then 1 else 0 end as is_platform_staff
         from memberships m
         left join platform_admins pa on pa.user_id = m.user_id
        where m.account_id = $1`,
      [tenant.tenantId],
    );
    return rows.map(toSeatMember);
  }

  async listInvitations(tenant: TenantContext): Promise<readonly SeatInvitation[]> {
    const { rows } = await this.db.query<Row>(
      `select id, accepted_at, revoked_at, expires_at
         from account_invitations
        where account_id = $1`,
      [tenant.tenantId],
    );
    return rows.map(toSeatInvitation);
  }

  async reserveSeatAndCreateInvitation(
    tenant: TenantContext,
    input: CreateInvitationInput,
  ): Promise<SeatInvitation | null> {
    if (input.role === "owner") {
      throw AppError.validation("cannot invite a new owner (account_invitations.role forbids it)");
    }
    const id = crypto.randomUUID();
    // See file header, gap #4 — an internal-only placeholder; never a real
    // secret, and nothing ever looks an invitation up by it.
    const tokenPlaceholder = crypto.randomUUID();
    const createdAt = nowIso();
    const expiresAt = input.expiresAt.toISOString();

    const { rowCount } = await this.db.query(
      `insert into account_invitations
         (id, account_id, token_hash, role, created_by_user_id, label, created_at, expires_at,
          accepted_at, accepted_by_user_id, revoked_at)
       select $1, $2, $3, $4, $5, $6, $7, $8, null, null, null
        where (
                ${activeMemberCountSubquery("$2")}
              + (
                  select count(*) from account_invitations ai
                   where ai.account_id = $2 and ai.accepted_at is null and ai.revoked_at is null
                     and ai.expires_at > $7
                )
              ) < ${resolvedSeatLimitSubquery("$2")}`,
      [id, tenant.tenantId, tokenPlaceholder, input.role, input.invitedBy, input.email, createdAt, expiresAt],
    );
    if (rowCount !== 1) return null;
    return { id, status: "pending", expiresAt: input.expiresAt };
  }

  async acceptInvitationIfSeatAvailable(
    tenant: TenantContext,
    invitationId: string,
    now: Date,
  ): Promise<SeatMember | null> {
    return this.withTenantLock(tenant, async () => {
      const nowValue = now.toISOString();
      const existing = await this.db.query<Row>(
        `select role, label from account_invitations where account_id = $1 and id = $2`,
        [tenant.tenantId, invitationId],
      );
      const invitation = existing.rows[0];
      if (invitation === undefined) return null;
      const role = toRole(invitation.role);
      const email = nullableText(invitation.label) ?? `unknown+${invitationId}@invalid`;
      const newUserId = crypto.randomUUID();
      const newMemberId = crypto.randomUUID();

      const results = await this.db.batch([
        {
          // The claim: succeeds (rowCount 1) only if this invitation is
          // still genuinely pending AND a seat is available for one more
          // ACTIVE member right now — see file header for why this single
          // statement is what makes "exactly one success" hold.
          sql: `update account_invitations
                   set accepted_at = $3, accepted_by_user_id = $4
                 where account_id = $1 and id = $2
                   and accepted_at is null and revoked_at is null and expires_at > $3
                   and ${activeMemberCountSubquery("$1")} < ${resolvedSeatLimitSubquery("$1")}`,
          params: [tenant.tenantId, invitationId, nowValue, newUserId],
        },
        {
          // Gated on the claim above having actually set accepted_by_user_id
          // to THIS attempt's newUserId — a losing attempt inserts 0 rows.
          sql: `insert into users (user_id, tenant_id, email, role, email_verified_at, created_at, updated_at)
                select $3, $1, $4, $5, null, $6, $6
                 where exists (
                   select 1 from account_invitations ai
                    where ai.account_id = $1 and ai.id = $2 and ai.accepted_by_user_id = $3
                 )`,
          params: [tenant.tenantId, invitationId, newUserId, email, role, nowValue],
        },
        {
          sql: `insert into memberships (id, account_id, user_id, role, created_at, deactivated_at)
                select $3, $1, $4, $5, $6, null
                 where exists (
                   select 1 from account_invitations ai
                    where ai.account_id = $1 and ai.id = $2 and ai.accepted_by_user_id = $4
                 )`,
          params: [tenant.tenantId, invitationId, newMemberId, newUserId, role, nowValue],
        },
      ]);

      const claim = results[0];
      if (claim === undefined || claim.rowCount !== 1) return null;
      return { id: newMemberId, status: "active", role, isPlatformStaff: false };
    });
  }

  async markInvitationExpiredOrRevoked(
    tenant: TenantContext,
    invitationId: string,
    status: "expired" | "revoked",
  ): Promise<void> {
    const now = nowIso();
    if (status === "revoked") {
      await this.db.query(
        `update account_invitations
            set revoked_at = $3
          where account_id = $1 and id = $2 and accepted_at is null and revoked_at is null`,
        [tenant.tenantId, invitationId, now],
      );
      return;
    }
    // "expired" — see file header gap #2's sibling reasoning: rather than
    // invent a status column, bring `expires_at` forward to "already
    // expired". `countSeats` (domain/seat-usage.ts) already treats a
    // `pending` invitation whose `expiresAt` has passed as not counting,
    // regardless of whether a background job ever flips a status column —
    // this is exactly that mechanism, applied explicitly instead of by
    // waiting for the clock.
    await this.db.query(
      `update account_invitations
          set expires_at = $3
        where account_id = $1 and id = $2 and accepted_at is null and revoked_at is null and expires_at > $3`,
      [tenant.tenantId, invitationId, now],
    );
  }

  async createMemberDirectly(tenant: TenantContext, input: DirectUserCreationInput): Promise<SeatMember> {
    const userId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const now = nowIso();
    await this.withTenantLock(tenant, () =>
      this.db.batch([
        {
          sql: `insert into users (user_id, tenant_id, email, role, email_verified_at, created_at, updated_at)
                values ($1, $2, $3, $4, null, $5, $5)`,
          params: [userId, tenant.tenantId, input.email, input.role, now],
        },
        {
          sql: `insert into memberships (id, account_id, user_id, role, created_at, deactivated_at)
                values ($1, $2, $3, $4, $5, null)`,
          params: [memberId, tenant.tenantId, userId, input.role, now],
        },
      ]),
    );
    return { id: memberId, status: "active", role: input.role, isPlatformStaff: false };
  }

  async reactivateMemberIfSeatAvailable(tenant: TenantContext, memberId: string): Promise<SeatMember | null> {
    return this.withTenantLock(tenant, async () => {
      const { rowCount } = await this.db.query(
        `update memberships
            set deactivated_at = null
          where account_id = $1 and id = $2 and deactivated_at is not null
            and ${activeMemberCountSubquery("$1")} < ${resolvedSeatLimitSubquery("$1")}`,
        [tenant.tenantId, memberId],
      );
      if (rowCount !== 1) return null;

      const { rows } = await this.db.query<Row>(
        `select id, role from memberships where account_id = $1 and id = $2`,
        [tenant.tenantId, memberId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return { id: text(row.id), status: "active", role: toRole(row.role), isPlatformStaff: false };
    });
  }

  async removeMember(tenant: TenantContext, memberId: string): Promise<void> {
    // See file header gap #2 — this is a soft "deactivate"; the schema has
    // no separate hard-removal marker to distinguish from `deactivateMember`.
    await this.db.query(
      `update memberships set deactivated_at = $3 where account_id = $1 and id = $2 and deactivated_at is null`,
      [tenant.tenantId, memberId, nowIso()],
    );
  }

  async getOverSeatLimitState(tenant: TenantContext): Promise<boolean> {
    // See file header gap #1 — computed live every call rather than read
    // from a cached column that does not exist.
    const [config, members, invitations] = await Promise.all([
      this.getSeatLimitConfig(tenant),
      this.listMembers(tenant),
      this.listInvitations(tenant),
    ]);
    const limit = resolveSeatLimit(config);
    const used = countSeats(members, invitations, new Date());
    return computeOverSeatLimitStatus(used, limit).isOverSeatLimit;
  }

  async setOverSeatLimitState(tenant: TenantContext, isOverSeatLimit: boolean): Promise<void> {
    // No-op — see file header gap #1. Parameters kept named (not `_tenant`)
    // to document what a real implementation, backed by a real column,
    // would take.
    void tenant;
    void isOverSeatLimit;
    await Promise.resolve();
  }

  async recordAuditLog(entry: SeatAuditEntry): Promise<void> {
    // `platform_audit_log.platform_role` is NOT NULL, but `SeatAuditEntry`
    // does not carry one (`SeatOverrideContext` only has `actorUserId` +
    // `reason`) — resolved here from the actor's own `platform_admins` grant,
    // which is also the correctness check that the actor genuinely holds a
    // platform role (SEAT_LIMITS.md §5 requires `platform_admin`+ for an
    // override), rather than trusting an unverified value from the caller.
    const { rowCount } = await this.db.query(
      `insert into platform_audit_log
         (id, actor_user_id, platform_role, action, target_account_id, target_resource,
          reason, ip, user_agent, occurred_at, request_id)
       select $1, $2, pa.platform_role, $3, $4, null, $5, null, null, $6, null
         from platform_admins pa
        where pa.user_id = $2 and pa.revoked_at is null`,
      [
        crypto.randomUUID(),
        entry.actorUserId,
        entry.action,
        entry.accountId,
        entry.reason,
        entry.occurredAt.toISOString(),
      ],
    );
    if (rowCount !== 1) {
      throw AppError.forbidden(
        `cannot record a seat-limit audit entry: ${entry.actorUserId} is not a verified platform admin`,
      );
    }
  }

  async recordSeatUsageEvent(event: SeatUsageEvent): Promise<void> {
    await this.db.query(
      `insert into seat_usage_events (id, account_id, delta, reason, actor_user_id, occurred_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        crypto.randomUUID(),
        event.accountId,
        event.delta,
        event.reason,
        event.actorUserId,
        event.occurredAt.toISOString(),
      ],
    );
  }
}
