/**
 * `POST /api/broadcasts/[broadcastId]/resume`.
 *
 * Mirrors `BroadcastService.resumeBroadcast`'s validation: only a
 * currently-paused "sending" broadcast may resume. Resuming just clears
 * `pausedAt`/`pauseReason` — `status` never changes (it was "sending" the
 * whole time; see pause/route.ts's docstring).
 */
import { NextResponse, type NextRequest } from "next/server";
import { resumeBroadcastRequestSchema } from "@packages/contracts/src/broadcasts";
import type { AccountId } from "@packages/domain/src/ids";
import { getContainer } from "@/lib/container";
import { toBroadcastDTO } from "@/lib/broadcast-dto";
import { fail, internalError, isZodError, notFoundError, ok, parseOrThrow, validationError } from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ broadcastId: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { broadcastId: raw } = await context.params;
    const { broadcastId } = parseOrThrow(resumeBroadcastRequestSchema, { broadcastId: raw });

    const { repositories, tenant } = await getContainer();
    const accountId = tenant.tenantId as AccountId;

    const broadcast = await repositories.broadcasts.getById(accountId, broadcastId);
    if (broadcast === null) return notFoundError("broadcast");

    if (broadcast.status !== "sending") {
      return fail(
        {
          code: "invalid_transition",
          laymanMessage: `This broadcast can't be resumed because it's ${broadcast.status}, not sending.`,
        },
        409,
      );
    }
    if (broadcast.pausedAt === null) {
      return fail(
        { code: "invalid_transition", laymanMessage: "This broadcast is not paused." },
        409,
      );
    }

    await repositories.broadcasts.setPaused(accountId, broadcastId, null, null);
    const updated = await repositories.broadcasts.getById(accountId, broadcastId);
    if (updated === null) return notFoundError("broadcast");

    return ok({ broadcast: toBroadcastDTO(updated) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
