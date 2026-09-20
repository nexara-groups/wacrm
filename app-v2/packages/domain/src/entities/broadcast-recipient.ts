import type { AccountId, BroadcastId, ContactId, MessageId } from "../ids";
import type { Disposition } from "../status/disposition";
import type { RecipientStatus } from "../status/recipient-status";
import type { ISODateString } from "./common";

export interface BroadcastRecipient {
  /**
   * Opaque row id. Not one of the branded id types this package's spec
   * enumerates (AccountId/UserId/ContactId/ConversationId/MessageId/
   * BroadcastId/TemplateId) — left as a plain string rather than inventing
   * an unrequested brand.
   */
  readonly id: string;
  readonly broadcastId: BroadcastId;
  readonly accountId: AccountId;
  readonly contactId: ContactId;
  /** Set once the recipient's send has produced a Message (pending recipients have none yet). */
  readonly messageId: MessageId | null;
  readonly status: RecipientStatus;
  /** e.g. "131026" — META_ERROR_TAXONOMY.md §4 `broadcast_recipients.error_code`. */
  readonly errorCode: string | null;
  /** The classifier's customer-facing copy (§4b) — never Meta's raw string. */
  readonly errorMessage: string | null;
  readonly disposition: Disposition | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: ISODateString | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
