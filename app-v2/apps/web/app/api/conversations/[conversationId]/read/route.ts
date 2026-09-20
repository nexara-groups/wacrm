/**
 * `POST /api/conversations/[conversationId]/read` — mark a conversation
 * read. Called when the inbox screen selects a conversation.
 *
 * Pure state-transition pattern per the task rules: load the record, run
 * the pure `markRead` (`@modules/conversations/domain/conversation`) to
 * compute the next one, then `repository.save`. This route never mutates a
 * loaded record inline.
 */
import { NextResponse, type NextRequest } from "next/server";
import { markConversationReadRequestSchema } from "@packages/contracts/src/conversations";
import { markRead } from "@modules/conversations/domain/conversation";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
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

export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const authorized = await authorizeAction("conversations:mark-read");
    if (!authorized.ok) return authorized.response;

    const { conversationId: raw } = await context.params;
    const { conversationId } = parseOrThrow(markConversationReadRequestSchema, {
      conversationId: raw,
    });

    const { repositories, tenant } = await getContainer();
    const conversation = await repositories.conversations.findById(tenant, conversationId);
    if (conversation === null) return notFoundError("conversation");

    const next = markRead(conversation);
    const saved = await repositories.conversations.save(tenant, next);

    return ok({ conversation: toConversationDTO(saved) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
