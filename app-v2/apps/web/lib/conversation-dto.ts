/**
 * Maps the persistence-layer `ConversationRecord`
 * (`@modules/conversations/domain/conversation`) onto the wire
 * `Conversation` shape (`@packages/contracts/src/conversations`). Same
 * discipline as `contact-dto.ts`/`broadcast-dto.ts`: parsed through the
 * contract schema so a field that drifts fails loudly instead of shipping
 * quietly wrong.
 *
 * GAP (see YOUR FILES / conversations route comments for the full writeup):
 * `ConversationRecord` carries `status` ("open" | "closed") and
 * `lastInboundAt`, but `conversationSchema` has neither field — there is no
 * open/closed status anywhere on the wire `Conversation`. `contactSchema
 * .parse` below therefore silently DROPS `status`/`lastInboundAt` (zod
 * strips unrecognized keys by default); that is intentional here, not a
 * bug, but it means no route or screen built against this DTO can ever
 * expose a conversation's open/closed state without a contract change,
 * which is out of scope for this task (packages/** is not modifiable).
 */
import { conversationSchema, type Conversation } from "@packages/contracts/src/conversations";
import type { ConversationRecord } from "@modules/conversations/domain/conversation";

export function toConversationDTO(record: ConversationRecord): Conversation {
  return conversationSchema.parse({
    id: record.id,
    accountId: record.accountId,
    contactId: record.contactId,
    assignedUserId: record.assignedUserId,
    lastMessageAt: record.lastMessageAt,
    unreadCount: record.unreadCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
