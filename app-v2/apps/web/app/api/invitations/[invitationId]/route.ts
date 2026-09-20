/**
 * `DELETE /api/invitations/[invitationId]` — revoke a pending invitation
 * (SEAT_LIMITS.md §2: "Reserve the seat at invitation, release it on expiry
 * or revocation"). Matches `revokeInvitationResponseSchema`'s empty-payload
 * shape (`apiResult({})`).
 *
 * Per hard rule 6, `invitationId` being a well-formed opaque id is not
 * proof it belongs to this account — this looks it up in
 * `repositories.seats.listInvitations(tenant)` (tenant-scoped) before
 * acting, so a stranger's id 404s instead of the repository's own
 * `WHERE account_id = ...` guard silently no-op'ing into a misleading 200.
 */
import { NextResponse, type NextRequest } from "next/server";
import { opaqueIdSchema } from "@packages/contracts/src/common/ids";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
import {
  internalError,
  isZodError,
  notFoundError,
  ok,
  parseOrThrow,
  validationError,
} from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ invitationId: string }>;
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const authorized = await authorizeAction("invitations:revoke");
    if (!authorized.ok) return authorized.response;

    const { invitationId: raw } = await context.params;
    const invitationId = parseOrThrow(opaqueIdSchema, raw);

    const { repositories, tenant } = await getContainer();
    const invitations = await repositories.seats.listInvitations(tenant);
    const invitation = invitations.find((i) => i.id === invitationId);
    if (invitation === undefined) return notFoundError("invitation");

    await repositories.seats.markInvitationExpiredOrRevoked(tenant, invitationId, "revoked");

    return ok({});
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
