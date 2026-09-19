/**
 * `/api/platform/compliance-cases` — GET active cases for one account,
 * POST open a new case.
 *
 * §7's whole design: opening a case grants NOTHING by itself (`approvedBy`
 * starts null) — it only declares a scope and a reason. Reading message
 * content never happens through this route, or anywhere in this console;
 * see `ComplianceCasePort.readContent`'s own doc comment
 * (modules/platform-admin/application/ports.ts) for the one place that
 * capability exists, which this task deliberately does not surface.
 *
 * SCOPE LIMIT, reported rather than worked around: `ComplianceCasePort`
 * has no "list every case, every account" method — only
 * `findActiveForAccount(principal, accountId)`. `accountId` is therefore a
 * REQUIRED query parameter here, not an optional filter; there is no
 * fleet-wide compliance-case view this port can back.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";
import { toComplianceCaseDTO, listComplianceCasesQuerySchema, openComplianceCaseRequestSchema } from "@/lib/platform-dto";
import { getBaseServices } from "@/lib/container";
import { requireCapability, requirePlatformPrincipal } from "@/lib/platform-principal";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requirePlatformPrincipal();

    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(listComplianceCasesQuerySchema, {
      accountId: searchParams.get("accountId") ?? undefined,
    });

    // Cross-account oversight (§2) is not tier-gated — every platform role
    // may view case metadata for any account. Reading is still audited by
    // the repository itself (findActiveForAccount's own audit write).
    const { repositories } = await getBaseServices();
    const cases = await repositories.complianceCases.findActiveForAccount(principal, query.accountId);

    return ok({
      items: cases.map((case_) => toComplianceCaseDTO(case_)),
      note:
        "Only OPEN (not-yet-closed) cases for this one account — ComplianceCasePort has no fleet-wide " +
        "or closed-case listing method.",
    });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await requirePlatformPrincipal();
    // §2: opening a case is platform_admin+, not platform_support.
    requireCapability(principal, "compliance_case:open");

    const body = parseOrThrow(openComplianceCaseRequestSchema, await request.json());

    const { repositories } = await getBaseServices();
    const case_ = await repositories.complianceCases.open(principal, {
      id: randomUUID(),
      externalRef: body.externalRef,
      category: body.category,
      accountId: body.accountId,
      scope: body.scope,
      reason: body.reason,
      ...(body.disclosureRestricted !== undefined ? { disclosureRestricted: body.disclosureRestricted } : {}),
    });

    return ok({ case: toComplianceCaseDTO(case_) }, { status: 201 });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
