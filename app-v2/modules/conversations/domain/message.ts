/**
 * Message entity behaviour — direction, status progression, reply-quoting,
 * reactions, media references.
 *
 * The base `Message` shape (id, accountId, conversationId, contactId,
 * direction, type, body, templateId, waMessageId, status, timestamps) is
 * OWNED by `packages/domain/src/entities/message.ts` and reused here
 * verbatim, never redefined. `RecipientStatus` — the exact
 * pending/sent/delivered/read/replied/failed vocabulary this module's status
 * machine runs on — is likewise owned by
 * `packages/domain/src/status/recipient-status.ts` and reused as-is; see
 * that file's own `canTransitionRecipientStatus` for the strict single-hop
 * legal graph this module's `applyMessageStatusUpdate` builds on top of.
 *
 * `MessageRecord` below only ADDS the columns the base `Message` entity does
 * not carry (reply-quoting, media, error, and the three delivery-milestone
 * timestamps) — an extension, not a redefinition.
 */
import type {
  AccountId,
  ConversationId,
  ISODateString,
  Message as MessageEntity,
  MessageId,
  RecipientStatus,
} from "@packages/domain";
import { canTransitionRecipientStatus } from "@packages/domain";
import { AppError } from "@shared/errors";
import { err, ok, type Result } from "@shared/result";

// ---------------------------------------------------------------------------
// Entity extension
// ---------------------------------------------------------------------------

/**
 * A `Message` plus the columns `messages` (0008_conversations.sql) carries
 * that the shared entity does not: reply-quoting, media reference, the last
 * Meta error code (if `status === "failed"`), and the three delivery-
 * milestone timestamps a status transition stamps.
 */
export interface MessageRecord extends MessageEntity {
  /** The message this one quotes/replies to, or `null`. Always the same
   *  conversation (and account) as this message — see `validateReplyTarget`. */
  readonly replyToId: MessageId | null;
  /** Opaque `StorageProvider` reference (never a raw URL at rest). `null` unless `type === "media"`. */
  readonly mediaRef: string | null;
  /** The Meta error code that produced `status === "failed"`, or `null`. */
  readonly errorCode: string | null;
  readonly sentAt: ISODateString | null;
  readonly deliveredAt: ISODateString | null;
  readonly readAt: ISODateString | null;
}

/** `type === "media"` requires a `mediaRef`; every other type must not carry one. */
export function assertMediaInvariant(message: Pick<MessageRecord, "type" | "mediaRef">): void {
  if (message.type === "media" && message.mediaRef === null) {
    throw AppError.validation("a 'media' message must carry a mediaRef");
  }
  if (message.type !== "media" && message.mediaRef !== null) {
    throw AppError.validation(`a '${message.type}' message must not carry a mediaRef`);
  }
}

/**
 * A reply must quote a message in the SAME conversation (and therefore the
 * same account) — quoting across conversations is meaningless and would leak
 * one contact's thread into another's.
 */
export function validateReplyTarget(
  message: Pick<MessageRecord, "accountId" | "conversationId">,
  target: Pick<MessageRecord, "id" | "accountId" | "conversationId">,
): Result<MessageId, AppError> {
  if (target.accountId !== message.accountId || target.conversationId !== message.conversationId) {
    return err(AppError.validation("a message may only reply to another message in the same conversation"));
  }
  return ok(target.id);
}

// ---------------------------------------------------------------------------
// Status machine — monotonic, not strictly sequential
// ---------------------------------------------------------------------------

/**
 * Rank of each status ALONG THE HAPPY PATH — pending < sent < delivered <
 * read < replied. `failed` is deliberately excluded: it is not a point on
 * this line, it is a side branch (see `applyMessageStatusUpdate`).
 */
const HAPPY_PATH_RANK: Readonly<Record<Exclude<RecipientStatus, "failed">, number>> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  replied: 4,
};

/** The timestamp column a status transition stamps, or `null` for statuses with no dedicated column. */
export function timestampFieldForStatus(
  status: RecipientStatus,
): "sentAt" | "deliveredAt" | "readAt" | null {
  switch (status) {
    case "sent":
      return "sentAt";
    case "delivered":
      return "deliveredAt";
    case "read":
      return "readAt";
    default:
      return null;
  }
}

/**
 * Applies one incoming status report (typically a Meta delivery-receipt
 * webhook) to a message's current status.
 *
 * MONOTONIC, not strictly sequential: Meta's webhooks are not guaranteed to
 * arrive in send order — a `delivered` webhook can land before the `sent`
 * webhook for the same message (see the module doc). Rather than rejecting
 * that as illegal (which `canTransitionRecipientStatus` alone would, since it
 * only encodes single-hop adjacency), this function accepts any status
 * report that moves the message FURTHER ALONG the happy path than where it
 * already is, skipping intermediate hops as needed, and treats a report of
 * an earlier or equal milestone as a stale/duplicate no-op rather than an
 * error — webhook redelivery and out-of-order arrival are expected, not
 * exceptional.
 *
 * `failed` is the one genuine illegal-transition case: it may only apply
 * before the message is known to have reached the customer (`pending`,
 * `sent`, or `delivered`). Once a message is `read` or `replied`, a late
 * `failed` report is a contradiction — reject it rather than regress a
 * confirmed-delivered message to a failure state.
 */
