/**
 * `GET /api/members` — active/deactivated members AND pending invitations
 * for `/settings/team`, matching `listMembersResponseSchema`
 * (`@packages/contracts/src/invitations`): SEAT_LIMITS.md §2 treats the two
 * as one "who's using a seat" list, so the response bundles both.
 *
 * `SeatRepository.listMembers` (modules/organizations/application/ports.ts)
 * returns every membership row for the tenant with NO native pagination —
 * same page/no-cursor mismatch `/api/conversations`'s own header documents
 * for its port. Resolution taken here is the identical shape: read the
 * whole (tenant-scoped, so bounded by team size, never message/contact
 * volume) list, then paginate in memory so `page`/`pageSize`/`total` stay
 * real numbers on the wire, never a leaked cursor.
 *
 * See `lib/seat-dto.ts`'s header for the PORT GAP this route inherits:
 * `SeatMember`/`SeatInvitation` do not carry `userId`/`joinedAt`/invitation
 * `email`/`role`/`invitedBy` — those fields are documented placeholders
 * below, not real data.
 */
import { NextResponse, type NextRequest } from "next/server";
import { listMembersQuerySchema } from "@packages/contracts/src/invitations";
import { paginationRange } from "@shared/pagination";
import { getContainer } from "@/lib/container";
import { toAccountMemberDTO, toListedInvitationDTO } from "@/lib/seat-dto";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";

/** GAP fallback for `Invitation.createdAt` — see lib/seat-dto.ts. Matches the
 * TTL this app itself uses when creating an invitation (app/api/invitations/route.ts). */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(listMembersQuerySchema, {
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
    });

    const { repositories, tenant } = await getContainer();
    const [members, invitations] = await Promise.all([
      repositories.seats.listMembers(tenant),
      repositories.seats.listInvitations(tenant),
    ]);

    const total = members.length;
    const start = (query.page - 1) * query.pageSize;
    const pageItems = members.slice(start, start + query.pageSize);
    const range = paginationRange(total, query.page, query.pageSize, pageItems.length);

    const pendingInvitations = invitations
      .filter((invitation) => invitation.status === "pending")
      .map((invitation) => {
        const createdAtFallback = invitation.expiresAt
          ? new Date(invitation.expiresAt.getTime() - INVITATION_TTL_MS).toISOString()
          : new Date().toISOString();
        return toListedInvitationDTO(tenant.tenantId, invitation, createdAtFallback);
      });

    return ok({
      items: pageItems.map((member) => toAccountMemberDTO(tenant.tenantId, member)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: range.totalPages,
        from: range.from,
        to: range.to,
        hasPrevious: range.hasPrevious,
        hasNext: range.hasNext,
      },
      pendingInvitations,
    });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
