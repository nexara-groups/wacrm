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
import { getWhatsAppContainer } from "@/lib/whatsapp-container";
import { toMessageDTO } from "@/lib/message-dto";
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
    const { conversationId: rawConversationId } = await context.params;
    const json: unknown = await request.json().catch(() => ({}));
    const input = parseOrThrow(sendTextMessageRequestSchema, {
      conversationId: rawConversationId,
      body: (json as { body?: unknown })?.body,
    });

    const { repositories, tenant } = await getContainer();
    const accountId = AccountId(tenant.tenantId);
    const conversationId = input.conversationId as ConversationId;

    const conversation = await repositories.conversations.findById(tenant, conversationId);
    if (!conversation) return notFoundError("conversation");

    const contact = await repositories.contacts.findById(tenant, conversation.contactId);
    if (!contact) return notFoundError("contact");

    const configs = await repositories.whatsappConfig.listByAccount(accountId);
    const config = configs[0];
    if (!config) {
      return fail(
        {
          code: "whatsapp_not_configured",
          laymanMessage: "No WhatsApp number is set up for this account yet.",
        },
        409,
      );
    }

    const { service } = await getWhatsAppContainer();
    const result = await service.sendText({
      accountId,
      contactId: conversation.contactId,
      phoneNumberId: config.phoneNumberId,
      to: contact.phoneNumber,
      text: input.body,
    });

    if (!result.ok) {
      switch (result.error.kind) {
        case "blocked": {
          const reason = result.error.reason;
          const laymanMessage =
            reason.kind === "opted_out"
              ? "This person asked to stop receiving messages. You can't message them until they contact you again."
              : reason.kind === "do_not_contact"
                ? "This contact is marked do-not-contact and has been skipped."
                : "This number can't receive WhatsApp messages. We've stopped sending to it.";
          return fail({ code: `blocked_${reason.kind}`, laymanMessage }, 409);
        }
        case "config_not_found":
          return fail(
            { code: "whatsapp_not_configured", laymanMessage: "No WhatsApp number is set up for this account yet." },
            409,
          );
        case "provider_failure":
          return fail(
            {
              code: "provider_failure",
              laymanMessage: "WhatsApp couldn't deliver this message right now. Please try again.",
              operatorHint: result.error.failure.metaError.message,
            },
            502,
          );
      }
    }

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
