/**
 * `/api/broadcasts/[broadcastId]` — get one.
 *
 * Same discipline as `/api/contacts/[contactId]`: zod-validated in,
 * error-envelope out. There is no dedicated "get one broadcast" response
 * schema in `@packages/contracts/src/broadcasts` (only the lifecycle
 * actions, which share `broadcastActionResponseSchema`'s `{ ok, broadcast
 * }` shape) — reused here rather than inventing a parallel shape, exactly
 * like `/api/contacts/[contactId]`'s GET returns `{ contact }` without a
 * named response schema of its own.
 */
import { NextResponse, type NextRequest } from "next/server";
import { broadcastActionRequestSchema } from "@packages/contracts/src/broadcasts";
import type { AccountId } from "@packages/domain/src/ids";
import { getContainer } from "@/lib/container";
import { toBroadcastDTO } from "@/lib/broadcast-dto";
import { internalError, isZodError, notFoundError, ok, parseOrThrow, validationError } from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ broadcastId: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { broadcastId: raw } = await context.params;
    const { broadcastId } = parseOrThrow(broadcastActionRequestSchema, { broadcastId: raw });

    const { repositories, tenant } = await getContainer();
    const accountId = tenant.tenantId as AccountId;

    const broadcast = await repositories.broadcasts.getById(accountId, broadcastId);
    if (broadcast === null) return notFoundError("broadcast");

    return ok({ broadcast: toBroadcastDTO(broadcast) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
