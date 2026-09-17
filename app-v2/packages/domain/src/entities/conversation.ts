import type { AccountId, ContactId, ConversationId, UserId } from "../ids";
import type { ISODateString } from "./common";

export interface Conversation {
  readonly id: ConversationId;
  readonly accountId: AccountId;
  readonly contactId: ContactId;
  readonly assignedUserId: UserId | null;
  readonly lastMessageAt: ISODateString | null;
  readonly unreadCount: number;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
