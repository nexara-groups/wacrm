/**
 * `GET /api/broadcasts/[broadcastId]/report` — sent/delivered/read/failed,
 * failures grouped by reason, and the "will retry automatically" count
 * distinguished from a definitive stop (META_ERROR_TAXONOMY.md §4b).
 *
 * Pages through every recipient row via `BroadcastRecipientRepositoryPort.
 * listByBroadcast` (recipient fan-out can be thousands of rows — never a
 * single unbounded fetch) and hands them to `toBroadcastReportDTO`
 * (lib/broadcast-dto.ts), which does the grouping and the retry-vs-stop
 * split.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getBroadcastReportRequestSchema } from "@packages/contracts/src/broadcasts";
import type { AccountId } from "@packages/domain/src/ids";
import type { BroadcastRecipient } from "@packages/domain/src/entities/broadcast-recipient";
import { getContainer } from "@/lib/container";
import { toBroadcastReportDTO } from "@/lib/broadcast-dto";
import { internalError, isZodError, notFoundError, ok, parseOrThrow, validationError } from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ broadcastId: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { broadcastId: raw } = await context.params;
    const { broadcastId } = parseOrThrow(getBroadcastReportRequestSchema, { broadcastId: raw });

    const { repositories, tenant } = await getContainer();
    const accountId = tenant.tenantId as AccountId;

    const broadcast = await repositories.broadcasts.getById(accountId, broadcastId);
    if (broadcast === null) return notFoundError("broadcast");

    const rows: BroadcastRecipient[] = [];
    let cursor: string | null = null;
    do {
      const page = await repositories.broadcastRecipients.listByBroadcast(accountId, broadcastId, cursor, 200);
      rows.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);

    return ok({ report: toBroadcastReportDTO(broadcast, rows) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
