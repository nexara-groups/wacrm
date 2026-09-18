/**
 * SQL implementation of `MessageRepository` over `DatabaseProvider`.
 *
 * Every statement filters `account_id` — the architecture guard enforces
 * this, and it is the only tenant boundary now that RLS is gone.
 *
 * `insert()` is idempotent on `(account_id, wamid)` per the port's contract
 * (Meta redelivers webhooks): it checks first, and — because two webhook
 * deliveries can race each other into this method concurrently — falls back
 * to the same lookup if the insert itself loses the unique-index race,
 * rather than letting a `UNIQUE constraint failed` bubble up as an error.
 *
 * `save()` persists a full replacement of the row. Status transitions are
 * decided by the pure, monotonic state machine in `domain/message.ts`
 * *before* this method is ever called — this class never interprets a
 * status value, it only writes the one it is given.
 *
 * Thread reads (`listThread`) are keyset-paginated by `(created_at, id)` and
 * bounded by the caller's `limit` — never a full table scan of a
 * conversation, however many messages it holds.
 *
 * Multi-statement writes use `batch()`, NEVER `transaction()` —
 * `D1DatabaseProvider.transaction()` throws unconditionally (D1 has no
 * interactive transactions), so a repository built on `transaction()`
 * compiles and passes every sql.js test before throwing on the production
 * target. See `modules/contacts/infrastructure/contact-repository.ts`'s
 * header.
 *
 * Schema: db/migrations/d1/0008_conversations.sql.
 */
import type { AtomicBatchDatabaseProvider, BatchQuery, Row } from "@nexara/core/database";
import type { TenantContext } from "@nexara/core/context";
import { AppError } from "@shared/errors";
import type { ConversationId, MessageId } from "@packages/domain";
import type {
  MessageAction,
  MessageActionType,
  MessageReaction,
  MessageReactionActorType,
  MessageRecord,
} from "../domain/message";
import type { SequenceCursor, SyncCursor } from "../domain/incremental-sync";
import type { MessageRepository, NewMessageInput, ThreadPage } from "../application/ports";

/** Columns of `messages`, in one place so every read maps identically. */
const COLUMNS = `id, account_id, conversation_id, contact_id, wamid, direction, type, body,
  template_id, media_ref, status, error_code, reply_to, sent_at, delivered_at, read_at,
  created_at, updated_at`;

