import type { AuthProvider, AuthUser } from "../auth";
import { createTenantContext, type TenantContext } from "./tenant-context";

/**
 * RequestContext — the resolved per-request execution context.
 *
 * Carries the authenticated principal, their tenant scope, the raw access
 * token, and a correlation id. Services receive a RequestContext instead of
 * loose tokens, so authentication is resolved once at the edge and business
 * logic never re-parses headers or re-calls the auth provider.
 */
export interface RequestContext {
  /** Correlation id for logging/tracing. */
  readonly requestId: string;
  /** Raw access token, if one was supplied. */
  readonly accessToken: string | null;
  /** Resolved user, or null when unauthenticated. */
  readonly user: AuthUser | null;
  /** Tenant scope, or null when unauthenticated. */
  readonly tenant: TenantContext | null;
}

/** A RequestContext that is guaranteed authenticated (user + tenant present). */
export interface AuthenticatedContext extends RequestContext {
  readonly user: AuthUser;
  readonly tenant: TenantContext;
}

/** Narrowing guard for authenticated requests. */
export function isAuthenticated(ctx: RequestContext): ctx is AuthenticatedContext {
  return ctx.user !== null && ctx.tenant !== null;
}

/**
 * Resolve a RequestContext from an access token using the AuthProvider. This is
 * the single place authentication is turned into context. If the token is
 * missing or invalid, an unauthenticated context is returned (user/tenant null)
 * — services decide how to respond.
 */
export async function resolveRequestContext(
  accessToken: string | null,
  auth: AuthProvider,
): Promise<RequestContext> {
  const requestId = crypto.randomUUID();

  if (!accessToken) {
    return { requestId, accessToken: null, user: null, tenant: null };
  }

  const user = await auth.getCurrentUser(accessToken);
  if (!user) {
    return { requestId, accessToken, user: null, tenant: null };
  }

  return {
    requestId,
    accessToken,
    user,
    tenant: createTenantContext(user.tenantId),
  };
}
