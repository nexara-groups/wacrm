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

/**
 * A freshly reserved invitation plus its one-time raw token.
 *
 * Split from `SeatInvitation` deliberately: every READ of an invitation
 * returns `SeatInvitation`, which has no token field, so there is no shape
 * in which a stored token can be handed back. The raw value exists only in
 * the return of the call that created it.
 */
export interface ReservedInvitation {
  readonly invitation: SeatInvitation;
  /** High-entropy, opaque. Only its `hashToken` digest is persisted. */
  readonly token: string;
}

/**
 * Outcome of `acceptInvitationByToken`. Unlike `acceptInvitationIfSeatAvailable`
 * (a public, unauthenticated caller needs to hear a specific, actionable
 * reason back — "email already taken" is not "try again later"), this is a
 * discriminated union rather than a bare `null`:
 *   - `invalid_or_expired`: no invitation matches the token, or the one
 *     that does is no longer pending (already accepted, revoked, or past
 *     `expires_at`).
 *   - `seat_unavailable`: SEAT_LIMITS.md §3's re-check-at-accept-time cap —
 *     the limit may have been lowered, or another invitation accepted
 *     first, since this one was sent.
 *   - `email_taken`: `credentials.email` is globally unique
 *     (0013_global_email_uniqueness.sql) and the invitee's address already
 *     has one, elsewhere. Reported, never thrown — same pattern
 *     `SignupRepository.createTenant` uses for the identical constraint.
 */
export type AcceptInvitationByTokenResult =
  | {
      readonly kind: "accepted";
      readonly member: SeatMember;
      /** The tenant the invitation belonged to — the caller had no way to
       * know this in advance (that's the whole reason the lookup is
       * cross-tenant), so it comes back here. */
      readonly tenantId: string;
      /** The invitation row's own stored address — never the request's. */
      readonly email: string;
    }
  | { readonly kind: "invalid_or_expired" }
  | { readonly kind: "seat_unavailable" }
  | { readonly kind: "email_taken" };

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
   *
   * Returns the raw invitation token alongside the row, and this is the ONLY
   * moment it exists in readable form — only its hash is stored. Hand it to
   * the invitee (a link in an email); it cannot be recovered afterwards,
   * which is the point.
   */
  reserveSeatAndCreateInvitation(
    tenant: TenantContext,
    input: CreateInvitationInput,
  ): Promise<ReservedInvitation | null>;

  /**
   * §3 "Accept invitation" — takes the RAW TOKEN, never an invitation id.
   *
   * An invitation id is an identifier, not a credential: it appears in
   * listings, in URLs and in logs, and accepting an invitation creates a
   * user with a role inside someone's account. Keying this on the token
   * means holding the emailed secret is the only way to accept, and the
   * secret is never stored in recoverable form.
   *
   * ATOMIC re-check-and-accept: verifies a seat is
   * still available (the cap may have been reduced, or another invite
   * accepted first) and, if so, converts the invitation into an active
   * member in the same operation. Returns `null` if no seat was available.
   * MUST be atomic against concurrent accepts of different invitations
   * racing for the same last seat (§7 "two concurrent accepts at cap-1").
   */
  acceptInvitationIfSeatAvailable(
    tenant: TenantContext,
    rawToken: string,
    now: Date,
  ): Promise<SeatMember | null>;

  /**
   * §3 "Accept invitation" — the PUBLIC, self-serve variant used by the
   * `/accept-invite` flow (an emailed link, no session).
   *
   * `acceptInvitationIfSeatAvailable` above takes a `TenantContext` because
   * every OTHER caller of it already knows the tenant. An invitee clicking
   * a link in their inbox does not: they hold only the raw token, so this
   * method resolves the tenant FROM the token itself — necessarily a
   * cross-tenant lookup, bounded to at most one row by
   * `account_invitations`' `UNIQUE(token_hash)` index
   * (0002_organizations.sql), the same shape of lookup as
   * `CredentialsRepository.findByEmailAnyTenant` /
   * `findUsableEmailVerificationAnyTenant`.
   *
   * Also creates the invitee's `credentials` row, in the SAME atomic
   * operation as the accept — an invitee has no credential yet (that is
   * the whole gap this closes), and doing it in a second, separate write
   * would let a seat be consumed by someone who still cannot log in if
   * that second write ever failed. `passwordHash` is already hashed by the
   * caller (PBKDF2 via `hashPassword`, `WORKERS_FREE_TIER_ITERATIONS`) —
   * this port never sees a raw password, same discipline as
   * `CreateTenantInput.passwordHash`. The credential's email is always the
   * invitation row's own stored address — the caller never supplies one —
   * so a token can never be redeemed under a different address than it was
   * sent to.
   *
   * Returns a discriminated result rather than throwing for every ordinary
   * outcome (see `AcceptInvitationByTokenResult`'s own doc): an unknown or
   * already-used token, a cap reached since the invite was sent, and the
   * invitee's address already having a credential elsewhere are all
   * expected results of a public endpoint, not exceptions.
   */
  acceptInvitationByToken(
    rawToken: string,
    passwordHash: string,
    now: Date,
  ): Promise<AcceptInvitationByTokenResult>;

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