function text(value: unknown): string {
  return String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toMessageRecord(row: Row): MessageRecord {
  return {
    id: text(row.id),
    accountId: text(row.account_id),
    conversationId: text(row.conversation_id),
    contactId: text(row.contact_id),
    waMessageId: nullableText(row.wamid),
    direction: text(row.direction),
    type: text(row.type),
    body: nullableText(row.body),
    templateId: nullableText(row.template_id),
    mediaRef: nullableText(row.media_ref),
    status: text(row.status),
    errorCode: nullableText(row.error_code),
    replyToId: nullableText(row.reply_to),
    sentAt: nullableText(row.sent_at),
    deliveredAt: nullableText(row.delivered_at),
    readAt: nullableText(row.read_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  } as unknown as MessageRecord;
}

function toMessageReaction(row: Row): MessageReaction {
  return {
    id: text(row.id),
    accountId: text(row.account_id),
    messageId: text(row.message_id),
    actorType: text(row.actor_type),
    actorId: text(row.actor_id),
    emoji: text(row.emoji),
    createdAt: text(row.created_at),
  } as unknown as MessageReaction;
}

/** Mirrors `domain/incremental-sync.ts`'s `isAfterCursor` in SQL — see the sibling
 *  `conversation-repository.ts` for the full explanation of why this shape is required. */
function syncCursorClause(cursor: SyncCursor, params: unknown[]): string {
  params.push(cursor.updatedAt);
  const at = `$${params.length}`;
  if (cursor.seenIds.length === 0) {
    return `updated_at >= ${at}`;
  }
  const seenPlaceholders = cursor.seenIds.map((id) => {
    params.push(id);
    return `$${params.length}`;
  });
  return `(updated_at > ${at} or (updated_at = ${at} and id not in (${seenPlaceholders.join(", ")})))`;
}

/** "Strictly older than this keyset position" — newest-first thread pagination never revisits
 *  a page once handed out, so (unlike sync) there is no same-timestamp-sibling race to track. */
function beforeCursorClause(before: SequenceCursor, params: unknown[]): string {
  params.push(before.at);
  const at = `$${params.length}`;
  params.push(before.id);
  const id = `$${params.length}`;
  return `(created_at < ${at} or (created_at = ${at} and id < ${id}))`;
}

export class SqlMessageRepository implements MessageRepository {
  constructor(private readonly db: AtomicBatchDatabaseProvider) {}

  async insert(tenant: TenantContext, input: NewMessageInput): Promise<MessageRecord> {
    if (input.waMessageId !== null) {
      const existing = await this.findByWaMessageId(tenant, input.waMessageId);
      if (existing !== null) return existing;
    }

    try {
      await this.db.query(
        `insert into messages
           (id, account_id, conversation_id, contact_id, wamid, direction, type, body,
            template_id, media_ref, status, error_code, reply_to, sent_at, delivered_at, read_at,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, null, $12, null, null, null, $13, $14)`,
        [
          input.id,
          tenant.tenantId,
          input.conversationId,
          input.contactId,
          input.waMessageId,
          input.direction,
          input.type,
          input.body,
          input.templateId,
          input.mediaRef,
          input.status,
          input.replyToId,
          input.occurredAt,
          input.occurredAt,
        ],
      );
    } catch (error) {
      // Lost the (account_id, wamid) unique-index race to a concurrent
      // redelivery — the winner's row is exactly what the caller wants back.
      if (input.waMessageId !== null) {
        const existing = await this.findByWaMessageId(tenant, input.waMessageId);
        if (existing !== null) return existing;
      }
      throw error;
    }

    const created = await this.findById(tenant, input.id);
    if (created === null) {
      throw AppError.database("message insert succeeded but the row could not be read back");
    }
    return created;
  }

  async findById(tenant: TenantContext, id: MessageId): Promise<MessageRecord | null> {
    const { rows } = await this.db.query(
      `select ${COLUMNS} from messages where account_id = $1 and id = $2`,
      [tenant.tenantId, id],
    );
    return rows[0] === undefined ? null : toMessageRecord(rows[0]);
  }

  async findByWaMessageId(tenant: TenantContext, waMessageId: string): Promise<MessageRecord | null> {
    const { rows } = await this.db.query(
      `select ${COLUMNS} from messages where account_id = $1 and wamid = $2`,
      [tenant.tenantId, waMessageId],
    );
    return rows[0] === undefined ? null : toMessageRecord(rows[0]);
  }

  async save(tenant: TenantContext, message: MessageRecord): Promise<MessageRecord> {
    const result = await this.db.query(
      `update messages
          set conversation_id = $3, contact_id = $4, wamid = $5, direction = $6, type = $7,
              body = $8, template_id = $9, media_ref = $10, status = $11, error_code = $12,
              reply_to = $13, sent_at = $14, delivered_at = $15, read_at = $16, updated_at = $17
        where account_id = $1 and id = $2`,
      [
        tenant.tenantId,
        message.id,
        message.conversationId,
        message.contactId,
        message.waMessageId,
        message.direction,
        message.type,
        message.body,
        message.templateId,
        message.mediaRef,
        message.status,
        message.errorCode,
        message.replyToId,
        message.sentAt,
        message.deliveredAt,
        message.readAt,
        message.updatedAt,
      ],
    );
    // A cross-tenant save must be a no-op, never a silent success against
    // another account's row.
    if (result.rowCount === 0) {
      throw AppError.notFound(`Message ${message.id} not found for this tenant`);
    }
    const saved = await this.findById(tenant, message.id);
    if (saved === null) {
      throw AppError.database("message save succeeded but the row could not be read back");
    }
    return saved;
  }

  async listThread(
    tenant: TenantContext,
    conversationId: ConversationId,
    opts: { readonly limit: number; readonly before?: SequenceCursor },
  ): Promise<ThreadPage> {
    const params: unknown[] = [tenant.tenantId, conversationId];
    const where: string[] = [];
    if (opts.before !== undefined) {
      where.push(beforeCursorClause(opts.before, params));
    }
    const extraSql = where.length > 0 ? ` and ${where.join(" and ")}` : "";
    const fetchLimit = Math.max(1, opts.limit) + 1;
    params.push(fetchLimit);

    const { rows } = await this.db.query(
      `select ${COLUMNS} from messages
        where account_id = $1 and conversation_id = $2${extraSql}
        order by created_at desc, id desc
        limit $${params.length}`,
      params,
    );

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const items = page.map(toMessageRecord);
    const last = items[items.length - 1];
    const nextCursor: SequenceCursor | null =
      hasMore && last !== undefined ? { at: last.createdAt, id: last.id } : null;

    return { items, nextCursor };
  }

  async listChangedSince(
    tenant: TenantContext,
    cursor: SyncCursor,
    limit: number,
  ): Promise<{ readonly items: readonly MessageRecord[] }> {
    const params: unknown[] = [tenant.tenantId];
    const cursorClause = syncCursorClause(cursor, params);
    params.push(Math.max(1, limit));
    const { rows } = await this.db.query(
      `select ${COLUMNS} from messages where account_id = $1 and ${cursorClause}
        order by updated_at asc, id asc
        limit $${params.length}`,
      params,
    );
    return { items: rows.map(toMessageRecord) };
  }

  async listReactions(
    tenant: TenantContext,
    messageIds: readonly MessageId[],
  ): Promise<readonly MessageReaction[]> {
    if (messageIds.length === 0) return [];
    const params: unknown[] = [tenant.tenantId];
    const placeholders = messageIds.map((id) => {
      params.push(id);
      return `$${params.length}`;
    });
    const { rows } = await this.db.query(
      `select id, account_id, message_id, actor_type, actor_id, emoji, created_at
         from message_reactions
        where account_id = $1 and message_id in (${placeholders.join(", ")})`,
      params,
    );
    return rows.map(toMessageReaction);
  }

  /**
   * One reaction slot per (actor, message) — delete-then-insert in one atomic
   * `batch()`, mirroring `applyReaction`'s "swap in place" semantics
   * (`domain/message.ts`). `emoji === ""` removes the actor's reaction.
   */
  async setReaction(
    tenant: TenantContext,
    input: {
      readonly id: string;
      readonly messageId: MessageId;
      readonly actorType: MessageReactionActorType;
      readonly actorId: string;
      readonly emoji: string;
      readonly now: string;
    },
  ): Promise<void> {
    const queries: BatchQuery[] = [
      {
        sql: `delete from message_reactions
               where account_id = $1 and message_id = $2 and actor_type = $3 and actor_id = $4`,
        params: [tenant.tenantId, input.messageId, input.actorType, input.actorId],
      },
    ];
    if (input.emoji !== "") {
      queries.push({
        sql: `insert into message_reactions (id, account_id, message_id, actor_type, actor_id, emoji, created_at)
              values ($1, $2, $3, $4, $5, $6, $7)`,
        params: [input.id, tenant.tenantId, input.messageId, input.actorType, input.actorId, input.emoji, input.now],
      });
    }
    await this.db.batch(queries);
  }

  async recordAction(
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
  ): Promise<MessageAction> {
    await this.db.query(
      `insert into message_actions
         (id, account_id, conversation_id, message_id, actor_user_id, action_type, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.id,
        tenant.tenantId,
        input.conversationId,
        input.messageId,
        input.actorUserId,
        input.actionType,
        input.metadata === null ? null : JSON.stringify(input.metadata),
        input.now,
      ],
    );
    return {
      id: input.id,
      accountId: tenant.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      actorUserId: input.actorUserId,
      actionType: input.actionType,
      metadata: input.metadata,
      createdAt: input.now,
    } as unknown as MessageAction;
  }
}
