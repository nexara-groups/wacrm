/**
 * `POST /api/auth/verify-email` — redeems the token from a verification
 * email (see `app/api/auth/signup/route.ts`, which issues it when a real
 * email provider is configured).
 *
 * PUBLIC — no session exists yet for someone who just signed up and hasn't
 * verified (`proxy.ts` already exempts every `/api/auth/*` path).
 *
 * Looked up ACROSS TENANTS by the token's hash
 * (`findUsableEmailVerificationAnyTenant`): the caller has only the raw
 * token from the emailed link, never the tenant it belongs to — every
 * signup creates its own new tenant, so there is no single fixed tenant
 * this could assume instead. See that method's doc on
 * `CredentialsRepository` for why this is safe to leave unscoped.
 */
import { NextResponse, type NextRequest } from "next/server";
import { verifyEmailRequestSchema } from "@packages/contracts/src/auth";
import { createTenantContext } from "@nexara/core/context";
import { hashToken } from "@modules/identity/domain/token-hashing";
import { getBaseServices } from "@/lib/container";
import { fail, internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = parseOrThrow(verifyEmailRequestSchema, await request.json());
    const { credentialsRepository } = await getBaseServices();

    const tokenHash = await hashToken(body.token);
    const usable = await credentialsRepository.findUsableEmailVerificationAnyTenant(tokenHash);
    if (!usable) {
      return fail(
        { code: "invalid_token", laymanMessage: "That verification link is invalid or has expired." },
        400,
      );
    }

    const redeemed = await credentialsRepository.redeemEmailVerification(
      createTenantContext(usable.tenantId),
      tokenHash,
      usable.userId,
    );
    if (!redeemed) {
      return fail(
        { code: "invalid_token", laymanMessage: "That verification link is invalid or has expired." },
        400,
      );
    }

    return ok({ email: usable.email });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
