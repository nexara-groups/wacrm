/**
 * `POST /api/broadcasts/[broadcastId]/pause`.
 *
 * A paused broadcast is NOT a new status: per `BroadcastRecord`'s docstring
 * (modules/broadcasts/application/ports.ts), it keeps `status: "sending"`
 * and carries `pausedAt`/`pauseReason` as extra fields — this mirrors
 * `BroadcastService.pauseBroadcast`'s own validation (only a "sending"
 * broadcast can be paused), re-implemented directly against
 * `BroadcastRepositoryPort` rather than instantiating the full
 * `BroadcastService` (whose other methods need `MessageDispatchPort` /
 * `OperatorAlertPort` — vendor-integration ports this route does not need
 * and has no implementation to inject for).
 *
 * GAP: `pauseBroadcastRequestSchema` carries no `reason` field, even though
 * `BroadcastRepositoryPort.setPaused` and the `Broadcast.pauseReason` wire
 * field both expect one (it's what distinguishes an operator pause from an
 * automatic PERMANENT_CONFIG-triggered pause on the detail screen). This
 * route supplies a fixed "Paused by operator" reason since the contract
 * gives it nothing else to record.
 */
import { NextResponse, type NextRequest } from "next/server";
import { pauseBroadcastRequestSchema } from "@packages/contracts/src/broadcasts";
import type { AccountId } from "@packages/domain/src/ids";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
import { toBroadcastDTO } from "@/lib/broadcast-dto";
import { fail, internalError, isZodError, notFoundError, ok, parseOrThrow, validationError } from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ broadcastId: string }>;
}

const OPERATOR_PAUSE_REASON = "Paused by operator";

export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    // `broadcasts:control`, not a lower bar just because pausing is a safety
    // action: this endpoint family also cancels (destructive, irreversible),
    // and neighbouring buttons can't carry different rules for a reason the
    // screen doesn't show — see route-authorization.ts's entry for the case.
    const authorized = await authorizeAction("broadcasts:control");
    if (!authorized.ok) return authorized.response;

    const { broadcastId: raw } = await context.params;
    const { broadcastId } = parseOrThrow(pauseBroadcastRequestSchema, { broadcastId: raw });

    const { repositories, tenant } = await getContainer();
    const accountId = tenant.tenantId as AccountId;

    const broadcast = await repositories.broadcasts.getById(accountId, broadcastId);
    if (broadcast === null) return notFoundError("broadcast");

    if (broadcast.status !== "sending") {
      return fail(
        {
          code: "invalid_transition",
          laymanMessage: `This broadcast can't be paused because it's ${broadcast.status}, not sending.`,
        },
        409,
      );
    }
    if (broadcast.pausedAt !== null) {
      return fail(
        { code: "invalid_transition", laymanMessage: "This broadcast is already paused." },
        409,
      );
    }

    await repositories.broadcasts.setPaused(accountId, broadcastId, new Date().toISOString(), OPERATOR_PAUSE_REASON);
    const updated = await repositories.broadcasts.getById(accountId, broadcastId);
    if (updated === null) return notFoundError("broadcast");

    return ok({ broadcast: toBroadcastDTO(updated) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
