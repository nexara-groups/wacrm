/**
 * `/api/invitations` — list (`GET`) and invite (`POST`).
 *
 * `POST` is the primary seat-cap enforcement point (SEAT_LIMITS.md §3
 * "Create invitation"): it calls `SeatService.createInvitation`, never
 * reimplements the cap check. Hitting the cap is a normal outcome
 * (`reserveSeatAndCreateInvitation` returns `null`, `SeatService` turns
 * that into a `SeatLimitExceeded`), surfaced through the shared error
 * envelope via `lib/seat-dto.ts#seatLimitExceededResponse` — never a raw
 * 500, and never a bespoke error shape.
 *
 * `GET` has no dedicated response schema in `@packages/contracts` (only
 * `listMembersResponseSchema`, which bundles invitations WITH members for
 * `/api/members`) — this returns the same `{ items, pagination }` shape
 * `paginatedResponseSchema` produces, with each item still validated
 * through `invitationSchema` (`lib/seat-dto.ts#toListedInvitationDTO`), so
 * drift in the item shape itself still fails loudly even without a
 * dedicated envelope schema for this specific endpoint.
 */
import { NextResponse, type NextRequest } from "next/server";
import { inviteMemberRequestSchema } from "@packages/contracts/src/invitations";
import { paginationQuerySchema } from "@packages/contracts/src/common/pagination";
import { paginationRange } from "@shared/pagination";
import { SeatService } from "@modules/organizations/application/seat-service";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
import { toFreshInvitationDTO, toListedInvitationDTO, seatLimitExceededResponse } from "@/lib/seat-dto";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";
import { sendInvitationEmail } from "@/lib/invitation-email";
import { buildInvitationAcceptUrl } from "@/lib/email-templates";

/** Invitation lifetime — not in SEAT_LIMITS.md's schema as a configured
 * value, so a fixed, documented default is used (also relied on as the
 * `createdAt` back-derivation fallback for listed invitations — see
 * `app/api/members/route.ts`). */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(paginationQuerySchema, {
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
    });

    const { repositories, tenant } = await getContainer();
    const invitations = await repositories.seats.listInvitations(tenant);

    const total = invitations.length;
    const start = (query.page - 1) * query.pageSize;
    const pageItems = invitations.slice(start, start + query.pageSize);
    const range = paginationRange(total, query.page, query.pageSize, pageItems.length);

    return ok({
      items: pageItems.map((invitation) => {
        const createdAtFallback = invitation.expiresAt
          ? new Date(invitation.expiresAt.getTime() - INVITATION_TTL_MS).toISOString()
          : new Date().toISOString();
        return toListedInvitationDTO(tenant.tenantId, invitation, createdAtFallback);
      }),
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
    });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const authorized = await authorizeAction("seats:invite");
    if (!authorized.ok) return authorized.response;

    const body = parseOrThrow(inviteMemberRequestSchema, await request.json());

    const { repositories, tenant, ownerUserId, emailProvider } = await getContainer();
    const seatService = new SeatService({ repository: repositories.seats });

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + INVITATION_TTL_MS);

    const result = await seatService.createInvitation(tenant, {
      email: body.email,
      role: body.role,
      invitedBy: ownerUserId,
      expiresAt,
    });
    if (!result.ok) return seatLimitExceededResponse(result.error);

    const invitation = toFreshInvitationDTO(
      tenant.tenantId,
      result.value.invitation,
      body.email,
      body.role,
      ownerUserId,
      createdAt.toISOString(),
    );

    // The raw token is returned exactly once, here, because only its hash is
    // stored and there is no way to recover it afterwards. It belongs in the
    // invite email, sent right below; it is ALSO included in this response
    // so an operator can resend it by hand — a legitimate fallback while
    // email delivery is new — regardless of whether the email actually went
    // out. Nothing that LISTS invitations returns it — `toListedInvitationDTO`
    // has no token field.
    //
    // A failed send does NOT fail this request: the invitation row already
    // exists (recoverable — an operator can still hand the token over), so
    // reporting `emailSent: false` here is strictly better than either a
    // false "it's sent" or discarding a perfectly good invitation over a
    // transport hiccup.
    const { emailSent, emailError } = await sendInvitationEmail({
      emailProvider,
      to: body.email,
      role: body.role,
      acceptUrl: buildInvitationAcceptUrl(result.value.token),
    });

    return ok(
      {
        invitation,
        token: result.value.token,
        emailSent,
        ...(emailError ? { emailError } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
