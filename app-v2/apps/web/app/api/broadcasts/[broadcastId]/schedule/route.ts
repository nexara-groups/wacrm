/**
 * `POST /api/broadcasts/[broadcastId]/schedule`.
 *
 * Mirrors `BroadcastService.scheduleBroadcast`: `canTransitionBroadcastStatus`
 * (packages/domain/src/status/broadcast-status.ts) only allows
 * `draft -> scheduled` — same-status transitions are explicitly rejected
 * (`from === to` short-circuits to `false`), so an already-`scheduled`
 * broadcast cannot have its `scheduledAt` changed through this endpoint,
 * and neither can one that's `sending`/`sent`/`failed`. That is a domain
 * rule as written, not a bug introduced here; a "reschedule" UX would need
 * a domain change this slice does not make. `broadcastId` is required in
 * both the URL and the body by `scheduleBroadcastRequestSchema`; a mismatch
 * is rejected the same way `/api/contacts/[contactId]` PATCH rejects a body
 * `contactId` that disagrees with the URL.
 */
import { NextResponse, type NextRequest } from "next/server";
import { scheduleBroadcastRequestSchema } from "@packages/contracts/src/broadcasts";
import type { AccountId } from "@packages/domain/src/ids";
import { canTransitionBroadcastStatus } from "@packages/domain/src/status/broadcast-status";
import { getContainer } from "@/lib/container";
import { toBroadcastDTO } from "@/lib/broadcast-dto";
import { fail, internalError, isZodError, notFoundError, ok, parseOrThrow, validationError } from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ broadcastId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { broadcastId: rawBroadcastId } = await context.params;
    const body = parseOrThrow(scheduleBroadcastRequestSchema, await request.json());

    if (body.broadcastId !== rawBroadcastId) {
      return fail(
        {
          code: "validation_error",
          laymanMessage: "That request wasn't quite right — check the highlighted fields.",
          fieldErrors: { broadcastId: ["Does not match the resource in the URL."] },
        },
        400,
      );
    }

    const { repositories, tenant } = await getContainer();
    const accountId = tenant.tenantId as AccountId;

    const broadcast = await repositories.broadcasts.getById(accountId, body.broadcastId);
    if (broadcast === null) return notFoundError("broadcast");

    if (!canTransitionBroadcastStatus(broadcast.status, "scheduled")) {
      return fail(
        {
          code: "invalid_transition",
          laymanMessage: `This broadcast can't be scheduled because it's ${broadcast.status}.`,
        },
        409,
      );
    }

    await repositories.broadcasts.setScheduledAt(accountId, body.broadcastId, body.scheduledAt);
    await repositories.broadcasts.updateStatus(accountId, body.broadcastId, "scheduled");
    const updated = await repositories.broadcasts.getById(accountId, body.broadcastId);
    if (updated === null) return notFoundError("broadcast");

    return ok({ broadcast: toBroadcastDTO(updated) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
