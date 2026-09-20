/**
 * `POST /api/conversations/[conversationId]/messages/media` — send a media
 * (image/video/document/audio) WhatsApp message in an existing conversation.
 *
 * Mirrors `.../messages/send/route.ts` (the text route) exactly for
 * container wiring, consent/suppression handling (via `resolveSendTarget` /
 * `sendFailureResponse`, `@/lib/send-plumbing`) and outbound persistence.
 */
import { NextResponse, type NextRequest } from "next/server";
import { sendMediaMessageRequestSchema } from "@packages/contracts/src/messages";
import { AccountId } from "@packages/domain/src/ids";
import type { ConversationId } from "@packages/domain/src/ids";
import type { MediaReference } from "@modules/whatsapp/domain/whatsapp-provider.interface";
import { InboxService } from "@modules/conversations/application/inbox-service";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
import { getWhatsAppContainer } from "@/lib/whatsapp-container";
import { toMessageDTO } from "@/lib/message-dto";
import { resolveSendTarget, sendFailureResponse } from "@/lib/send-plumbing";
import { fail, internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const authorized = await authorizeAction("messages:send");
    if (!authorized.ok) return authorized.response;

    const { conversationId: rawConversationId } = await context.params;
    const json: unknown = await request.json().catch(() => ({}));
    const body = (json ?? {}) as Record<string, unknown>;
    const input = parseOrThrow(sendMediaMessageRequestSchema, {
      conversationId: rawConversationId,
      mediaKind: body.mediaKind,
      mediaId: body.mediaId,
      mediaUrl: body.mediaUrl,
      caption: body.caption,
      fileName: body.fileName,
    });

    // The provider port's `MediaKind` has no "sticker" — Meta's send API
    // treats stickers as their own message type with a different payload
    // shape this port doesn't model. Handled explicitly rather than
    // widening the port or casting past the mismatch.
    if (input.mediaKind === "sticker") {
      return fail(
        { code: "unsupported_media_kind", laymanMessage: "Stickers can't be sent from here yet." },
        422,
      );
    }

    // The contract documents fileName as required for documents; Meta shows
    // a document with no name as a blank attachment.
    if (input.mediaKind === "document" && !input.fileName) {
      return fail(
        { code: "filename_required", laymanMessage: "A file name is required for document attachments." },
        422,
      );
    }

    const { repositories, tenant } = await getContainer();
    const accountId = AccountId(tenant.tenantId);
    const conversationId = input.conversationId as ConversationId;

    const target = await resolveSendTarget(tenant, repositories, conversationId);
    if (!target.ok) return target.response;
    const { conversation, contact, config } = target.value;

    // The schema's `refine` already guarantees exactly one of these is set.
    const media: MediaReference = input.mediaId ? { id: input.mediaId } : { link: input.mediaUrl! };

    const { service } = await getWhatsAppContainer();
    const result = await service.sendMedia({
      accountId,
      contactId: conversation.contactId,
      phoneNumberId: config.phoneNumberId,
      to: contact.phoneNumber,
      kind: input.mediaKind,
      media,
      caption: input.caption,
      filename: input.fileName,
    });

    if (!result.ok) return sendFailureResponse(result.error);

    const inbox = new InboxService({
      conversations: repositories.conversations,
      messages: repositories.messages,
    });
    const outboundResult = await inbox.recordOutbound(tenant, conversationId, {
      contactId: conversation.contactId,
      type: "media",
      body: input.caption ?? null,
      templateId: null,
      waMessageId: result.value.waMessageId,
      replyToId: null,
      // MUST be non-null here — `assertMediaInvariant` rejects a "media"
      // row with no mediaRef.
      mediaRef: input.mediaId ?? input.mediaUrl!,
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
