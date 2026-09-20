/**
 * Conversation lifecycle: open/closed state, assignment to a member,
 * unread counting, last-message denormalisation.
 *
 * The base `Conversation` shape (id, accountId, contactId, assignedUserId,
 * lastMessageAt, unreadCount, createdAt, updatedAt) is OWNED by
 * `packages/domain/src/entities/conversation.ts` and reused here verbatim,
 * never redefined. `ConversationRecord` below only ADDS the two columns the
 * base entity does not carry — `status` (open/closed) and `lastInboundAt`
 * (the anchor for the 24h service window, see `./24h-window.ts`) — an
 * extension, not a redefinition.
 *
 * Pure — every function here takes a `ConversationRecord` and returns a new
 * one (or a primitive). No I/O, no clock reads: callers supply timestamps.
 */
import type { Conversation as ConversationEntity, ISODateString, UserId } from "@packages/domain";
import { AppError } from "@shared/errors";

export type ConversationStatus = "open" | "closed";

export interface ConversationRecord extends ConversationEntity {
  readonly status: ConversationStatus;
  /** Timestamp of the contact's most recent INBOUND message — the sole
   *  anchor for the 24h service window (`./24h-window.ts`). `null` until the
   *  contact has ever messaged in. Distinct from `lastMessageAt`, which
   *  updates on outbound sends too. */
  readonly lastInboundAt: ISODateString | null;
}

// ---------------------------------------------------------------------------
// Open/closed lifecycle
// ---------------------------------------------------------------------------

const LEGAL_STATUS_TRANSITIONS: Readonly<Record<ConversationStatus, readonly ConversationStatus[]>> = {
  open: ["closed"],
  closed: ["open"],
};

/** Pure predicate: is `from -> to` a legal conversation status transition? */
export function canTransitionConversationStatus(from: ConversationStatus, to: ConversationStatus): boolean {
  if (from === to) return false;
  return LEGAL_STATUS_TRANSITIONS[from].includes(to);
}

/** Marks a conversation closed. A no-op (same object back) if already closed. */
export function closeConversation(conversation: ConversationRecord): ConversationRecord {
  if (conversation.status === "closed") return conversation;
  return { ...conversation, status: "closed" };
}

/** Marks a conversation open. A no-op (same object back) if already open. */
export function reopenConversation(conversation: ConversationRecord): ConversationRecord {
  if (conversation.status === "open") return conversation;
  return { ...conversation, status: "open" };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** Assigns (or, with `null`, unassigns) a conversation to an account member. */
export function assignConversation(
  conversation: ConversationRecord,
  assigneeUserId: UserId | null,
): ConversationRecord {
  if (conversation.assignedUserId === assigneeUserId) return conversation;
  return { ...conversation, assignedUserId: assigneeUserId };
}

// ---------------------------------------------------------------------------
// Unread counting + last-message denormalisation
//
// INVARIANTS (explicit, because this counter is read on every inbox render
// and must never require a `count(*) over messages` to stay correct):
//   1. `unreadCount` is a maintained counter, never derived by counting rows.
//   2. `unreadCount` only ever increments — by exactly 1 — when a NEW
//      inbound message is recorded (`recordInboundMessage`). An outbound
//      message never changes it.
//   3. `unreadCount` only ever resets to exactly 0, via `markRead`. There is
//      no partial/per-message decrement — the inbox reads a THREAD, not
//      individual messages, so "read" is a whole-conversation action.
//   4. `unreadCount` is never negative (enforced by construction: it only
//      moves by +1 or reset-to-0 — `assertUnreadInvariant` exists as a
//      belt-and-braces check for callers that construct a `ConversationRecord`
//      by hand, e.g. from a row the persistence layer just returned).
//   5. Recording a duplicate inbound message (the same `wamid` redelivered
//      by Meta) must NOT double-increment — that is enforced at the
//      persistence boundary via the `messages(account_id, wamid)` UNIQUE
//      constraint (0008_conversations.sql), not here: this function is only
//      ever called once a NEW row has actually been inserted.
// ---------------------------------------------------------------------------

/** Throws if `unreadCount` has gone negative — a coding/invariant bug, never a legitimate state. */
export function assertUnreadInvariant(conversation: Pick<ConversationRecord, "unreadCount">): void {
  if (conversation.unreadCount < 0) {
    throw AppError.validation(`unreadCount invariant violated: ${conversation.unreadCount} < 0`);
  }
}

/**
 * Applies the effect of a newly-inserted INBOUND message: bumps the unread
 * counter by exactly one, advances both `lastMessageAt` and `lastInboundAt`
 * to `occurredAt`, and — since a new inbound message is the customer
 * re-engaging — reopens the conversation if it was closed.
 */
export function recordInboundMessage(
  conversation: ConversationRecord,
  occurredAt: ISODateString,
): ConversationRecord {
  return {
    ...conversation,
    unreadCount: conversation.unreadCount + 1,
    lastMessageAt: occurredAt,
    lastInboundAt: occurredAt,
    status: "open",
  };
}

/**
 * Applies the effect of a newly-inserted OUTBOUND message: advances
 * `lastMessageAt` only. `unreadCount` and `lastInboundAt` are untouched —
 * the unread badge and the 24h window are both driven solely by inbound
 * activity (invariant #2 above).
 */
export function recordOutboundMessage(
  conversation: ConversationRecord,
  occurredAt: ISODateString,
): ConversationRecord {
  return { ...conversation, lastMessageAt: occurredAt };
}

/** Resets the unread counter to zero. A no-op (same object back) if already zero — avoids a needless write. */
export function markRead(conversation: ConversationRecord): ConversationRecord {
  if (conversation.unreadCount === 0) return conversation;
  return { ...conversation, unreadCount: 0 };
}

/** True when a conversation should contribute to a badge/total-unread count (invariant: `unreadCount > 0`, never re-derived from messages). */
export function hasUnread(conversation: Pick<ConversationRecord, "unreadCount">): boolean {
  return conversation.unreadCount > 0;
}
