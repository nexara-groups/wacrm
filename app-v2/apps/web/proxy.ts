/**
 * Auth gate for every request.
 *
 * NAMED `proxy.ts`, NOT `middleware.ts`: per
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
 * middleware.md (and AGENTS.md's "heed deprecation notices"), the
 * `middleware.js` file convention is deprecated in this Next.js version and
 * renamed to `proxy.js` — same behavior, `proxy` export instead of
 * `middleware`. A `middleware.ts` file here would silently not run.
 *
 * This is a first line of defense, not the only check: it only confirms a
 * session cookie is PRESENT (cheap, no DB read) so a request with no cookie
 * at all never reaches a protected page or API route. The cookie's
 * validity — signature, expiry, and `session_version` revocation (logout)
 * — is verified for real on every request by `lib/session.ts`'s
 * `getCurrentAuth()`, which `lib/container.ts`'s `getContainer()` calls for
 * every existing page/route. A stale-but-present cookie (e.g. replayed
 * after logout) passes this gate and is then rejected there.
 */
import { NextResponse, type NextRequest } from "next/server";

/** Keep in sync with `lib/session.ts`'s `SESSION_COOKIE_NAME`. */
const SESSION_COOKIE_NAME = "wacrm_session";

const PUBLIC_PAGE_PATHS = new Set(["/login", "/signup"]);

function isPublicApiPath(pathname: string): boolean {
  // Every /api/auth/* route handles its own authenticated/unauthenticated
  // cases (login IS the credential-entry point; session/logout must both
  // answer gracefully with no cookie at all; signup — /api/auth/signup —
  // is the front door for a tenant that doesn't exist yet, so by
  // definition nobody calling it can hold a session cookie).
  if (pathname.startsWith("/api/auth/")) return true;

  // Meta's webhook caller has no session cookie and never will, so without
  // this exemption every inbound WhatsApp message is answered 401 and the
  // inbox stays permanently empty.
  //
  // This is NOT an unauthenticated route — it is a DIFFERENTLY authenticated
  // one. `app/api/webhooks/whatsapp/route.ts` verifies Meta's HMAC-SHA256
  // signature over the raw request bytes, in constant time, and refuses to
  // run at all when the app secret is unset. Cookie-based gating is simply
  // the wrong check for a caller that authenticates by signing its payload.
  //
  // Kept to this one prefix deliberately: it is the only place in the app
  // where the session check is skipped for a reason other than logging in.
  return pathname.startsWith("/api/webhooks/");
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);

  if (hasSessionCookie) {
    if (PUBLIC_PAGE_PATHS.has(pathname)) {
      return NextResponse.redirect(new URL("/contacts", request.url));
    }
    return NextResponse.next();
  }

  if (PUBLIC_PAGE_PATHS.has(pathname) || isPublicApiPath(pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", laymanMessage: "You're not signed in." } },
      { status: 401 },
    );
  }

  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
