/**
 * Demo data for the team slice — seeded close enough to the platform
 * default cap (3 seats) to be interesting: the owner, one other active
 * member, one pending invitation (together = 3/3, AT the cap so the
 * `/settings/team` screen's refusal path is immediately visible), and one
 * revoked invitation to make SEAT_LIMITS.md §2's "does not count" rule
 * visible rather than theoretical.
 *
 * Every row goes through the real `SeatRepository`
 * (`repositories.seats`, `modules/organizations`) EXCEPT the owner's own
 * membership row — see the comment at that call site for why `ctx.database`
 * is used there instead.
 *
 * Order matters, and is deliberately NOT "owner, member, pending, revoked":
 * `reserveSeatAndCreateInvitation` is cap-gated (SEAT_LIMITS.md §3), so the
 * invitation meant to end up revoked is created and revoked BEFORE the seat
 * count reaches 3 — reserving it after the real pending invitation would
 * find no seat left and seed nothing to revoke.
 */
import type { SeedContext } from "./types";

export async function seedTeam(ctx: SeedContext): Promise<void> {
  const { repositories, tenant, ownerUserId, now, database } = ctx;

  // GAP (see lib/seat-dto.ts's own header for the live-route side of this):
  // `SeatRepository` has no method to attach an ALREADY-EXISTING user (the
  // owner, inserted directly into `users` by lib/container.ts's `build()`,
  // outside any repository) as a member — `createMemberDirectly` always
  // creates a NEW `users` row too, which would duplicate the owner's
  // identity. `memberships` has no repository of its own at all. This is
  // exactly the "rows no repository owns" case `ctx.database` exists for.
  await database.query(
    `insert into memberships (id, account_id, user_id, role, created_at, deactivated_at)
     values ($1, $2, $3, 'owner', $4, null)`,
    [crypto.randomUUID(), tenant.tenantId, ownerUserId, now],
  );

  const seats = repositories.seats;

  // Second active member — a real repository call, unlike the owner above.
  await seats.createMemberDirectly(tenant, {
    email: "priya.manager@demo.test",
    role: "manager",
  });

  // A doomed invitation, created and immediately revoked, purely to seed
  // the "revoked invitations release their seat" fact (SEAT_LIMITS.md §2)
  // as something visible on the screen rather than asserted only in tests.
  // Must happen BEFORE the pending invitation below reserves the account's
  // last free seat.
  const revokedTtlMs = 3 * 24 * 60 * 60 * 1000;
  const doomed = await seats.reserveSeatAndCreateInvitation(tenant, {
    email: "expired.applicant@demo.test",
    role: "member",
    invitedBy: ownerUserId,
    expiresAt: new Date(new Date(now).getTime() + revokedTtlMs),
  });
  if (doomed === null) {
    throw new Error(
      "seedTeam: expected a free seat for the doomed invitation (owner + 1 member = 2/3) — seat accounting drifted",
    );
  }
  await seats.markInvitationExpiredOrRevoked(tenant, doomed.id, "revoked");

  // The real pending invitation — brings usage to 3/3 (AT the platform
  // default cap), demonstrating the invited-not-yet-accepted case that
  // SEAT_LIMITS.md §2 says must reserve a seat.
  const pendingTtlMs = 7 * 24 * 60 * 60 * 1000;
  const pending = await seats.reserveSeatAndCreateInvitation(tenant, {
    email: "amit.agent@demo.test",
    role: "member",
    invitedBy: ownerUserId,
    expiresAt: new Date(new Date(now).getTime() + pendingTtlMs),
  });
  if (pending === null) {
    throw new Error(
      "seedTeam: expected a free seat for the demo pending invitation (owner + 1 member + 1 revoked-then-freed = 2/3) — seat accounting drifted",
    );
  }
}
