/**
 * `POST /api/conversations/[conversationId]/messages/interactive` — send a
 * WhatsApp interactive (button or list reply) message in an existing
 * conversation.
 *
 * Mirrors `.../messages/send/route.ts` (the text route) exactly for
 * container wiring, consent/suppression handling (via `resolveSendTarget` /
 * `sendFailureResponse`, `@/lib/send-plumbing`) and outbound persistence.
 * `toProviderInteractive` (`@/lib/interactive-payload`) maps the contract's
 * `kind: "button"` discriminant onto the provider port's `kind: "buttons"`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { sendInteractiveMessageRequestSchema } from "@packages/contracts/src/messages";
import { AccountId } from "@packages/domain/src/ids";
import type { ConversationId } from "@packages/domain/src/ids";
import { InboxService } from "@modules/conversations/application/inbox-service";
import { getContainer } from "@/lib/container";
import { getWhatsAppContainer } from "@/lib/whatsapp-container";
import { toMessageDTO } from "@/lib/message-dto";
import { resolveSendTarget, sendFailureResponse } from "@/lib/send-plumbing";
import { toProviderInteractive } from "@/lib/interactive-payload";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { conversationId: rawConversationId } = await context.params;
    const json: unknown = await request.json().catch(() => ({}));
    const body = (json ?? {}) as Record<string, unknown>;
    const input = parseOrThrow(sendInteractiveMessageRequestSchema, {
      conversationId: rawConversationId,
      bodyText: body.bodyText,
      interactive: body.interactive,
    });

    const { repositories, tenant } = await getContainer();
    const accountId = AccountId(tenant.tenantId);
    const conversationId = input.conversationId as ConversationId;

    const target = await resolveSendTarget(tenant, repositories, conversationId);
    if (!target.ok) return target.response;
    const { conversation, contact, config } = target.value;

    const { service } = await getWhatsAppContainer();
    const result = await service.sendInteractive({
      accountId,
      contactId: conversation.contactId,
      phoneNumberId: config.phoneNumberId,
      to: contact.phoneNumber,
      interactive: toProviderInteractive(input.bodyText, input.interactive),
    });

    if (!result.ok) return sendFailureResponse(result.error);

    const inbox = new InboxService({
      conversations: repositories.conversations,
      messages: repositories.messages,
    });
    const outboundResult = await inbox.recordOutbound(tenant, conversationId, {
      contactId: conversation.contactId,
      type: "interactive",
      body: input.bodyText,
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
