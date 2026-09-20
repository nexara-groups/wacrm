/**
 * ConversationRepository / MessageRepository — the persistence PORTS the
 * application services depend on.
 *
 * Interfaces only. No SQL, no vendor SDK, no `core/database` import — see
 * ARCHITECTURE_MODEL.md §1 ("application / services... act via ports").
 * `infrastructure/conversation-repository.ts` and
 * `infrastructure/message-repository.ts` implement these against
 * `DatabaseProvider`.
 *
 * Every method takes a `TenantContext` and is expected to scope its query to
 * that tenant's `account_id` — this is the port's contract, enforced for
 * real by the SQL in the infrastructure layer (every statement there filters
 * `account_id`) and by the tenant-isolation tests in this module.
 */
import type { TenantContext } from "@nexara/core/context";
import type { ContactId, ConversationId, MessageId, RecipientStatus } from "@packages/domain";
import type { ConversationRecord, ConversationStatus } from "../domain/conversation";
import type {
  MessageAction,
  MessageActionType,
  MessageReaction,
  MessageReactionActorType,
  MessageRecord,
} from "../domain/message";
import type { SequenceCursor, SyncCursor } from "../domain/incremental-sync";
import type { MessageDirection, MessageType } from "@packages/domain";

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface ConversationFilter {
  readonly status?: ConversationStatus;
  /** `undefined` = no filter, `null` = only unassigned, a UserId = only that assignee. */
  readonly assignedUserId?: string | null;
  readonly contactId?: ContactId;
}

export interface ConversationListPage {
  readonly items: readonly ConversationRecord[];
  /** Cursor to fetch the next older page, ordered by `last_message_at` descending. `null` at the end. */
  readonly nextCursor: SequenceCursor | null;
}

/**
 * Filters for the page/pageSize inbox read (`ConversationRepository.search`)
 * — a superset of `ConversationFilter` adding the two predicates the wire
 * contract (`listConversationsQuerySchema`) asks for that the keyset `list`
 * does not support: `unreadOnly` and `search` (against the linked contact's
 * name/phone, resolved in SQL — never a full contacts table load).
 */
export interface ConversationSearchFilter {
  readonly status?: ConversationStatus;
  /** `undefined` = no filter, `null` = only unassigned, a UserId = only that assignee. */
  readonly assignedUserId?: string | null;
  /** `true` = only conversations with `unreadCount > 0`. */
  readonly unreadOnly?: boolean;
  /** Matches the linked contact's display name or phone number, case-insensitively. */
  readonly search?: string;
}

export interface ConversationSearchPage {
  readonly items: readonly ConversationRecord[];
  /** Real `COUNT(*)` over the filtered set — not the length of an in-memory walk. */
  readonly total: number;
}

export interface ConversationRepository {
  findById(tenant: TenantContext, id: ConversationId): Promise<ConversationRecord | null>;

  /** The one open conversation for a contact, or `null` if none exists yet
   *  (the caller — `InboxService.recordInbound` — creates one on first contact). */
  findByContactId(tenant: TenantContext, contactId: ContactId): Promise<ConversationRecord | null>;

  create(
    tenant: TenantContext,
    input: { readonly id: ConversationId; readonly contactId: ContactId; readonly now: string },
  ): Promise<ConversationRecord>;

  /** List/filter for the inbox view, newest-`last_message_at`-first, keyset-paginated (never a full table scan). */
  list(
    tenant: TenantContext,
    filter: ConversationFilter,
    opts: { readonly limit: number; readonly before?: SequenceCursor },
  ): Promise<ConversationListPage>;

  /** Incremental-sync read — everything changed after `cursor`, oldest-first, capped at `limit`. */
  listChangedSince(
    tenant: TenantContext,
    cursor: SyncCursor,
    limit: number,
  ): Promise<{ readonly items: readonly ConversationRecord[] }>;

  /** Persists a full replacement of the row (the service always hands back a whole `ConversationRecord` computed by the pure `domain/conversation.ts` functions). */
  save(tenant: TenantContext, conversation: ConversationRecord): Promise<ConversationRecord>;

  /**
   * page/pageSize + total read for the inbox LIST endpoint
   * (`GET /api/conversations`) — filters status, assignedUserId (including
   * an explicit "unassigned"), unreadOnly and search ALL IN SQL and returns
   * a real `COUNT(*)`, so the route never walks the full keyset-paginated
   * `list()` result to bridge page/cursor semantics. `list()` above stays
   * for callers that genuinely want keyset pagination (incremental screens);
   * this is the one for "give me page N of M, filtered."
   */
  search(
    tenant: TenantContext,
    filter: ConversationSearchFilter,
    page: { readonly page: number; readonly pageSize: number },
  ): Promise<ConversationSearchPage>;