export function applyMessageStatusUpdate(
  current: RecipientStatus,
  incoming: RecipientStatus,
): Result<RecipientStatus, AppError> {
  if (incoming === current) {
    // Idempotent replay of the same webhook — a no-op, not an error.
    return ok(current);
  }

  if (current === "failed" || current === "replied") {
    return err(AppError.validation(`'${current}' is terminal; cannot apply status '${incoming}'`));
  }

  if (incoming === "failed") {
    // The comment above claimed `current` could only be pending | sent |
    // delivered here, but `read` also reaches this branch — only `failed`
    // and `replied` are rejected as terminal above. That let a late `failed`
    // regress a message the customer demonstrably read, which is the exact
    // contradiction this function documents as illegal.
    if (current === "read") {
      return err(
        AppError.validation(
          "'read' confirms delivery; a later 'failed' report is contradictory and is rejected",
        ),
      );
    }
    // current is pending | sent | delivered here.
    return ok("failed");
  }

  const currentRank = HAPPY_PATH_RANK[current];
  const incomingRank = HAPPY_PATH_RANK[incoming];

  if (incomingRank <= currentRank) {
    // A stale/duplicate/out-of-order report of an earlier or equal
    // milestone than one already recorded (e.g. a late `sent` webhook
    // arriving after `delivered` already landed). Monotonic: ignore it.
    return ok(current);
  }

  return ok(incoming);
}

/**
 * True when `from -> to` is BOTH a legal single hop per
 * `canTransitionRecipientStatus` AND accepted by the monotonic machine above
 * — i.e. the strict adjacency case that always applies regardless of
 * out-of-order arrival. Exposed for callers/tests that want to distinguish
 * "a clean, in-order transition" from "a skip-ahead recovery."
 */
export function isDirectStatusTransition(from: RecipientStatus, to: RecipientStatus): boolean {
  return canTransitionRecipientStatus(from, to);
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export type MessageReactionActorType = "user" | "contact";

export interface MessageReaction {
  readonly id: string;
  readonly accountId: AccountId;
  readonly messageId: MessageId;
  /** Who reacted: an inbox operator (`user`) or the contact (`contact`). */
  readonly actorType: MessageReactionActorType;
  /** `UserId` or `ContactId` depending on `actorType` — kept as `string` here
   *  since this type is a discriminated union of two different branded ids. */
  readonly actorId: string;
  readonly emoji: string;
  readonly createdAt: ISODateString;
}

export interface ReactionInput {
  readonly id: string;
  readonly accountId: AccountId;
  readonly messageId: MessageId;
  readonly actorType: MessageReactionActorType;
  readonly actorId: string;
  /** Empty string removes the actor's existing reaction on this message. */
  readonly emoji: string;
  readonly createdAt: ISODateString;
}

/**
 * Pure list transform: one reaction slot per (actor, message) — matches the
 * legacy inbox's reaction picker ("emoji === '' removes; otherwise adds/
 * swaps"). Applying a new emoji for an actor who already reacted on this
 * message replaces their previous reaction rather than adding a second one;
 * applying `""` removes it.
 */
export function applyReaction(
  existing: readonly MessageReaction[],
  input: ReactionInput,
): readonly MessageReaction[] {
  const withoutActor = existing.filter(
    (r) => !(r.messageId === input.messageId && r.actorType === input.actorType && r.actorId === input.actorId),
  );
  if (input.emoji === "") return withoutActor;
  return [
    ...withoutActor,
    {
      id: input.id,
      accountId: input.accountId,
      messageId: input.messageId,
      actorType: input.actorType,
      actorId: input.actorId,
      emoji: input.emoji,
      createdAt: input.createdAt,
    },
  ];
}

// ---------------------------------------------------------------------------
// Message actions (audit trail — assignment/status/notes tied to a message)
// ---------------------------------------------------------------------------

export type MessageActionType =
  | "sent"
  | "status_changed"
  | "reopened_conversation"
  | "note_added";

export interface MessageAction {
  readonly id: string;
  readonly accountId: AccountId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId | null;
  readonly actorUserId: string | null;
  readonly actionType: MessageActionType;
  /** Small, action-specific detail (e.g. `{ from: "sent", to: "delivered" }`). Never large payloads — this is an audit trail, not a document store. */
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAt: ISODateString;
}
