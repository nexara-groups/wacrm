/**
 * Maps the persistence-layer `ConversationRecord`
 * (`@modules/conversations/domain/conversation`) onto the wire
 * `Conversation` shape (`@packages/contracts/src/conversations`). Same
 * discipline as `contact-dto.ts`/`broadcast-dto.ts`: parsed through the
 * contract schema so a field that drifts fails loudly instead of shipping
 * quietly wrong.
 *
 * `status` now crosses the wire. It previously did not, so zod stripped it
 * and a closed conversation looked exactly like an open one to every
 * screen. `lastInboundAt` is still dropped deliberately — it drives the
 * 24-hour messaging window server-side and no screen needs it.
 */
import { conversationSchema, type Conversation } from "@packages/contracts/src/conversations";
import type { ConversationRecord } from "@modules/conversations/domain/conversation";

export function toConversationDTO(record: ConversationRecord): Conversation {
  return conversationSchema.parse({
    id: record.id,
    accountId: record.accountId,
    contactId: record.contactId,
    assignedUserId: record.assignedUserId,
    status: record.status,
    lastMessageAt: record.lastMessageAt,
    unreadCount: record.unreadCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