  /**
   * Count of conversations with `unread_count > 0` for this tenant — the
   * "total unread" badge (mirrors the legacy `useTotalUnread` hook's
   * definition: conversations WITH unread mail, not a sum of individual
   * unread messages). Backed by an index on `(account_id, unread_count)` so
   * this stays cheap — see the migration.
   */
  countUnreadConversations(tenant: TenantContext): Promise<number>;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface NewMessageInput {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly contactId: ContactId;
  readonly direction: MessageDirection;
  readonly type: MessageType;
  readonly body: string | null;
  readonly templateId: string | null;
  readonly waMessageId: string | null;
  readonly replyToId: MessageId | null;
  readonly mediaRef: string | null;
  readonly status: RecipientStatus;
  readonly occurredAt: string;
}

export interface ThreadPage {
  readonly items: readonly MessageRecord[];
  /** Cursor to fetch the next OLDER page. `null` once the start of the thread is reached. */
  readonly nextCursor: SequenceCursor | null;
}

export interface ThreadSearchPage {
  readonly items: readonly MessageRecord[];
  /** Real `COUNT(*)` of the conversation's messages — not the length of an in-memory walk. */
  readonly total: number;
}

/** What one retention sweep did, and whether more remains. */
export interface RetentionSweepResult {
  /** Messages deleted. Never more than the plan's `maxDeletes`. */
  readonly deleted: number;
  /**
   * `true` when the sweep hit its ceiling and expired messages remain. The
   * caller runs it again — deleting fewer rows than exist is normal operation
   * here, not partial failure. See `domain/retention.ts` for why the ceiling
   * exists (a delete is a metered write on D1, and the first sweep of an
   * untrimmed account would otherwise be its entire history in one statement).
   */
  readonly more: boolean;
}

export interface MessageRepository {
  /**
   * Reads the tenant's resolved retention window, in days:
   * `accounts.message_retention_days_override ?? platform_settings
   * .default_message_retention_days`. Read fresh — changing the platform
   * default must move inheriting accounts immediately, the same rule seat
   * limits follow.
   */
  getRetentionConfig(tenant: TenantContext): Promise<{
    readonly accountRetentionDaysOverride: number | null;
    readonly platformDefaultRetentionDays: number;
  }>;

  /**
   * Deletes messages older than `cutoff`, at most `maxDeletes` of them,
   * oldest first.
   *
   * MUST null the `reply_to` of SURVIVING messages that point at rows being
   * deleted, in the SAME `batch()` as the delete. `messages.reply_to`
   * self-references `messages(id)`, D1 enforces foreign keys, and the sql.js
   * harness now does too (`PRAGMA foreign_keys = ON`) — so a delete that
   * orphans a reply is rejected outright and takes the whole sweep with it.
   * Getting this wrong does not corrupt data; it means retention silently
   * never runs.
   */
  sweepExpiredMessages(
    tenant: TenantContext,
    cutoff: string,
    maxDeletes: number,
  ): Promise<RetentionSweepResult>;
  /**
   * Inserts a new message. Idempotent on `(account_id, wamid)`: if
   * `input.waMessageId` is non-null and a row with that `wamid` already
   * exists for this tenant (Meta redelivered a webhook), the EXISTING row is
   * returned rather than a duplicate being created or an error thrown.
   */
  insert(tenant: TenantContext, input: NewMessageInput): Promise<MessageRecord>;

  findById(tenant: TenantContext, id: MessageId): Promise<MessageRecord | null>;
  findByWaMessageId(tenant: TenantContext, waMessageId: string): Promise<MessageRecord | null>;

  /** Persists a full replacement of the row (status transitions are computed by the pure `domain/message.ts` state machine, then saved here). */
  save(tenant: TenantContext, message: MessageRecord): Promise<MessageRecord>;

  /**
   * A thread page, newest-first, keyset-paginated by `(created_at, id)` —
   * NEVER loads a whole conversation. `opts.before` fetches strictly older
   * messages than that cursor; omitted fetches the most recent page.
   */
  listThread(
    tenant: TenantContext,
    conversationId: ConversationId,
    opts: { readonly limit: number; readonly before?: SequenceCursor },
  ): Promise<ThreadPage>;

  /**
   * page/pageSize + total read for `GET /api/conversations/[id]/messages` —
   * `COUNT(*)` + `LIMIT`/`OFFSET` in SQL, newest-first (matching
   * `listThread`'s ordering), so the route never walks the whole thread to
   * bridge page/cursor semantics.
   */
  listThreadPage(
    tenant: TenantContext,
    conversationId: ConversationId,
    page: { readonly page: number; readonly pageSize: number },
  ): Promise<ThreadSearchPage>;

  /** Incremental-sync read — everything changed after `cursor`, oldest-first, capped at `limit`. */
  listChangedSince(
    tenant: TenantContext,
    cursor: SyncCursor,
    limit: number,
  ): Promise<{ readonly items: readonly MessageRecord[] }>;

  listReactions(tenant: TenantContext, messageIds: readonly MessageId[]): Promise<readonly MessageReaction[]>;

  setReaction(
    tenant: TenantContext,
    input: {
      readonly id: string;
      readonly messageId: MessageId;
      readonly actorType: MessageReactionActorType;
      readonly actorId: string;
      readonly emoji: string;
      readonly now: string;
    },
  ): Promise<void>;

  recordAction(
    tenant: TenantContext,
    input: {
      readonly id: string;
      readonly conversationId: ConversationId;
      readonly messageId: MessageId | null;
      readonly actorUserId: string | null;
      readonly actionType: MessageActionType;
      readonly metadata: Readonly<Record<string, unknown>> | null;
      readonly now: string;
    },
  ): Promise<MessageAction>;
}
