/**
 * `POST /api/auth/accept-invite` — closes the invitation loop.
 *
 * PUBLIC: the invitee has no session (there is nobody to attach one to
 * until this call succeeds) and no tenant — only the raw token from the
 * emailed link (`buildInvitationAcceptUrl`, `lib/email-templates.ts`) and a
 * password they are choosing right now. Placed under `/api/auth/*`, which
 * `proxy.ts` already exempts from the session-cookie gate — the same reason
 * `/api/auth/signup` lives there.
 *
 * This is the second half of a gap that used to be total: invitations were
 * created and emailed with a real token, but nothing served
 * `/accept-invite` and, worse, `SqlSeatRepository.acceptInvitationIfSeatAvailable`
 * never created a `credentials` row — an invitee who somehow accepted would
 * hold a membership, consume a seat, and still have no way to log in. Both
 * halves are fixed together, atomically, in
 * `SqlSeatRepository.acceptInvitationByToken` (one `batch()` — see its own
 * doc): the invitation claim, the `users`/`memberships` rows AND the
 * `credentials` row all succeed or all roll back together. This route does
 * no persistence of its own — `AcceptInvitationService`
 * (`modules/organizations/application/accept-invitation-service.ts`) owns
 * password-policy enforcement and hashing, and the repository owns the SQL.
 *
 * Does NOT log the new member in. Same discipline as `/api/auth/signup`:
 * accepting and logging in stay two separate, independently-verifiable
 * requests. No session cookie is set here.
 */
import { NextResponse, type NextRequest } from "next/server";
import { acceptInvitationPublicRequestSchema } from "@packages/contracts/src/invitations";
import { AcceptInvitationService } from "@modules/organizations/application/accept-invitation-service";
import { getBaseServices } from "@/lib/container";
import { fail, internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Before anything else: this route hashes a password (PBKDF2, the same
    // ~6ms-of-CPU cost `checkRateLimit`'s own header documents for login)
    // AND writes four rows per success. Unauthenticated, so an IP-keyed
    // bucket of its own — never shared with login/signup's counters, so a
    // burst here can't lock either of those out, or vice versa.
    const limited = await checkRateLimit(request, "accept-invite");
    if (!limited.allowed) {
      return fail(
        {
          code: "rate_limited",
          laymanMessage: "Too many attempts. Please wait a minute and try again.",
        },
        429,
      );
    }

    const body = parseOrThrow(acceptInvitationPublicRequestSchema, await request.json());
    const { repositories } = await getBaseServices();
    const service = new AcceptInvitationService(repositories.seats);

    const outcome = await service.accept(body.token, body.password);

    if (!outcome.ok) {
      const status =
        outcome.reason === "weak_password"
          ? 400
          : outcome.reason === "email_taken"
            ? 409
            : outcome.reason === "seat_unavailable"
              ? 409
              : 404; // invalid_or_expired
      return fail({ code: outcome.reason, laymanMessage: outcome.message }, status);
    }

    return ok({ email: outcome.email, role: outcome.member.role }, { status: 201 });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
