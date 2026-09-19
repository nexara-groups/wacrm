/**
 * `POST /api/auth/logout` — invalidate the current session and clear the
 * cookie.
 *
 * Revocation is real, not just cookie deletion: `JwtAuthProvider.logout`
 * bumps the credential's `session_version`, so the access token this
 * request carried (and any other outstanding copy of it) stops verifying
 * immediately — see `lib/session.ts`'s header for why that is sufficient
 * without a separate session table.
 */
import { NextResponse } from "next/server";
import { getBaseServices } from "@/lib/container";
import { clearSessionCookie, getCurrentAuth } from "@/lib/session";
import { internalError, ok } from "@/lib/api-response";

export async function POST(): Promise<NextResponse> {
  try {
    const auth = await getCurrentAuth();
    if (auth) {
      const { authProvider } = await getBaseServices();
      await authProvider.logout(auth.accessToken);
    }
    await clearSessionCookie();
    return ok({});
  } catch (error) {
    return internalError(error);
  }
}
