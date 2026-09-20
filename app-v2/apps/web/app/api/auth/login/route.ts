/**
 * `POST /api/auth/login` — verify email + password, set the session cookie.
 *
 * Same discipline as `/api/contacts`: the request is validated against its
 * zod contract (`loginRequestSchema`) before anything else runs, and every
 * failure goes out through the shared error envelope — no hand-rolled
 * shape, no leaked exception.
 */
import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@shared/errors";
import { loginRequestSchema, toAuthUserDTO } from "@/lib/auth-dto";
import { getBaseServices } from "@/lib/container";
import { setSessionCookie } from "@/lib/session";
import { fail, internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Before the password hash, not after: the ~6ms PBKDF2 cost is the thing
    // being protected, so checking afterwards would have already paid it.
    const limited = await checkRateLimit(request, "login");
    if (!limited.allowed) {
      return fail(
        {
          code: "rate_limited",
          laymanMessage: "Too many attempts. Please wait a minute and try again.",
        },
        429,
      );
    }

    const body = parseOrThrow(loginRequestSchema, await request.json());
    const { authProvider } = await getBaseServices();

    const session = await authProvider
      .login({ email: body.email, password: body.password })
      .catch((error: unknown) => {
        if (error instanceof AppError && (error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN")) {
          return null;
        }
        throw error;
      });

    if (session === null) {
      return fail(
        { code: "invalid_credentials", laymanMessage: "That email or password isn't right." },
        401,
      );
    }

    await setSessionCookie(session.accessToken, session.expiresAt);

    return ok({ user: toAuthUserDTO(session.user) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
