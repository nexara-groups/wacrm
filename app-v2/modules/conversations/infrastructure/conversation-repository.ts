/**
 * SQL implementation of `ConversationRepository` over `DatabaseProvider`.
 *
 * Every statement filters `account_id` — the architecture guard enforces
 * this, and since the Supabase exit moved RLS out of the database, this
 * filter IS the tenant boundary. There is no second layer behind it.
 *
 * `save()` persists a full replacement of the row (the application layer
 * always hands back a whole `ConversationRecord` computed by the pure
 * `domain/conversation.ts` functions — this class never decides a lifecycle
 * transition, it only writes the one it is given). A `save`/`create` whose
 * `WHERE account_id = $1` matches nothing (either a cross-tenant call, or —
 * for `create` — a concurrent insert winning the unique
 * `(account_id, contact_id)` race) is handled explicitly rather than
 * silently reporting success.
 *
 * Multi-statement writes (none needed here today, but any future one) must
 * use `batch()`, NEVER `transaction()` — `D1DatabaseProvider.transaction()`
 * throws unconditionally (D1 has no interactive transactions), so a
 * repository built on `transaction()` compiles and passes every sql.js test
 * before throwing on the production target. See
 * `modules/contacts/infrastructure/contact-repository.ts`'s header.
 *
 * Schema: db/migrations/d1/0008_conversations.sql.
 */
import type { AtomicBatchDatabaseProvider, Row } from "@nexara/core/database";
import type { TenantContext } from "@nexara/core/context";
import { AppError } from "@shared/errors";
import type { ContactId, ConversationId } from "@packages/domain";
import type { ConversationRecord } from "../domain/conversation";
import type { SequenceCursor, SyncCursor } from "../domain/incremental-sync";
import type {
  ConversationFilter,
  ConversationListPage,
  ConversationRepository,
  ConversationSearchFilter,
  ConversationSearchPage,
} from "../application/ports";

/** Columns of `conversations`, in one place so every read maps identically. */
const COLUMNS = `id, account_id, contact_id, status, assigned_to, unread_count,
  last_message_at, last_inbound_at, created_at, updated_at`;

