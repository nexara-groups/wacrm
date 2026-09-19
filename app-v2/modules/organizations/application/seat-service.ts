/**
 * SeatService — SEAT_LIMITS.md §3 "Enforcement".
 *
 * "One authority, checked at every write path. A cap enforced only in the UI
 * is not a cap." Every write path that can add a seat goes through this
 * service; the service never touches SQL — it authorizes, then delegates the
 * actual read/write to the `SeatRepository` port (application/ports.ts).
 */
import { type Result, ok, err } from "@shared/result";
import { AppError } from "@shared/errors";
import type { TenantContext } from "@nexara/core/context";
import { resolveSeatLimit } from "../domain/seat-limit";
import { countSeats, type SeatInvitation, type SeatMember } from "../domain/seat-usage";
import { computeOverSeatLimitStatus, blocksNewInvitations } from "../domain/over-seat-limit";
import { SEAT_MESSAGES } from "../domain/seat-messages";
import type {
  CreateInvitationInput,
  DirectUserCreationInput,
  ReservedInvitation,
  SeatOverrideContext,
  SeatRepository,
} from "./ports";

/**
 * The error `assertCanAddSeat` (and every write path built on it) returns
 * when there is no free seat. Extends `AppError` (code `CONFLICT`) so it
 * flows through the shared `Result`/`AppError` plumbing everywhere else, but
 * carries the numbers the UI needs to render the §3 plain-English messages
 * without a second round trip.
 */
export class SeatLimitExceeded extends AppError {
  readonly seatLimit: number;
  readonly seatsUsed: number;

  constructor(message: string, seatLimit: number, seatsUsed: number) {
    super("CONFLICT", message);
    this.name = "SeatLimitExceeded";
    this.seatLimit = seatLimit;
    this.seatsUsed = seatsUsed;
  }
}

export interface SeatServiceDeps {
  readonly repository: SeatRepository;
  /** Injectable clock for deterministic tests; defaults to `() => new Date()`. */
  readonly clock?: () => Date;
}

export class SeatService {
  private readonly repository: SeatRepository;
  private readonly clock: () => Date;

  constructor(deps: SeatServiceDeps) {
    this.repository = deps.repository;
    this.clock = deps.clock ?? (() => new Date());
  }

  /** §2 resolution, for one account, read fresh every call. */
  async resolveLimit(tenant: TenantContext): Promise<number> {
    const config = await this.repository.getSeatLimitConfig(tenant);
    return resolveSeatLimit(config);
  }

  /** §2 usage, for one account, read fresh every call. */
  async usedSeats(tenant: TenantContext): Promise<number> {
    const [members, invitations]: [readonly SeatMember[], readonly SeatInvitation[]] = await Promise.all([
      this.repository.listMembers(tenant),
      this.repository.listInvitations(tenant),
    ]);
    return countSeats(members, invitations, this.clock());
  }

  /**
   * §3 — the one authority every write path calls before consuming a seat.
   * Non-atomic by itself (a plain read-then-decide) — callers that actually
   * reserve/consume a seat MUST use one of the repository's atomic
   * `*IfSeatAvailable` / `reserveSeatAnd*` methods for the real check, and
   * treat this method as a fast pre-check / UI hint only. See
   * `createInvitation` and `acceptInvitation` below for why: this method
   * alone cannot close the race between two concurrent callers.
   */
  async assertCanAddSeat(tenant: TenantContext): Promise<Result<void, SeatLimitExceeded>> {
    const [isOverSeatLimitFlag, seatLimit, seatsUsed] = await Promise.all([
      this.repository.getOverSeatLimitState(tenant),
      this.resolveLimit(tenant),
      this.usedSeats(tenant),
    ]);

    // §4.3: a persisted over_seat_limit account blocks growth outright, even
    // if a stale read of usage would otherwise look like it has room.
    const status = computeOverSeatLimitStatus(seatsUsed, seatLimit);
    if (isOverSeatLimitFlag || blocksNewInvitations(status)) {
      return err(new SeatLimitExceeded(SEAT_MESSAGES.atCap(seatLimit), seatLimit, seatsUsed));
    }

    // §3: the ordinary "no free seats left" case — usage has reached the cap.
    if (seatsUsed >= seatLimit) {
      return err(new SeatLimitExceeded(SEAT_MESSAGES.atCap(seatLimit), seatLimit, seatsUsed));
    }

    return ok(undefined);
  }

  /**
   * §3 "Create invitation". Reserves the seat at invitation time (§2:
   * "Reserve the seat at invitation, release it on expiry or revocation").
   * The pre-check gives a fast, friendly refusal in the common case; the
   * actual seat consumption happens in the atomic
   * `reserveSeatAndCreateInvitation` call, which is the real cap
   * enforcement — it is what makes this safe under concurrent invites.
   */
  async createInvitation(
    tenant: TenantContext,
    input: CreateInvitationInput,
  ): Promise<Result<ReservedInvitation, SeatLimitExceeded>> {
    const precheck = await this.assertCanAddSeat(tenant);
    if (!precheck.ok) return precheck;

    const reserved = await this.repository.reserveSeatAndCreateInvitation(tenant, input);
    if (reserved === null) {
      return err(await this.seatLimitExceeded(tenant, "atCap"));
    }

    await this.repository.recordSeatUsageEvent({
      accountId: tenant.tenantId,
      delta: 1,
      reason: "invitation_created",
      actorUserId: input.invitedBy,
      occurredAt: this.clock(),
    });
    return ok(reserved);
  }