// ---------------------------------------------------------------------------
// Signup — the ONE place a brand-new tenant is created. No `TenantContext`
// parameter anywhere here: there is no tenant yet, this port is what MAKES
// one, and every id it needs is generated by the caller (SignupService),
// never taken from a request (a client-supplied tenant id would let someone
// join or overwrite an existing tenant).
// ---------------------------------------------------------------------------

/**
 * Everything needed to create a tenant and its owner in one shot. All ids
 * and the password hash are already computed by `SignupService` — this
 * port only persists them, atomically.
 */
export interface CreateTenantInput {
  readonly accountId: string;
  readonly accountName: string;
  readonly ownerUserId: string;
  /** `users.display_name` — nullable in the schema, so a missing name stays missing rather than fabricated. */
  readonly ownerName: string | null;
  readonly membershipId: string;
  /** Already normalized (trimmed, lower-cased) by the service. */
  readonly email: string;
  /** Already hashed (PBKDF2, `WORKERS_FREE_TIER_ITERATIONS`) by the service — this port never sees a raw password. */
  readonly passwordHash: string;
  readonly now: Date;
  /**
   * Whether the owner's `credentials`/`users` rows are created already
   * verified. Optional and defaults to `true` (the original, pre-email
   * behavior) so every existing caller/test that never set this keeps
   * working unchanged.
   *
   * `false` is what a caller uses once it can actually deliver a
   * verification email (`SignupService`'s caller decides this — see
   * `app/api/auth/signup/route.ts` — never this port or its
   * implementation, which have no idea whether email can send): the owner
   * is created with `verified_at`/`email_verified_at` both `null`, and
   * `JwtAuthProvider.login` refuses them until they redeem a verification
   * token. Forcing this to `false` unconditionally would mean nobody could
   * ever sign up on a deployment with no email provider configured — see
   * this port's own file header history for why that was the ORIGINAL
   * reason `true` was the only behavior that ever existed here.
   */
  readonly autoVerifyEmail?: boolean;
}

export type CreateTenantResult =
  | { readonly kind: "created" }
  /**
   * `credentials.email` is globally unique (0013_global_email_uniqueness.sql).
   * Returned instead of thrown for the same reason
   * `reserveSeatAndCreateInvitation` returns `null` for "no seat left": an
   * expected, ordinary outcome of a public endpoint, not an exceptional one.
   */
  | { readonly kind: "email_taken" };

export interface SignupRepository {
  /**
   * Creates the `accounts` row (tenant root), the `users` row (owner
   * identity), the `credentials` row (owner login) and the `memberships`
   * row (owner seat, role `owner`) — ALL FOUR OR NONE. See this port's
   * implementation (infrastructure/signup-repository.ts) for how the
   * "or none" half is guaranteed.
   */
  createTenant(input: CreateTenantInput): Promise<CreateTenantResult>;
}

// ---------------------------------------------------------------------------
// Account directory — the one place the platform enumerates EVERY tenant.
// No `TenantContext` parameter, same as `SignupRepository`: there is no
// single tenant to scope this to, by design. Exists for jobs that must walk
// every account (today: the nightly message-retention sweep,
// apps/web/lib/retention-sweep.ts) without ever loading them all at once —
// see `listAccountIds`'s own doc for the paging contract.
// ---------------------------------------------------------------------------

export interface AccountIdPage {
  readonly accountIds: readonly string[];
  /** Pass back as `cursor` to fetch the next page. `null` at the end. */
  readonly nextCursor: string | null;
}

export interface AccountDirectory {
  /**
   * One page of `accounts.id`, ordered by `id` ascending, keyset-paginated
   * (never `OFFSET`, never a full-table load). `cursor` is the previous
   * page's `nextCursor`; `null`/omitted starts from the beginning.
   *
   * Row reads are metered same as writes, so `limit` bounds this exactly
   * like `sweepExpiredMessages`'s `maxDeletes` bounds a sweep — a caller
   * walking the whole fleet does it one bounded page at a time.
   */
  listAccountIds(cursor: string | null, limit: number): Promise<AccountIdPage>;
}
