/**
 * `/api/members/[memberId]` — remove (`DELETE`) / reactivate (`PATCH`) one
 * member. Neither action has a dedicated request/response schema in
 * `@packages/contracts/src/invitations` (only the `accountMemberSchema`
 * item shape and `revokeInvitationResponseSchema`'s empty-payload pattern
 * exist) — same situation `/api/conversations/[conversationId]`'s own
 * header documents for its own resource, resolved the same way: reuse the
 * existing item schema (`member: accountMemberSchema`-shaped) for a
 * response that returns one, and the empty `{ ok: true }` shape for one
 * that does not.
 *
 * `memberId` is a membership row id (opaque, not one of `@packages/domain`'s
 * branded ids — see `lib/seat-dto.ts`'s header). Per this task's hard rule
 * 6 ("validating shape is not validating authority"), a well-formed id is
 * not proof this membership belongs to the caller's account: both handlers
 * look the membership up in `repositories.seats.listMembers(tenant)` (a
 * tenant-scoped read) BEFORE acting on it, rather than trusting the id and
 * letting the repository's own `WHERE account_id = ...` guard fail silently
 * into a misleading 200.
 */
import { NextResponse, type NextRequest } from "next/server";
import { opaqueIdSchema } from "@packages/contracts/src/common/ids";
import { SeatService } from "@modules/organizations/application/seat-service";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
import { toAccountMemberDTO, seatLimitExceededResponse } from "@/lib/seat-dto";
import {
  fail,
  internalError,
  isZodError,
  notFoundError,
  ok,
  parseOrThrow,
  validationError,
} from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ memberId: string }>;
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const authorized = await authorizeAction("members:remove");
    if (!authorized.ok) return authorized.response;

    const { memberId: raw } = await context.params;
    const memberId = parseOrThrow(opaqueIdSchema, raw);

    const { repositories, tenant } = await getContainer();
    const members = await repositories.seats.listMembers(tenant);
    const member = members.find((m) => m.id === memberId);
    if (member === undefined) return notFoundError("member");

    // Losing the only owner would orphan the account; SEAT_LIMITS.md has no
    // provision for that, so this is refused rather than silently allowed.
    if (member.role === "owner") {
      return fail(
        {
          code: "cannot_remove_owner",
          laymanMessage: "The account owner can't be removed.",
        },
        409,
      );
    }

    const seatService = new SeatService({ repository: repositories.seats });
    await seatService.removeMemberAndRecompute(tenant, memberId);

    return ok({});
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}

export async function PATCH(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    // Reactivation consumes a seat, the same spend an invitation makes — so
    // it sits with the rest of the seat-spending actions, not below them.
    const authorized = await authorizeAction("members:reactivate");
    if (!authorized.ok) return authorized.response;

    const { memberId: raw } = await context.params;
    const memberId = parseOrThrow(opaqueIdSchema, raw);

    const { repositories, tenant } = await getContainer();
    const members = await repositories.seats.listMembers(tenant);
    const member = members.find((m) => m.id === memberId);
    if (member === undefined) return notFoundError("member");

    if (member.status !== "deactivated") {
      return fail(
        {
          code: "member_not_deactivated",
          laymanMessage: "This member is already active.",
        },
        409,
      );
    }

    // §3 "Reactivate a deactivated member" — reactivation consumes a seat,
    // so SeatService is the one authority, not a plain repository flip.
    const seatService = new SeatService({ repository: repositories.seats });
    const result = await seatService.reactivateMember(tenant, memberId);
    if (!result.ok) return seatLimitExceededResponse(result.error);

    return ok({ member: toAccountMemberDTO(tenant.tenantId, result.value) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
