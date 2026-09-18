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

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
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
