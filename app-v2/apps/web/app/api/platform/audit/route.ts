/**
 * `/api/platform/audit` — GET the platform audit log, filterable.
 *
 * -----------------------------------------------------------------------
 * Reads the platform audit trail: who did what, to which account, when.
 *
 * Every tier may read it (spec §2, "audit logs ... full" at every tier).
 * This read is itself one of the cross-tenant acts the log exists to
 * record, which is why it runs through `requirePlatformPrincipal` first —
 * a verified principal made the attempt whether or not the response is
 * useful to them.
 *
 * The read is bounded. `platform_audit_log` only ever grows, and this is
 * the screen an incident response opens first, so it is the last place that
 * should degrade under its own history.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";
import { getBaseServices } from "@/lib/container";
import { requirePlatformPrincipal } from "@/lib/platform-principal";
import { toAuditEntryDTO } from "@/lib/platform-dto";

const DEFAULT_LIMIT = 100;

const auditQuerySchema = z.object({
  accountId: z.uuid().optional(),
  actor: z.uuid().optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(DEFAULT_LIMIT),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // Verifies the caller server-side, per request, against
    // `platformRoleGrants` — never a client-supplied role claim.
    await requirePlatformPrincipal();

    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(auditQuerySchema, {
      accountId: searchParams.get("accountId") ?? undefined,
      actor: searchParams.get("actor") ?? undefined,
      since: searchParams.get("since") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });

    const { repositories } = await getBaseServices();
    const entries = await repositories.platformAuditLog.list(
      {
        ...(query.accountId !== undefined ? { targetAccountId: query.accountId } : {}),
        ...(query.actor !== undefined ? { actor: query.actor } : {}),
        ...(query.since !== undefined ? { since: query.since } : {}),
      },
      query.limit,
    );

    return ok({ items: entries.map(toAuditEntryDTO), limit: query.limit });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
