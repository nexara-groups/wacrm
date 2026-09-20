/**
 * The one way a route asks "may this caller do this?".
 *
 * Returns a discriminated result rather than throwing, matching
 * `lib/send-plumbing.ts`'s `resolveSendTarget`: a route's single try/catch
 * then never has to tell an authorization refusal apart from an unexpected
 * error.
 *
 * The principal comes from `getCurrentAuth()` — the same verified session
 * `getContainer()` is built from — and NEVER from the request. `canInTenant`
 * in the framework's `PermissionService` makes the same point for
 * permissions: an action is only allowed inside the principal's own tenant.
 * Here that check is implicit and stronger, because the tenant a route acts
 * on is itself derived from this session, so there is no second tenant to
 * compare against.
 */
import { NextResponse } from "next/server";
import type { Role } from "@nexara/core/rbac";
import { getCurrentAuth } from "./session";
import { fail } from "./api-response";
import { forbiddenMessageFor, isAuthorizedForAction, type TenantAction } from "./route-authorization";

export type AuthorizationResult =
  | { readonly ok: true; readonly role: Role; readonly userId: string }
  | { readonly ok: false; readonly response: NextResponse };

export async function authorizeAction(action: TenantAction): Promise<AuthorizationResult> {
  const auth = await getCurrentAuth();
  if (!auth) {
    // A route reaching here without a session is unusual — `getContainer()`
    // throws first in most of them — but answering 401 is still correct, and
    // never a 403: the caller may well be allowed once signed in.
    return {
      ok: false,
      response: fail({ code: "unauthenticated", laymanMessage: "Please sign in again." }, 401),
    };
  }
  if (!isAuthorizedForAction(auth.user.role, action)) {
    return {
      ok: false,
      response: fail(
        {
          code: "forbidden",
          laymanMessage: forbiddenMessageFor(action),
          // The role is the operator's own, not another user's, so naming it
          // discloses nothing they cannot already see on their profile.
          operatorHint: `role=${auth.user.role} action=${action}`,
        },
        403,
      ),
    };
  }
  return { ok: true, role: auth.user.role, userId: auth.user.userId };
}
