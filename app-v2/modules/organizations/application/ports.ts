/**
 * SeatRepository — the persistence PORT that SeatService depends on.
 *
 * Interface only. No SQL, no vendor SDK, no `core/database` import — the
 * persistence track implements this against whatever `DatabaseProvider` is
 * chosen (SEAT_LIMITS.md is written against Postgres-shaped tables, but this
 * port makes no assumption about that). See ARCHITECTURE_MODEL.md: business
 * code depends on interfaces only.
 *
 * Where a method is documented as "atomic", the real implementation MUST
 * make it atomic against concurrent callers (a DB transaction / row lock),
 * not merely fast — see the "reserve at invitation / release on
 * expiry-or-revocation" contract in SEAT_LIMITS.md §3, and
 * DATABASE_DECISION.md's contract tests for the credit-wallet hot row, which
 * this is explicitly called out as the same class of problem.
 */
import type { TenantContext } from "@nexara/core/context";
import type { Role } from "@nexara/core/rbac";
import type { UserId } from "@shared/types";
import type { SeatInvitation, SeatMember } from "../domain/seat-usage";
import type { SeatLimitInputs } from "../domain/seat-limit";

/** SEAT_LIMITS.md §2 — the three resolution inputs, read live for one account. */
export type SeatLimitConfig = SeatLimitInputs;

export interface CreateInvitationInput {
  readonly email: string;
  readonly role: Role;
  readonly invitedBy: UserId;
  readonly expiresAt: Date;
}

export interface DirectUserCreationInput {
  readonly email: string;
  readonly role: Role;
}

/** §5 — a mandatory reason from a `platform_admin`+ actor, required to grant
 * a seat-limit override or to bypass the cap for a direct user creation. */
export interface SeatOverrideContext {
  readonly actorUserId: UserId;
  readonly reason: string;
}

/** §5 / §2 `seat_usage_events` — append-only, billing and dispute evidence. */
export interface SeatUsageEvent {
  readonly accountId: string;
  readonly delta: number;
  readonly reason: string;
  readonly actorUserId: UserId | null;
  readonly occurredAt: Date;
}

/** §5 `platform_audit_log` — every override needs a name attached. */
export interface SeatAuditEntry {
  readonly accountId: string;
  readonly actorUserId: UserId;
  readonly action: string;
  readonly reason: string;
  readonly occurredAt: Date;
}

export interface SeatRepository {
  /** §2 — read fresh; never cache across a request (that's how "changing the
   * platform default moves inheriting accounts immediately" holds). */
  getSeatLimitConfig(tenant: TenantContext): Promise<SeatLimitConfig>;

  /** §2 — every membership row for this tenant, active or not (the caller /
   * `countSeats` decide what counts). Tenant-scoped by the implementation. */
  listMembers(tenant: TenantContext): Promise<readonly SeatMember[]>;

  /** §2 — every invitation row for this tenant, any status. Tenant-scoped by
   * the implementation. */
  listInvitations(tenant: TenantContext): Promise<readonly SeatInvitation[]>;

  /**
   * §3 "Create invitation" — ATOMIC: checks the cap and inserts the pending
   * invitation (reserving its seat) as one operation. Returns `null` if no
   * seat was available at the moment of the attempt (never throws for a
   * plain "no seats left" outcome).
   */
  reserveSeatAndCreateInvitation(
    tenant: TenantContext,
    input: CreateInvitationInput,
  ): Promise<SeatInvitation | null>;

  /**
   * §3 "Accept invitation" — ATOMIC re-check-and-accept: verifies a seat is
   * still available (the cap may have been reduced, or another invite
   * accepted first) and, if so, converts the invitation into an active
   * member in the same operation. Returns `null` if no seat was available.
   * MUST be atomic against concurrent accepts of different invitations
   * racing for the same last seat (§7 "two concurrent accepts at cap-1").
   */
  acceptInvitationIfSeatAvailable(
    tenant: TenantContext,
    invitationId: string,
    now: Date,
  ): Promise<SeatMember | null>;

  /** §2 — releases the reserved seat; the invitation stops counting once its
   * status is no longer `pending`. */
  markInvitationExpiredOrRevoked(
    tenant: TenantContext,
    invitationId: string,
    status: "expired" | "revoked",
  ): Promise<void>;

  /**
   * §3 "Direct user creation" — creates a member outright (platform console
   * path). The service is responsible for refusing this at the cap unless an
   * override with a reason is supplied; this method itself performs no cap
   * check, so it must only ever be called after that decision is made.
   */
  createMemberDirectly(tenant: TenantContext, input: DirectUserCreationInput): Promise<SeatMember>;

  /**
   * §3 "Reactivate a deactivated member" — ATOMIC: checks the cap and flips
   * the member back to active in one operation (reactivation consumes a
   * seat). Returns `null` if no seat was available.
   */
  reactivateMemberIfSeatAvailable(tenant: TenantContext, memberId: string): Promise<SeatMember | null>;

  /**
   * §4 — removing (or deactivating) a member frees its seat. Never called
   * for a downgrade by SeatService itself (members are never auto-removed) —
   * this exists for the explicit, human-initiated "remove a member" action
   * that §4.4 says lifts an `over_seat_limit` block.
   */
  removeMember(tenant: TenantContext, memberId: string): Promise<void>;

  /** §4 — the persisted `over_seat_limit` flag for the fleet overview and
   * fast block checks; kept in sync with `computeOverSeatLimitStatus`. */
  getOverSeatLimitState(tenant: TenantContext): Promise<boolean>;
  setOverSeatLimitState(tenant: TenantContext, isOverSeatLimit: boolean): Promise<void>;

  /** §5 — append-only audit trail for overrides. */
  recordAuditLog(entry: SeatAuditEntry): Promise<void>;

  /** §2 — append-only usage/billing evidence. */
  recordSeatUsageEvent(event: SeatUsageEvent): Promise<void>;
}