  /**
   * §3 "Accept invitation" — THE MOST COMMONLY MISSED RULE. The cap must be
   * RE-CHECKED here, not trusted from invitation time: the limit may have
   * been lowered since, or another invitation may have been accepted first.
   * This method performs no pre-check of its own and goes straight to the
   * atomic `acceptInvitationIfSeatAvailable` — there is deliberately no
   * "assertCanAddSeat then accept" sequence here, because that would
   * reintroduce exactly the TOCTOU race §3 warns about ("at 2 of 3 seats
   * used, two invitations both accepted is 4 seats without it").
   */
  async acceptInvitation(
    tenant: TenantContext,
    rawToken: string,
  ): Promise<Result<SeatMember, SeatLimitExceeded>> {
    const member = await this.repository.acceptInvitationIfSeatAvailable(tenant, rawToken, this.clock());
    if (member === null) {
      return err(await this.seatLimitExceeded(tenant, "acceptFailedCapReached"));
    }
    return ok(member);
  }

  /**
   * §3 "Direct user creation (platform console)". Refused at the cap unless
   * the actor supplies a mandatory `reason` — in which case the cap is
   * bypassed but the action is always audited (§5: "Why does this account
   * have 25 seats when the default is 3 must always have an answer with a
   * name attached").
   */
  async directUserCreation(
    tenant: TenantContext,
    input: DirectUserCreationInput,
    override?: SeatOverrideContext,
  ): Promise<Result<SeatMember, SeatLimitExceeded | AppError>> {
    const precheck = await this.assertCanAddSeat(tenant);

    if (!precheck.ok) {
      if (!override || override.reason.trim().length === 0) {
        return err(precheck.error);
      }
      const member = await this.repository.createMemberDirectly(tenant, input);
      const occurredAt = this.clock();
      await this.repository.recordAuditLog({
        accountId: tenant.tenantId,
        actorUserId: override.actorUserId,
        action: "seat_limit_override_direct_user_creation",
        reason: override.reason,
        occurredAt,
      });
      await this.repository.recordSeatUsageEvent({
        accountId: tenant.tenantId,
        delta: 1,
        reason: override.reason,
        actorUserId: override.actorUserId,
        occurredAt,
      });
      return ok(member);
    }

    const member = await this.repository.createMemberDirectly(tenant, input);
    await this.repository.recordSeatUsageEvent({
      accountId: tenant.tenantId,
      delta: 1,
      reason: "direct_user_creation",
      actorUserId: override?.actorUserId ?? null,
      occurredAt: this.clock(),
    });
    return ok(member);
  }

  /**
   * §3 "Reactivate a deactivated member" — refused if at cap; reactivation
   * consumes a seat exactly like a new invitation would. Also refused
   * outright while the account is `over_seat_limit` (§4.3).
   */
  async reactivateMember(
    tenant: TenantContext,
    memberId: string,
  ): Promise<Result<SeatMember, SeatLimitExceeded>> {
    const isOverSeatLimit = await this.repository.getOverSeatLimitState(tenant);
    if (isOverSeatLimit) {
      return err(await this.seatLimitExceeded(tenant, "atCap"));
    }

    const reactivated = await this.repository.reactivateMemberIfSeatAvailable(tenant, memberId);
    if (reactivated === null) {
      return err(await this.seatLimitExceeded(tenant, "atCap"));
    }

    await this.repository.recordSeatUsageEvent({
      accountId: tenant.tenantId,
      delta: 1,
      reason: "member_reactivated",
      actorUserId: null,
      occurredAt: this.clock(),
    });
    return ok(reactivated);
  }

  /**
   * §4 "Downgrade". Never removes a member — it only (re)derives whether the
   * account is now `over_seat_limit` from current usage vs. the newly
   * resolved limit, and persists that projection. Call this after a plan
   * change (or an override change) that could move the resolved limit down.
   */
  async recomputeOverSeatLimitState(tenant: TenantContext): Promise<boolean> {
    const [seatLimit, seatsUsed] = await Promise.all([this.resolveLimit(tenant), this.usedSeats(tenant)]);
    const status = computeOverSeatLimitStatus(seatsUsed, seatLimit);
    await this.repository.setOverSeatLimitState(tenant, status.isOverSeatLimit);
    return status.isOverSeatLimit;
  }

  /**
   * §4.4 "Removing a member decrements usage; the block lifts at the cap."
   * The member removal itself is a separate, human-initiated action (never
   * triggered by a downgrade) — this wraps it with the self-clearing
   * recompute so the caller doesn't have to remember to do both.
   */
  async removeMemberAndRecompute(tenant: TenantContext, memberId: string): Promise<boolean> {
    await this.repository.removeMember(tenant, memberId);
    await this.repository.recordSeatUsageEvent({
      accountId: tenant.tenantId,
      delta: -1,
      reason: "member_removed",
      actorUserId: null,
      occurredAt: this.clock(),
    });
    return this.recomputeOverSeatLimitState(tenant);
  }

  private async seatLimitExceeded(
    tenant: TenantContext,
    situation: "atCap" | "acceptFailedCapReached",
  ): Promise<SeatLimitExceeded> {
    const [seatLimit, seatsUsed] = await Promise.all([this.resolveLimit(tenant), this.usedSeats(tenant)]);
    const message =
      situation === "atCap" ? SEAT_MESSAGES.atCap(seatLimit) : SEAT_MESSAGES.acceptFailedCapReached;
    return new SeatLimitExceeded(message, seatLimit, seatsUsed);
  }
}
