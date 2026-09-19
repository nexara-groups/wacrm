/**
 * AcceptInvitationService — the self-serve half of the invitation loop.
 *
 * `SeatService.acceptInvitation` (seat-service.ts) already exists, but it
 * takes a `TenantContext` — every caller of it already knows the tenant.
 * The person actually clicking an emailed "accept your invitation" link
 * does not: they have no session and no tenant, only the raw token from
 * the URL. This service is what `POST /api/auth/accept-invite` (the one
 * PUBLIC route this flow needs) calls instead.
 *
 * It is also where the invitee's password enters the system for the first
 * time: they have no credential yet (that is the gap this whole feature
 * closes), so accepting an invitation is the one place a brand-new password
 * is set outside of signup. Same discipline as `SignupService`:
 *   - `checkPassword` (12-char minimum, `modules/identity/domain/password-policy.ts`)
 *     is enforced BEFORE any repository call — a public endpoint gets no
 *     partial credit for an invalid request, and this is cheaper than any
 *     DB round trip.
 *   - Hashing happens HERE, in the service, never in the route and never in
 *     the repository, so `SqlSeatRepository`/`SeatRepository` only ever see
 *     an already-hashed value. PBKDF2 via `hashPassword`, at
 *     `WORKERS_FREE_TIER_ITERATIONS` — never bcrypt (removed deliberately;
 *     see `password-policy.ts`'s header for the Workers CPU-budget math).
 *
 * WHY THIS SERVICE NEVER TOUCHES SQL: `scripts/check-architecture.mjs`
 * rule 2 forbids it outright — everything persistence-shaped goes through
 * `SeatRepository.acceptInvitationByToken` (application/ports.ts), which is
 * also where the actual atomicity guarantee lives (one `batch()` — see that
 * method's implementation in infrastructure/seat-repository.ts).
 */
import { checkPassword } from "@modules/identity/domain/password-policy";
import { hashPassword } from "@modules/identity/domain/token-hashing";
import { WORKERS_FREE_TIER_ITERATIONS } from "@nexara/core/auth/providers/jwt-auth-provider";
import type { SeatMember } from "../domain/seat-usage";
import type { SeatRepository } from "./ports";

export type AcceptInvitationOutcome =
  | {
      readonly ok: true;
      readonly member: SeatMember;
      readonly tenantId: string;
      readonly email: string;
    }
  | {
      readonly ok: false;
      readonly reason: "weak_password";
      /** Friendly, customer-facing copy straight from `checkPassword` — never re-worded here. */
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_or_expired";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: "seat_unavailable";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: "email_taken";
      readonly message: string;
    };

export class AcceptInvitationService {
  constructor(private readonly repository: SeatRepository) {}

  async accept(rawToken: string, password: string, now: Date = new Date()): Promise<AcceptInvitationOutcome> {
    const passwordCheck = checkPassword(password);
    if (!passwordCheck.ok) {
      return { ok: false, reason: "weak_password", message: passwordCheck.laymanMessage };
    }

    // Hashed here, never in the route or the repository — see this file's
    // header. `WORKERS_FREE_TIER_ITERATIONS`, never bcrypt.
    const passwordHash = await hashPassword(password, WORKERS_FREE_TIER_ITERATIONS);

    const result = await this.repository.acceptInvitationByToken(rawToken, passwordHash, now);

    switch (result.kind) {
      case "accepted":
        return { ok: true, member: result.member, tenantId: result.tenantId, email: result.email };
      case "invalid_or_expired":
        return {
          ok: false,
          reason: "invalid_or_expired",
          message: "That invitation link is invalid or has expired. Ask whoever invited you to send a new one.",
        };
      case "seat_unavailable":
        return {
          ok: false,
          reason: "seat_unavailable",
          message: "This team is at its seat limit right now. Ask an admin to free up a seat and try again.",
        };
      case "email_taken":
        return {
          ok: false,
          reason: "email_taken",
          message: "An account with that email address already exists. Try logging in instead.",
        };
    }
  }
}
