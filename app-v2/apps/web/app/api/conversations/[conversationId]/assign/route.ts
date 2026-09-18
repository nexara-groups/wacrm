/**
 * `POST /api/conversations/[conversationId]/assign` — assign or unassign
 * (`assignedUserId: null`) a conversation to an account member.
 *
 * Pure state-transition pattern per the task rules: load the record, run
 * the pure `assignConversation` (`@modules/conversations/domain/conversation`)
 * to compute the next one, then `repository.save`. This route never mutates
 * a loaded record inline.
 */
import { NextResponse, type NextRequest } from "next/server";
import { assignConversationRequestSchema } from "@packages/contracts/src/conversations";
import { assignConversation } from "@modules/conversations/domain/conversation";
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

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { conversationId: raw } = await context.params;
    const body: unknown = await request.json();
    const bodyObject = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const { conversationId, assignedUserId } = parseOrThrow(assignConversationRequestSchema, {
      conversationId: raw,
      assignedUserId: bodyObject.assignedUserId ?? null,
    });

    const { repositories, tenant } = await getContainer();
    const conversation = await repositories.conversations.findById(tenant, conversationId);
    if (conversation === null) return notFoundError("conversation");

    const next = assignConversation(conversation, assignedUserId);
    const saved = await repositories.conversations.save(tenant, next);

    return ok({ conversation: toConversationDTO(saved) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
