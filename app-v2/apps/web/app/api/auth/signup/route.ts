/**
 * `POST /api/auth/signup` — the front door. Creates a brand-new tenant and
 * its owner, atomically, and asks for nothing this handler didn't validate
 * itself: nobody has a session yet (this route is PUBLIC — see `proxy.ts`,
 * which already exempts every `/api/auth/*` path), so there is no tenant to
 * read from a cookie and none is ever accepted from the request body.
 *
 * Same discipline as `/api/auth/login` and `/api/contacts`: the request is
 * validated against its zod contract (`signupRequestSchema`) before
 * anything else runs, and every failure goes out through the shared error
 * envelope.
 *
 * This does NOT log the new owner in. It deliberately returns no session
 * cookie and no access token — signup and login are kept as two separate,
 * independently-verifiable steps (see the task's own verification list:
 * "a successful signup, an immediate login as the new owner" as two
 * requests), and it means this route never has to duplicate
 * `JwtAuthProvider`'s session-issuing logic.
 */
import { NextResponse, type NextRequest } from "next/server";
import { signupRequestSchema } from "@packages/contracts/src/auth";
import { getBaseServices } from "@/lib/container";
import { SignupService } from "@modules/organizations/application/signup-service";
import { fail, internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = parseOrThrow(signupRequestSchema, await request.json());
    const { repositories } = await getBaseServices();
    const service = new SignupService(repositories.signup);

    const outcome = await service.signup({
      email: body.email,
      password: body.password,
      accountName: body.accountName,
      ownerName: body.ownerName ?? null,
    });

    if (!outcome.ok) {
      if (outcome.reason === "email_taken") {
        return fail({ code: "email_taken", laymanMessage: outcome.message }, 409);
      }
      return fail({ code: "weak_password", laymanMessage: outcome.message }, 400);
    }

    return ok(
      { accountId: outcome.accountId, ownerUserId: outcome.ownerUserId, email: outcome.email },
      { status: 201 },
    );
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
