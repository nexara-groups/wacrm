/**
 * `POST /api/conversations/[conversationId]/messages/send` — send a text
 * WhatsApp message in an existing conversation.
 *
 * Authenticated route (unlike the webhook receiver): goes through
 * `getContainer()` as every other existing route does, so it inherits
 * session + tenant resolution from `lib/session.ts`.
 *
 * Every send funnels through `WhatsAppService.sendText`
 * (modules/whatsapp/application/whatsapp-service.ts), whose `guardAndSend`
 * is THE place consent/suppression is enforced before dispatch
 * (`shouldBlockSend`, META_ERROR_TAXONOMY.md §4) — this route does not, and
 * must not, re-implement or duplicate that check; it only maps the
 * `SendFailure` this call can come back with onto an HTTP response. No
 * credit reservation happens anywhere on this path (`WhatsAppService`'s own
 * `EXTENSION POINT` comment — gated behind `META_COMMERCIAL_BILLING_MODEL
 * .md`, not built here).
 *
 * On a successful send, the outbound message is recorded through
 * `InboxService.recordOutbound` (modules/conversations/application/
 * inbox-service.ts) — the SAME path a real inbox "send" already uses for
 * persistence — so the conversation's `lastMessageAt` and the message row
 * (with the real Meta `wamid`) exist for the thread to render immediately.
 */
import { NextResponse, type NextRequest } from "next/server";
import { sendTextMessageRequestSchema } from "@packages/contracts/src/messages";
import { AccountId } from "@packages/domain/src/ids";
import type { ConversationId } from "@packages/domain/src/ids";
import { InboxService } from "@modules/conversations/application/inbox-service";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
import { getWhatsAppContainer } from "@/lib/whatsapp-container";
import { toMessageDTO } from "@/lib/message-dto";
import { resolveSendTarget, sendFailureResponse } from "@/lib/send-plumbing";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const authorized = await authorizeAction("messages:send");
    if (!authorized.ok) return authorized.response;

    const { conversationId: rawConversationId } = await context.params;
    const json: unknown = await request.json().catch(() => ({}));
    const input = parseOrThrow(sendTextMessageRequestSchema, {
      conversationId: rawConversationId,
      body: (json as { body?: unknown })?.body,
    });

    const { repositories, tenant } = await getContainer();
    const accountId = AccountId(tenant.tenantId);
    const conversationId = input.conversationId as ConversationId;

    const target = await resolveSendTarget(tenant, repositories, conversationId);
    if (!target.ok) return target.response;
    const { conversation, contact, config } = target.value;

    const { service } = await getWhatsAppContainer();
    const result = await service.sendText({
      accountId,
      contactId: conversation.contactId,
      phoneNumberId: config.phoneNumberId,
      to: contact.phoneNumber,
      text: input.body,
    });

    if (!result.ok) return sendFailureResponse(result.error);

    const inbox = new InboxService({
      conversations: repositories.conversations,
      messages: repositories.messages,
    });
    const outboundResult = await inbox.recordOutbound(tenant, conversationId, {
      contactId: conversation.contactId,
      type: "text",
      body: input.body,
      templateId: null,
      waMessageId: result.value.waMessageId,
      replyToId: null,
      mediaRef: null,
      status: "sent",
      occurredAt: new Date().toISOString(),
    });
    if (!outboundResult.ok) return internalError(outboundResult.error);

    return ok({ message: toMessageDTO(outboundResult.value.message) }, { status: 201 });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
