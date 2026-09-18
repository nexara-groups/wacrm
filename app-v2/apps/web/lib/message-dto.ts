/**
 * Maps the persistence-layer `MessageRecord`
 * (`@modules/conversations/domain/message`) onto the wire `Message` shape
 * (`@packages/contracts/src/messages`). Same discipline as
 * `contact-dto.ts`/`conversation-dto.ts`: parsed through the contract
 * schema so a field that drifts fails loudly instead of shipping quietly
 * wrong.
 *
 * `MessageRecord` carries extra columns (`replyToId`, `mediaRef`,
 * `errorCode`, `sentAt`, `deliveredAt`, `readAt`) that `messageSchema` does
 * not model — those are silently dropped by `.parse` (zod strips
 * unrecognized keys), same as `status`/`lastInboundAt` on
 * `conversation-dto.ts`. Delivery status itself (`pending`/`sent`/
 * `delivered`/`read`/`replied`/`failed`) IS on the wire via `status`, which
 * is what the inbox thread renders per-message — the three milestone
 * timestamps are the only thing lost, and nothing in this slice's screen
 * needs them individually.
 */
import { messageSchema, type Message } from "@packages/contracts/src/messages";
import type { MessageRecord } from "@modules/conversations/domain/message";

export function toMessageDTO(record: MessageRecord): Message {
  return messageSchema.parse({
    id: record.id,
    accountId: record.accountId,
    conversationId: record.conversationId,
    contactId: record.contactId,
    direction: record.direction,
    type: record.type,
    body: record.body,
    templateId: record.templateId,
    waMessageId: record.waMessageId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
