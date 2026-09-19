/**
 * `POST /api/auth/resend-verification` — issue a fresh verification email.
 *
 * WHY THIS HAS TO EXIST. Signup requires email verification whenever a real
 * provider is configured, and `JwtAuthProvider.login` refuses an unverified
 * credential. So when the verification email fails to send — a vendor outage,
 * a bounced address, a typo in the address someone typed — the owner is left
 * with an account they cannot enter and no way to ask for another email.
 * Signup would manufacture dead accounts. Requiring verification without a
 * recovery path is not a security posture, it is a support queue.
 *
 * ALWAYS ANSWERS THE SAME. Unknown address, already-verified account, send
 * failure — every outcome returns the same 200 and the same wording. This
 * endpoint is unauthenticated by necessity (the caller cannot log in, that
 * being the problem), so a response that distinguished "no such account" from
 * "email sent" would be a free account-existence oracle for anyone who asked.
 * The real outcome goes to the logs, which the person asking cannot read.
 *
 * Rate limited on the same binding as login and signup: it sends mail on an
 * unauthenticated request, which is someone else's inbox and our quota.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createTenantContext } from "@nexara/core/context";
import { generateToken, hashToken } from "@modules/identity/domain/token-hashing";
import { getBaseServices } from "@/lib/container";
import { buildVerificationEmail, buildVerifyEmailUrl } from "@/lib/email-templates";
import { fail, internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";

const resendVerificationRequestSchema = z.object({
  email: z.email(),
});

/** Matches the lifetime signup uses, so a resent link is no shorter-lived than the first. */
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The single response every path returns. Deliberately vague about whether
 * anything was sent — see this file's header.
 */
function acknowledged(): NextResponse {
  return ok({
    message:
      "If that email address needs verifying, we've sent a new link to it. " +
      "Check your inbox, including spam.",
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const limited = await checkRateLimit(request, "resend-verification");
    if (!limited.allowed) {
      return fail(
        {
          code: "rate_limited",
          laymanMessage: "Too many requests. Please wait a minute and try again.",
        },
        429,
      );
    }

    const body = parseOrThrow(resendVerificationRequestSchema, await request.json());
    const { credentialsRepository, emailProvider } = await getBaseServices();

    const credential = await credentialsRepository.findByEmailAnyTenant(body.email.toLowerCase().trim());

    // No account, or nothing to verify. Same answer either way.
    if (credential === null || credential.verifiedAt !== null) return acknowledged();

    const rawToken = generateToken();
    const tokenHash = await hashToken(rawToken);
    await credentialsRepository.createEmailVerification(createTenantContext(credential.tenantId), {
      tokenHash,
      userId: credential.userId,
      email: credential.email,
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS).toISOString(),
    });

    try {
      await emailProvider.send(
        buildVerificationEmail({ to: credential.email, verifyUrl: buildVerifyEmailUrl(rawToken) }),
      );
    } catch {
      // Never reads the error: a verification failure's message can quote the
      // payload, and the payload contains the raw token. Same rule the invite
      // send path follows. The caller is told nothing either way.
      console.warn(`[auth] failed to resend a verification email (provider ${emailProvider.name})`);
    }

    return acknowledged();
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
