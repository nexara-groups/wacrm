/**
 * `POST /api/broadcasts/[broadcastId]/cancel`.
 *
 * "Cancel" is not a new status — it moves `status` to `BroadcastStatus`'s
 * own terminal `"failed"` value (legal transitions: `scheduled -> failed`,
 * `sending -> failed`; see `canTransitionBroadcastStatus` in
 * `packages/domain/src/status/broadcast-status.ts`). A `draft` broadcast
 * has no legal transition to `failed` at all, so cancel is refused there
 * too (the composer never sent it; there's nothing running to stop). This
 * mirrors `BroadcastService.cancelBroadcast` exactly, including clearing
 * any stale pause flag on the now-terminal row.
 */
import { NextResponse, type NextRequest } from "next/server";
import { cancelBroadcastRequestSchema } from "@packages/contracts/src/broadcasts";
import type { AccountId } from "@packages/domain/src/ids";
import { canTransitionBroadcastStatus } from "@packages/domain/src/status/broadcast-status";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
import { toBroadcastDTO } from "@/lib/broadcast-dto";
import { fail, internalError, isZodError, notFoundError, ok, parseOrThrow, validationError } from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ broadcastId: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    // Same `broadcasts:control` bar as pause/resume — see pause/route.ts.
    const authorized = await authorizeAction("broadcasts:control");
    if (!authorized.ok) return authorized.response;

    const { broadcastId: raw } = await context.params;
    const { broadcastId } = parseOrThrow(cancelBroadcastRequestSchema, { broadcastId: raw });

    const { repositories, tenant } = await getContainer();
    const accountId = tenant.tenantId as AccountId;

    const broadcast = await repositories.broadcasts.getById(accountId, broadcastId);
    if (broadcast === null) return notFoundError("broadcast");

    if (!canTransitionBroadcastStatus(broadcast.status, "failed")) {
      return fail(
        {
          code: "invalid_transition",
          laymanMessage: `This broadcast can't be cancelled because it's ${broadcast.status}.`,
        },
        409,
      );
    }

    await repositories.broadcasts.updateStatus(accountId, broadcastId, "failed");
    await repositories.broadcasts.setPaused(accountId, broadcastId, null, null);
    const updated = await repositories.broadcasts.getById(accountId, broadcastId);
    if (updated === null) return notFoundError("broadcast");

    return ok({ broadcast: toBroadcastDTO(updated) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