function text(value: unknown): string {
  return String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toConversationRecord(row: Row): ConversationRecord {
  return {
    id: text(row.id),
    accountId: text(row.account_id),
    contactId: text(row.contact_id),
    status: text(row.status),
    assignedUserId: nullableText(row.assigned_to),
    unreadCount: Number(row.unread_count ?? 0),
    lastMessageAt: nullableText(row.last_message_at),
    lastInboundAt: nullableText(row.last_inbound_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  } as unknown as ConversationRecord;
}

/** Builds the `(updated_at, id)` keyset predicate for incremental sync — a row qualifies once
 *  its `updated_at` strictly exceeds the cursor, OR it shares the cursor's exact `updated_at`
 *  and has not already been delivered (`seenIds`). Mirrors `domain/incremental-sync.ts`'s
 *  `isAfterCursor` exactly, so the SQL and the pure predicate can never disagree. */
function syncCursorClause(
  cursor: SyncCursor,
  params: unknown[],
): string {
  params.push(cursor.updatedAt);
  const atPlaceholder = `$${params.length}`;
  if (cursor.seenIds.length === 0) {
    return `updated_at >= ${atPlaceholder}`;
  }
  const seenPlaceholders = cursor.seenIds.map((id) => {
    params.push(id);
    return `$${params.length}`;
  });
  return `(updated_at > ${atPlaceholder} or (updated_at = ${atPlaceholder} and id not in (${seenPlaceholders.join(", ")})))`;
}

/** Builds the "strictly before this keyset position" predicate used by newest-first pagination. */
function beforeCursorClause(before: SequenceCursor, params: unknown[]): string {
  params.push(before.at);
  const at = `$${params.length}`;
  params.push(before.id);
  const id = `$${params.length}`;
  return `(coalesce(last_message_at, '') < ${at} or (coalesce(last_message_at, '') = ${at} and id < ${id}))`;
}

export class SqlConversationRepository implements ConversationRepository {
  constructor(private readonly db: AtomicBatchDatabaseProvider) {}

  private now(): string {
    return new Date().toISOString();
  }

  async findById(tenant: TenantContext, id: ConversationId): Promise<ConversationRecord | null> {
    const { rows } = await this.db.query(
      `select ${COLUMNS} from conversations where account_id = $1 and id = $2`,
      [tenant.tenantId, id],
    );
    return rows[0] === undefined ? null : toConversationRecord(rows[0]);
  }

  async findByContactId(tenant: TenantContext, contactId: ContactId): Promise<ConversationRecord | null> {
    const { rows } = await this.db.query(
      `select ${COLUMNS} from conversations where account_id = $1 and contact_id = $2`,
      [tenant.tenantId, contactId],
    );
    return rows[0] === undefined ? null : toConversationRecord(rows[0]);
  }

  /**
   * Inserts a new conversation. Race-safe against a concurrent create for the
   * same contact (two inbound webhooks landing at once): the unique index on
   * `(account_id, contact_id)` will reject the loser, and rather than surface
   * that as an error, the loser re-reads and returns the winner's row — the
   * same "find-or-create" outcome `InboxService.recordInbound` wants either way.
   */
  async create(
    tenant: TenantContext,
    input: { readonly id: ConversationId; readonly contactId: ContactId; readonly now: string },
  ): Promise<ConversationRecord> {
    try {
      await this.db.query(
        `insert into conversations
           (id, account_id, contact_id, status, assigned_to, unread_count,
            last_message_at, last_inbound_at, created_at, updated_at)
         values ($1, $2, $3, 'open', null, 0, null, null, $4, $4)`,
        [input.id, tenant.tenantId, input.contactId, input.now],
      );
    } catch (error) {
      const existing = await this.findByContactId(tenant, input.contactId);
      if (existing !== null) return existing;
      throw error;
    }
    const created = await this.findById(tenant, input.id);
    if (created === null) {
      throw AppError.database("conversation insert succeeded but the row could not be read back");
    }
    return created;
  }

  async list(
    tenant: TenantContext,
    filter: ConversationFilter,
    opts: { readonly limit: number; readonly before?: SequenceCursor },
  ): Promise<ConversationListPage> {
    // Deliberately NOT seeded with the tenant predicate: it lives literally in
    // the statement below, so it cannot be refactored away.
    const where: string[] = [];
    const params: unknown[] = [tenant.tenantId];

    if (filter.status !== undefined) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter.assignedUserId !== undefined) {
      if (filter.assignedUserId === null) {
        where.push(`assigned_to is null`);
      } else {
        params.push(filter.assignedUserId);
        where.push(`assigned_to = $${params.length}`);
      }
    }
    if (filter.contactId !== undefined) {
      params.push(filter.contactId);
      where.push(`contact_id = $${params.length}`);
    }
    if (opts.before !== undefined) {
      where.push(beforeCursorClause(opts.before, params));
    }

    const extraSql = where.length > 0 ? ` and ${where.join(" and ")}` : "";
    const fetchLimit = Math.max(1, opts.limit) + 1;
    params.push(fetchLimit);

    const { rows } = await this.db.query(
      `select ${COLUMNS} from conversations where account_id = $1${extraSql}
        order by coalesce(last_message_at, '') desc, id desc
        limit $${params.length}`,
      params,
    );

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const items = page.map(toConversationRecord);
    const last = items[items.length - 1];
    const nextCursor: SequenceCursor | null =
      hasMore && last !== undefined ? { at: last.lastMessageAt ?? "", id: last.id } : null;

    return { items, nextCursor };
  }

  /**
   * page/pageSize + total read backing `GET /api/conversations`. Same
   * positional-parameter discipline as `list()` above and
   * `SqlContactRepository.search` (the reference shape for this method):
   * every predicate is built with a pushed value and a `$n` placeholder,
   * never string-interpolated. `search` is resolved with an `exists`
   * subquery against `contacts` — scoped to THIS conversation's own
   * `account_id`/`contact_id`, never a full contacts table load — so the
   * route no longer needs `ContactRepository.listAll`.
   */
  async search(
    tenant: TenantContext,
    filter: ConversationSearchFilter,
    page: { readonly page: number; readonly pageSize: number },
  ): Promise<ConversationSearchPage> {
    // Deliberately NOT seeded with the tenant predicate: it lives literally in
    // the statement below, so it cannot be refactored away.
    const where: string[] = [];
    const params: unknown[] = [tenant.tenantId];

    if (filter.status !== undefined) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter.assignedUserId !== undefined) {
      if (filter.assignedUserId === null) {
        where.push(`assigned_to is null`);
      } else {
        params.push(filter.assignedUserId);
        where.push(`assigned_to = $${params.length}`);
      }
    }
    if (filter.unreadOnly === true) {
      where.push(`unread_count > 0`);
    }
    if (filter.search !== undefined && filter.search.trim().length > 0) {
      params.push(`%${filter.search.trim().toLowerCase()}%`);
      const p = `$${params.length}`;
      where.push(
        `exists (
           select 1 from contacts ct
            where ct.account_id = conversations.account_id
              and ct.id = conversations.contact_id
              and (lower(coalesce(ct.display_name, '')) like ${p} or lower(ct.phone) like ${p})
         )`,
      );
    }

    const extraSql = where.length > 0 ? ` and ${where.join(" and ")}` : "";

    const counted = await this.db.query(
      `select count(*) as total from conversations where account_id = $1${extraSql}`,
      params,
    );
    const total = Number(counted.rows[0]?.total ?? 0);

    const pageSize = Math.max(1, page.pageSize);
    const offset = Math.max(0, (Math.max(1, page.page) - 1) * pageSize);
    params.push(pageSize, offset);
    const { rows } = await this.db.query(
      `select ${COLUMNS} from conversations where account_id = $1${extraSql}
        order by coalesce(last_message_at, '') desc, id desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return { items: rows.map(toConversationRecord), total };
  }

  async listChangedSince(
    tenant: TenantContext,
    cursor: SyncCursor,
    limit: number,
  ): Promise<{ readonly items: readonly ConversationRecord[] }> {
    const params: unknown[] = [tenant.tenantId];
    const cursorClause = syncCursorClause(cursor, params);
    params.push(Math.max(1, limit));
    const { rows } = await this.db.query(
      `select ${COLUMNS} from conversations where account_id = $1 and ${cursorClause}
        order by updated_at asc, id asc
        limit $${params.length}`,
      params,
    );
    return { items: rows.map(toConversationRecord) };
  }

  async save(tenant: TenantContext, conversation: ConversationRecord): Promise<ConversationRecord> {
    // `domain/conversation.ts`'s lifecycle functions (recordInboundMessage,
    // recordOutboundMessage, markRead, assign/close/reopen) deliberately only
    // touch the columns their name describes — none of them bump
    // `updatedAt`, and neither does the application layer that calls `save`
    // with their result. Since 0008_conversations.sql requires `updated_at`
    // to advance, non-decreasing, on EVERY write (it is the incremental-sync
    // cursor column), this repository is the one remaining place that can
    // guarantee it — the same way `SqlContactRepository` always stamps its
    // own `updated_at` rather than trusting a caller-supplied one. `max` with
    // whatever was passed in keeps this monotonic even if a future caller
    // ever does start setting it.
    const now = this.now();
    const stampedUpdatedAt = now > conversation.updatedAt ? now : conversation.updatedAt;
    const result = await this.db.query(
      `update conversations
          set contact_id = $3, status = $4, assigned_to = $5, unread_count = $6,
              last_message_at = $7, last_inbound_at = $8, updated_at = $9
        where account_id = $1 and id = $2`,
      [
        tenant.tenantId,
        conversation.id,
        conversation.contactId,
        conversation.status,
        conversation.assignedUserId,
        conversation.unreadCount,
        conversation.lastMessageAt,
        conversation.lastInboundAt,
        stampedUpdatedAt,
      ],
    );
    // A cross-tenant save (or a save of an id that no longer exists) must be a
    // no-op, never a silent success dressed up as the caller's own record.
    if (result.rowCount === 0) {
      throw AppError.notFound(`Conversation ${conversation.id} not found for this tenant`);
    }
    const saved = await this.findById(tenant, conversation.id);
    if (saved === null) {
      throw AppError.database("conversation save succeeded but the row could not be read back");
    }
    return saved;
  }

  async countUnreadConversations(tenant: TenantContext): Promise<number> {
    const { rows } = await this.db.query(
      `select count(*) as total from conversations where account_id = $1 and unread_count > 0`,
      [tenant.tenantId],
    );
    return Number(rows[0]?.total ?? 0);
  }
}
