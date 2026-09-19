import type { AccountId, ContactId, ConversationId, MessageId, TemplateId } from "../ids";
import type { RecipientStatus } from "../status/recipient-status";
import type { ISODateString } from "./common";

export type MessageDirection = "inbound" | "outbound";
export type MessageType = "text" | "template" | "media" | "interactive" | "system";

export interface Message {
  readonly id: MessageId;
  readonly accountId: AccountId;
  readonly conversationId: ConversationId;
  readonly contactId: ContactId;
  readonly direction: MessageDirection;
  readonly type: MessageType;
  readonly body: string | null;
  readonly templateId: TemplateId | null;
  /** Meta's WhatsApp message id (`wamid...`), once sent/received. */
  readonly waMessageId: string | null;
  /**
   * Outbound delivery status — reuses RecipientStatus because a single
   * outbound Message and a BroadcastRecipient's per-contact send share the
   * exact same lifecycle vocabulary (pending/sent/delivered/read/replied/failed).
   * Always "delivered" for inbound messages in practice, but the type
   * itself does not constrain that — callers set it to whatever reflects
   * reality.
   */
  readonly status: RecipientStatus;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
