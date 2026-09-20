/**
 * `POST /api/conversations/[conversationId]/messages/template` — send an
 * approved WhatsApp template message in an existing conversation.
 *
 * Mirrors `.../messages/send/route.ts` (the text route) exactly for
 * container wiring, consent/suppression handling (via `resolveSendTarget` /
 * `sendFailureResponse`, `@/lib/send-plumbing`) and outbound persistence.
 * The one addition is the template-specific validation below, run BEFORE
 * the provider is ever called — each check mirrors a real Meta rejection
 * (META_ERROR_TAXONOMY.md §3), so refusing locally saves the round trip and
 * gives the operator the real reason instead of a generic provider error.
 */
import { NextResponse, type NextRequest } from "next/server";
import { sendTemplateMessageRequestSchema } from "@packages/contracts/src/messages";
import { AccountId } from "@packages/domain/src/ids";
import type { ConversationId } from "@packages/domain/src/ids";
import type { MetaTemplateSendComponent } from "@modules/whatsapp/domain/whatsapp-provider.interface";
import { renderTemplateBody } from "@modules/whatsapp/domain/template-render";
import { InboxService } from "@modules/conversations/application/inbox-service";
import { getContainer } from "@/lib/container";
import { getWhatsAppContainer } from "@/lib/whatsapp-container";
import { toMessageDTO } from "@/lib/message-dto";
import { resolveSendTarget, sendFailureResponse } from "@/lib/send-plumbing";
import { fail, internalError, isZodError, notFoundError, ok, parseOrThrow, validationError } from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { conversationId: rawConversationId } = await context.params;
    const json: unknown = await request.json().catch(() => ({}));
    const body = (json ?? {}) as Record<string, unknown>;
    const input = parseOrThrow(sendTemplateMessageRequestSchema, {
      conversationId: rawConversationId,
      templateId: body.templateId,
      languageCode: body.languageCode,
      parameters: body.parameters,
    });

    const { repositories, tenant } = await getContainer();
    const accountId = AccountId(tenant.tenantId);
    const conversationId = input.conversationId as ConversationId;

    const target = await resolveSendTarget(tenant, repositories, conversationId);
    if (!target.ok) return target.response;
    const { conversation, contact, config } = target.value;

    const template = await repositories.messageTemplates.findById(accountId, input.templateId);
    if (!template) return notFoundError("template");

    // Meta rejects a send on a non-approved template (132001) — refusing
    // locally saves the round trip and gives the operator the real reason.
    if (template.status !== "approved") {
      return fail(
        {
          code: "template_not_approved",
          laymanMessage: "This template hasn't been approved by Meta yet, so it can't be sent.",
        },
        409,
      );
    }

    // Our mirror row is keyed to one language; a different one names a
    // template we do not actually hold a copy of.
    if (input.languageCode !== template.language) {
      return fail(
        {
          code: "template_language_mismatch",
          laymanMessage: "That language doesn't match the approved version of this template.",
        },
        422,
      );
    }

    // Meta 132000 — parameter count must match the template definition.
    if (input.parameters.length !== template.variableCount) {
      return fail(
        {
          code: "template_parameter_count",
          laymanMessage: `This template needs ${template.variableCount} parameter(s); ${input.parameters.length} were given.`,
        },
        422,
      );
    }

    // Never an empty `body` component — Meta rejects that outright.
    const components: readonly MetaTemplateSendComponent[] | undefined =
      input.parameters.length > 0
        ? [{ type: "body", parameters: input.parameters.map((text) => ({ type: "text", text })) }]
        : undefined;

    const { service } = await getWhatsAppContainer();
    const result = await service.sendTemplate({
      accountId,
      contactId: conversation.contactId,
      phoneNumberId: config.phoneNumberId,
      to: contact.phoneNumber,
      templateName: template.name,
      languageCode: template.language,
      components,
    });

    if (!result.ok) return sendFailureResponse(result.error);

    const inbox = new InboxService({
      conversations: repositories.conversations,
      messages: repositories.messages,
    });
    const outboundResult = await inbox.recordOutbound(tenant, conversationId, {
      contactId: conversation.contactId,
      type: "template",
      body: renderTemplateBody(template.bodyText, input.parameters),
      templateId: template.id,
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
