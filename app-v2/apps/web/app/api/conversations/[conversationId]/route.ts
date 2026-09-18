/**
 * `GET /api/conversations/[conversationId]` — get one, for the inbox right
 * pane header.
 *
 * There is no dedicated "get one conversation" response schema in
 * `@packages/contracts/src/conversations` (only the list/thread/assign/
 * mark-read shapes) — this reuses `{ conversation }`, the same shape
 * `assignConversationResponseSchema`/`markConversationReadResponseSchema`
 * already commit to, exactly like `/api/contacts/[contactId]` and
 * `/api/broadcasts/[broadcastId]` do for their own resources (see those
 * routes' own header comments for the same reasoning).
 */
import { NextResponse, type NextRequest } from "next/server";
import { conversationIdSchema } from "@packages/contracts/src/common/ids";
import { getContainer } from "@/lib/container";
import { toConversationDTO } from "@/lib/conversation-dto";
import {
  internalError,
  isZodError,
  notFoundError,
  ok,
  parseOrThrow,
  validationError,
} from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { conversationId: raw } = await context.params;
    const conversationId = parseOrThrow(conversationIdSchema, raw);

    const { repositories, tenant } = await getContainer();
    const conversation = await repositories.conversations.findById(tenant, conversationId);
    if (conversation === null) return notFoundError("conversation");

    return ok({ conversation: toConversationDTO(conversation) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
