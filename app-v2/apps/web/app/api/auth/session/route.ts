/**
 * `GET /api/auth/session` — the current authenticated user, or a 401
 * through the shared error envelope when there is none.
 */
import { NextResponse } from "next/server";
import { toAuthUserDTO } from "@/lib/auth-dto";
import { getCurrentAuth } from "@/lib/session";
import { fail, internalError, ok } from "@/lib/api-response";

export async function GET(): Promise<NextResponse> {
  try {
    const auth = await getCurrentAuth();
    if (!auth) {
      return fail({ code: "unauthenticated", laymanMessage: "You're not signed in." }, 401);
    }
    return ok({ user: toAuthUserDTO(auth.user) });
  } catch (error) {
    return internalError(error);
  }
}
