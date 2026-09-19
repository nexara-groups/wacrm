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
  fail,
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

    // The schema validates that `assignedUserId` is a well-formed UUID, and
    // that is all it can validate — shape is not membership. Without this
    // check any syntactically-valid UUID was accepted, so a conversation
    // could be assigned to a user who does not exist, or who belongs to a
    // different account, and the assignment would simply sit there
    // pointing at nobody. The tenant comparison matters as much as the
    // existence one: `UserRepositoryPort.findById` is keyed by user id
    // alone, with no tenant argument, so it will happily return another
    // account's user.
    if (assignedUserId !== null) {
      const assignee = await repositories.users.findById(assignedUserId);
      if (assignee === null || assignee.accountId !== tenant.tenantId) {
        return fail(
          {
            code: "invalid_assignee",
            laymanMessage: "That teammate isn't part of this account.",
            fieldErrors: { assignedUserId: ["Not a member of this account."] },
          },
          422,
        );
      }
    }

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
