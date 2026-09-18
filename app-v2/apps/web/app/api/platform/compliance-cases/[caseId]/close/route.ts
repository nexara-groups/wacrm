/**
 * `/api/platform/compliance-cases/[caseId]/close` — §7: "case closes (or
 * auto-expires) -> access ends immediately". This is the explicit-close
 * path; auto-expiry needs no action here at all — `canReadContent`
 * (modules/platform-admin/domain/compliance-case.ts) checks `expiresAt`
 * against `now` on every read, so an unclosed-but-expired case already
 * denies content with no cleanup job and nothing for this route to do.
 *
 * Same tier note as approve/route.ts: no dedicated `PlatformCapability`
 * exists for "close a compliance case", so this checks `platform_admin`+
 * directly.
 */
import { NextResponse, type NextRequest } from "next/server";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";
import { closeComplianceCaseRequestSchema, complianceCaseIdParamSchema, toComplianceCaseDTO } from "@/lib/platform-dto";
import { getBaseServices } from "@/lib/container";
import { requirePlatformPrincipal, requirePlatformTier } from "@/lib/platform-principal";

interface RouteContext {
  params: Promise<{ caseId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const principal = await requirePlatformPrincipal();
    requirePlatformTier(principal, "platform_admin");

    const { caseId } = parseOrThrow(complianceCaseIdParamSchema, await context.params);
    const body = parseOrThrow(closeComplianceCaseRequestSchema, await request.json());

    const { repositories } = await getBaseServices();
    const closed = await repositories.complianceCases.close(principal, caseId, body.outcome);

    return ok({ case: toComplianceCaseDTO(closed) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
