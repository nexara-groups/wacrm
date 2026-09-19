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
 *
 * -----------------------------------------------------------------------
 * EMAIL VERIFICATION — required by CAPABILITY, never by a flag
 * -----------------------------------------------------------------------
 * `isRealEmailProviderConfigured()` is the one question that decides this:
 *   - A real provider IS configured -> the owner is created UNVERIFIED
 *     (`autoVerifyEmail: false`) and a verification email is sent with a
 *     fresh token (`credentialsRepository.createEmailVerification`,
 *     redeemed later by `POST /api/auth/verify-email`). `JwtAuthProvider
 *     .login` then genuinely refuses them until they click it.
 *   - No real provider is configured -> the owner is auto-verified exactly
 *     as before this task (`autoVerifyEmail: true`, the `SignupService`
 *     default), and a loud `console.warn` says so. Making verification
 *     mandatory here regardless of capability would mean nobody could ever
 *     sign up on such a deployment — the one outcome worse than "not
 *     verified yet".
 * A failure to actually SEND the verification email (vendor outage, bad
 * credentials) does not fail this request either, for the same reason a
 * failed invitation email doesn't fail invitation creation — see
 * `app/api/invitations/route.ts`. The tenant and owner already exist;
 * losing track of THAT would be the real damage.
 */
import { NextResponse, type NextRequest } from "next/server";
import { signupRequestSchema } from "@packages/contracts/src/auth";
import { createTenantContext } from "@nexara/core/context";
import { generateToken, hashToken } from "@modules/identity/domain/token-hashing";
import { getBaseServices } from "@/lib/container";
import { SignupService } from "@modules/organizations/application/signup-service";
import { fail, internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { isRealEmailProviderConfigured } from "@/lib/email-provider";
import { buildVerificationEmail, buildVerifyEmailUrl } from "@/lib/email-templates";

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // First thing, before parsing or touching the database. This route writes
    // FOUR rows per successful call, and the free tier meters 100,000 row
    // writes a day across the whole product — an unthrottled loop here is a
    // denial of service against every tenant, not just spam.
    const limited = await checkRateLimit(request, "signup");
    if (!limited.allowed) {
      return fail(
        {
          code: "rate_limited",
          laymanMessage: "Too many sign-up attempts. Please wait a minute and try again.",
        },
        429,
      );
    }

    const body = parseOrThrow(signupRequestSchema, await request.json());
    const { repositories, credentialsRepository, emailProvider } = await getBaseServices();
    const service = new SignupService(repositories.signup);

    const requiresVerification = isRealEmailProviderConfigured();

    const outcome = await service.signup(
      {
        email: body.email,
        password: body.password,
        accountName: body.accountName,
        ownerName: body.ownerName ?? null,
      },
      { autoVerifyEmail: !requiresVerification },
    );

    if (!outcome.ok) {
      if (outcome.reason === "email_taken") {
        return fail({ code: "email_taken", laymanMessage: outcome.message }, 409);
      }
      return fail({ code: "weak_password", laymanMessage: outcome.message }, 400);
    }

    let emailSent: boolean | undefined;
    if (requiresVerification) {
      emailSent = false;
      try {
        const rawToken = generateToken();
        const tokenHash = await hashToken(rawToken);
        await credentialsRepository.createEmailVerification(createTenantContext(outcome.accountId), {
          tokenHash,
          userId: outcome.ownerUserId,
          email: outcome.email,
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS).toISOString(),
        });
        await emailProvider.send(
          buildVerificationEmail({ to: outcome.email, verifyUrl: buildVerifyEmailUrl(rawToken) }),
        );
        emailSent = true;
      } catch {
        // Never touches the underlying error's message — same discipline as
        // `lib/invitation-email.ts`'s catch block, and for the same reason:
        // this path just generated a raw token, and nothing here should
        // ever have to trust a provider (present or future) not to echo it
        // back in a thrown error.
        console.error(
          `[auth] failed to send the verification email for a new signup (account ${outcome.accountId})`,
        );
      }
    } else {
      console.warn(
        `[auth] No real email provider configured (EMAIL_PROVIDER unset) — auto-verifying new owner ` +
          `immediately (account ${outcome.accountId}). Set EMAIL_PROVIDER to require verification instead.`,
      );
    }

    return ok(
      {
        accountId: outcome.accountId,
        ownerUserId: outcome.ownerUserId,
        email: outcome.email,
        emailVerificationRequired: requiresVerification,
        ...(requiresVerification ? { emailSent } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
