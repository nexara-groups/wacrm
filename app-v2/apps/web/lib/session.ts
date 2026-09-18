/**
 * Session — the ONE place a request becomes an authenticated user +
 * `TenantContext`.
 *
 * Reads the httpOnly session cookie and verifies it against the auth
 * provider built in `lib/container.ts` (`nexara/core/auth`'s
 * `JwtAuthProvider` — see that file's header for why this slice uses it
 * instead of `modules/identity`'s `IdentityService`). Nothing else in
 * apps/web reads or writes this cookie directly; `lib/container.ts`'s
 * `getContainer()` calls `getCurrentAuth()` here to resolve the tenant for
 * every existing page/route, and the `/api/auth/*` routes call
 * `setSessionCookie`/`clearSessionCookie` here on login/logout.
 *
 * The cookie value is the provider's signed JWT access token itself —
 * nothing is stored server-side keyed by this exact token (no session
 * table, no lookup), so there is no raw token "at rest" to hash: the token
 * is authenticated by its HMAC signature, and revocation (logout) works by
 * bumping the credential's `session_version` counter, which the JWT's `sv`
 * claim must match (`JwtAuthProvider.getCurrentUser`) — an old token stops
 * verifying the moment logout runs, cookie or no cookie.
 */
import { cookies } from "next/headers";
import type { AuthUser } from "@nexara/core/auth";
import type { TenantContext } from "@nexara/core/context";
import { getBaseServices } from "./container";

export const SESSION_COOKIE_NAME = "wacrm_session";

/** Fallback when a session carries no known expiry. */
const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface AuthContext {
  readonly user: AuthUser;
  readonly tenant: TenantContext;
  readonly accessToken: string;
}

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Only the dev/test server runs over plain HTTP; every deployed
    // environment must be HTTPS for `secure` to still let the cookie
    // through, which is the point.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Set the session cookie after a successful login. Route Handlers only (cookies() can't be mutated during render). */
export async function setSessionCookie(accessToken: string, expiresAtMs?: number): Promise<void> {
  const maxAge =
    expiresAtMs !== undefined
      ? Math.max(1, Math.floor((expiresAtMs - Date.now()) / 1000))
      : DEFAULT_MAX_AGE_SECONDS;
  const jar = await cookies();
  jar.set(SESSION_COOKIE_NAME, accessToken, cookieOptions(maxAge));
}

/** Clear the session cookie on logout. */
export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE_NAME);
}

/**
 * Resolve the current request's authenticated user + tenant from the
 * session cookie, or `null` when there is none / it no longer verifies
 * (expired, signature mismatch, or revoked via `session_version`).
 */
export async function getCurrentAuth(): Promise<AuthContext | null> {
  const jar = await cookies();
  const accessToken = jar.get(SESSION_COOKIE_NAME)?.value;
  if (!accessToken) return null;

  const { authProvider } = await getBaseServices();
  const user = await authProvider.getCurrentUser(accessToken);
  if (!user) return null;

  return { user, tenant: { tenantId: user.tenantId }, accessToken };
}
