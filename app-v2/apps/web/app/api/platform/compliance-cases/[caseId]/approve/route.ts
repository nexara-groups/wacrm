/**
 * `/api/platform/compliance-cases/[caseId]/approve` — the second step of
 * the two-person rule (§7). The approver may NOT be the case's opener; the
 * refusal for that is enforced inside `approveComplianceCase`
 * (modules/platform-admin/domain/compliance-case.ts), which
 * `SqlComplianceCaseRepository.approve` delegates to and this route never
 * re-implements — it surfaces the repository's `AppError.forbidden` in
 * plain language via `internalError`'s existing FORBIDDEN mapping.
 *
 * Tier: §7 names "second platform_admin or platform_superadmin" — there is
 * no dedicated `PlatformCapability` for this (only `compliance_case:open`
 * exists on `PLATFORM_CAPABILITIES`), so this route checks the tier
 * directly via `requirePlatformTier` rather than editing framework RBAC
 * code that is out of scope for this task. See the final report.
 */
import { NextResponse, type NextRequest } from "next/server";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";
import { approveComplianceCaseRequestSchema, complianceCaseIdParamSchema, toComplianceCaseDTO } from "@/lib/platform-dto";
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
    const body = parseOrThrow(
      approveComplianceCaseRequestSchema,
      await request.json().catch(() => ({})),
    );

    const { repositories } = await getBaseServices();
    const approved = await repositories.complianceCases.approve(principal, caseId, body.ttlDays);

    return ok({ case: toComplianceCaseDTO(approved) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
