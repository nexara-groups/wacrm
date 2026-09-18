/**
 * `/api/platform/compliance-cases/[caseId]` — GET one case's metadata
 * (scope, reason, approval state, TTL). Never content — see the collection
 * route's header.
 */
import { NextResponse, type NextRequest } from "next/server";
import { internalError, isZodError, notFoundError, ok, parseOrThrow, validationError } from "@/lib/api-response";
import { complianceCaseIdParamSchema, toComplianceCaseDTO } from "@/lib/platform-dto";
import { getBaseServices } from "@/lib/container";
import { requirePlatformPrincipal } from "@/lib/platform-principal";

interface RouteContext {
  params: Promise<{ caseId: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const principal = await requirePlatformPrincipal();

    const { caseId } = parseOrThrow(complianceCaseIdParamSchema, await context.params);

    const { repositories } = await getBaseServices();
    const case_ = await repositories.complianceCases.findById(principal, caseId);
    if (case_ === null) return notFoundError("compliance case");

    return ok({ case: toComplianceCaseDTO(case_) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
