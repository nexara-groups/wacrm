/**
 * Portable SQL implementations of `BroadcastRepositoryPort` and
 * `BroadcastRecipientRepositoryPort` (see ../application/ports.ts), over
 * `broadcasts` / `broadcast_recipients`
 * (db/migrations/{d1,postgres}/0009_broadcasts.sql — this module's own
 * migration). Only `$1`, `$2`, ... positional parameters and
 * ANSI/SQLite-portable SQL are used, so the exact same statements run
 * unmodified on both `D1DatabaseProvider` and `PostgresDatabaseProvider`
 * (mirrors `nexara/infrastructure/repositories/sql-user-repository.ts`).
 *
 * EVERY statement filters by `account_id` — this table set does not use the
 * `tenant_id` column name (see 0001_identity.sql's header for why that one
 * table pair is the exception); `account_id` IS this table's tenant column,
 * i.e. its tenant_id equivalent, and every query below scopes on it.
 *
 * Recipient fan-out can be thousands of rows: `createMany` batches its
 * INSERTs, and every recipient read is either capped by an explicit `limit`
 * or paginated with a keyset cursor on `id` — never a single unbounded
 * fetch-all.
 *
 * All ids are application-generated (`crypto.randomUUID()`), all timestamps
 * are ISO-8601 strings produced by application code — matching every other
 * migration/repository pair in this set (see 0001_identity.sql's header).
 */
import type { DatabaseProvider, Row } from "@nexara/core/database";
import { AccountId, BroadcastId, ContactId, TemplateId, UserId } from "@packages/domain/src/ids";
import type { BroadcastRecipient } from "@packages/domain/src/entities/broadcast-recipient";
import type { BroadcastStatus } from "@packages/domain/src/status/broadcast-status";
import { BROADCAST_STATUSES } from "@packages/domain/src/status/broadcast-status";
import type { RecipientStatus } from "@packages/domain/src/status/recipient-status";
import { RECIPIENT_STATUSES } from "@packages/domain/src/status/recipient-status";
import type { Disposition } from "@packages/domain/src/status/disposition";
import { DISPOSITIONS } from "@packages/domain/src/status/disposition";
import type {
  BroadcastRecipientRepositoryPort,
  BroadcastRecord,
  BroadcastRepositoryPort,
  NewBroadcastInput,
  NewBroadcastRecipientInput,
  Page,
  RecipientOutcomeUpdate,
} from "../application/ports";

const DEFAULT_PAGE_SIZE = 200;

// Cloudflare D1 caps bound parameters per statement at 100 (see D1 platform
// limits). Each recipient row binds 7 params (id, account_id, broadcast_id,
// contact_id, status, created_at, updated_at) — chunk comfortably under
// that ceiling so `createMany` never depends on Postgres-only headroom.
const PARAMS_PER_RECIPIENT_ROW = 7;
const MAX_PARAMS_PER_INSERT_STATEMENT = 90;
const RECIPIENT_INSERT_CHUNK_SIZE = Math.max(1, Math.floor(MAX_PARAMS_PER_INSERT_STATEMENT / PARAMS_PER_RECIPIENT_ROW));

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function asBroadcastStatus(value: string): BroadcastStatus {
  return (BROADCAST_STATUSES as readonly string[]).includes(value) ? (value as BroadcastStatus) : "draft";
}
function asRecipientStatus(value: string): RecipientStatus {
  return (RECIPIENT_STATUSES as readonly string[]).includes(value) ? (value as RecipientStatus) : "pending";
}
function asDisposition(value: string | null): Disposition | null {
  if (value === null) return null;
  return (DISPOSITIONS as readonly string[]).includes(value) ? (value as Disposition) : null;
}

// ---------------------------------------------------------------------------
// broadcasts
// ---------------------------------------------------------------------------

interface BroadcastRow extends Row {
  id: string;
  account_id: string;
  name: string;
  template_id: string;
  status: string;
  scheduled_at: string | null;
  created_by: string;
  paused_at: string | null;
  pause_reason: string | null;
  total_recipients: number;
  skipped_count: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
}

function toBroadcastRecord(row: BroadcastRow): BroadcastRecord {
  return {
    id: BroadcastId(row.id),
    accountId: AccountId(row.account_id),
    name: row.name,
    templateId: TemplateId(row.template_id),
    status: asBroadcastStatus(row.status),
    scheduledAt: row.scheduled_at,
    createdBy: UserId(row.created_by),
    totalRecipients: row.total_recipients,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pausedAt: row.paused_at,
    pauseReason: row.pause_reason,
    skippedCount: row.skipped_count,
  };
}

const BROADCAST_COLUMNS = `id, account_id, name, template_id, status, scheduled_at, created_by,
       paused_at, pause_reason, total_recipients, skipped_count, sent_count, failed_count,
       created_at, updated_at`;

export class SqlBroadcastRepository implements BroadcastRepositoryPort {
  constructor(private readonly db: DatabaseProvider) {}

  async create(input: NewBroadcastInput): Promise<BroadcastRecord> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const { rows } = await this.db.query<BroadcastRow>(
      `insert into broadcasts
         (id, account_id, name, template_id, status, scheduled_at, created_by,
          paused_at, pause_reason, total_recipients, skipped_count, sent_count, failed_count,
          created_at, updated_at)
       values ($1, $2, $3, $4, 'draft', $5, $6, null, null, 0, 0, 0, 0, $7, $7)
       returning ${BROADCAST_COLUMNS}
       -- tenant_id equivalent for this table: account_id`,
      [id, input.accountId, input.name, input.templateId, input.scheduledAt, input.createdBy, now],
    );
    const row = rows[0];
    if (!row) throw new Error("broadcasts insert returned no row");
    return toBroadcastRecord(row);
  }

  async getById(accountId: AccountId, broadcastId: BroadcastId): Promise<BroadcastRecord | null> {
    const { rows } = await this.db.query<BroadcastRow>(
      `select ${BROADCAST_COLUMNS} from broadcasts
       where account_id = $1 and id = $2
       limit 1
       -- tenant_id equivalent for this table: account_id`,
      [accountId, broadcastId],
    );
    return rows[0] ? toBroadcastRecord(rows[0]) : null;
  }

  async listForAccount(accountId: AccountId, cursor: string | null, limit: number): Promise<Page<BroadcastRecord>> {
    const effectiveLimit = limit > 0 ? limit : DEFAULT_PAGE_SIZE;
    const { rows } = await this.db.query<BroadcastRow>(
      `select ${BROADCAST_COLUMNS} from broadcasts
       where account_id = $1 and ($2 is null or id > $2)
       order by id asc
       limit $3
       -- tenant_id equivalent for this table: account_id`,
      [accountId, cursor, effectiveLimit + 1],
    );
    return toPage(rows, effectiveLimit, toBroadcastRecord, (r) => r.id);
  }

  async updateStatus(accountId: AccountId, broadcastId: BroadcastId, status: BroadcastStatus): Promise<void> {
    await this.db.query(
      `update broadcasts set status = $3, updated_at = $4
       where account_id = $1 and id = $2
       -- tenant_id equivalent for this table: account_id`,
      [accountId, broadcastId, status, new Date().toISOString()],
    );
  }

  async setScheduledAt(accountId: AccountId, broadcastId: BroadcastId, scheduledAt: string | null): Promise<void> {
    await this.db.query(
      `update broadcasts set scheduled_at = $3, updated_at = $4
       where account_id = $1 and id = $2
       -- tenant_id equivalent for this table: account_id`,
      [accountId, broadcastId, scheduledAt, new Date().toISOString()],
    );
  }

  async setPaused(
    accountId: AccountId,
    broadcastId: BroadcastId,
    pausedAt: string | null,
    reason: string | null,
  ): Promise<void> {
    await this.db.query(
      `update broadcasts set paused_at = $3, pause_reason = $4, updated_at = $5
       where account_id = $1 and id = $2
       -- tenant_id equivalent for this table: account_id`,
      [accountId, broadcastId, pausedAt, pausedAt === null ? null : reason, new Date().toISOString()],
    );
  }

  async recordAudience(
    accountId: AccountId,
    broadcastId: BroadcastId,
    totalRecipients: number,
    skippedCount: number,
  ): Promise<void> {
    await this.db.query(
      `update broadcasts set total_recipients = $3, skipped_count = $4, updated_at = $5
       where account_id = $1 and id = $2
       -- tenant_id equivalent for this table: account_id`,
      [accountId, broadcastId, totalRecipients, skippedCount, new Date().toISOString()],
    );
  }

  async incrementCounts(
    accountId: AccountId,
    broadcastId: BroadcastId,
    delta: { readonly sent: number; readonly failed: number },
  ): Promise<void> {
    await this.db.query(
      `update broadcasts
         set sent_count = sent_count + $3, failed_count = failed_count + $4, updated_at = $5
       where account_id = $1 and id = $2
       -- tenant_id equivalent for this table: account_id`,
      [accountId, broadcastId, delta.sent, delta.failed, new Date().toISOString()],
    );
  }
}

// ---------------------------------------------------------------------------
// broadcast_recipients
// ---------------------------------------------------------------------------

interface RecipientRow extends Row {
  id: string;
  account_id: string;
  broadcast_id: string;
  contact_id: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  disposition: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  wamid: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  created_at: string;
  updated_at: string;
}

function toBroadcastRecipient(row: RecipientRow): BroadcastRecipient {
  return {
    id: row.id,
    broadcastId: BroadcastId(row.broadcast_id),
    accountId: AccountId(row.account_id),
    contactId: ContactId(row.contact_id),
    // This module's `broadcast_recipients` has no `message_id` column of
    // its own (see BroadcastRecipient's `messageId` doc: "Set once the
    // recipient's send has produced a Message" — the outbound Message row
    // itself is owned by the messaging module, not this one); wamid is
    // tracked separately below and is what this module owns.
    messageId: null,
    status: asRecipientStatus(row.status),
    errorCode: row.error_code,
    disposition: asDisposition(row.disposition),
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RECIPIENT_COLUMNS = `id, account_id, broadcast_id, contact_id, status, error_code, error_message,
       disposition, attempt_count, next_attempt_at, wamid, sent_at, delivered_at, read_at, replied_at,
       created_at, updated_at`;

export class SqlBroadcastRecipientRepository implements BroadcastRecipientRepositoryPort {
  constructor(private readonly db: DatabaseProvider) {}

  async createMany(inputs: readonly NewBroadcastRecipientInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const now = new Date().toISOString();

    for (const batch of chunk(inputs, RECIPIENT_INSERT_CHUNK_SIZE)) {
      const params: unknown[] = [];
      const valueTuples = batch.map((input, i) => {
        const base = i * PARAMS_PER_RECIPIENT_ROW;
        params.push(
          crypto.randomUUID(),
          input.accountId,
          input.broadcastId,
          input.contactId,
          "pending",
          now,
          now,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });

      await this.db.query(
        `insert into broadcast_recipients
           (id, account_id, broadcast_id, contact_id, status, created_at, updated_at)
         values ${valueTuples.join(", ")}
         -- tenant_id equivalent for this table: account_id`,
        params,
      );
    }
  }

  async listByBroadcast(
    accountId: AccountId,
    broadcastId: BroadcastId,
    cursor: string | null,
    limit: number,
  ): Promise<Page<BroadcastRecipient>> {
    const effectiveLimit = limit > 0 ? limit : DEFAULT_PAGE_SIZE;
    const { rows } = await this.db.query<RecipientRow>(
      `select ${RECIPIENT_COLUMNS} from broadcast_recipients
       where account_id = $1 and broadcast_id = $2 and ($3 is null or id > $3)
       order by id asc
       limit $4
       -- tenant_id equivalent for this table: account_id`,
      [accountId, broadcastId, cursor, effectiveLimit + 1],
    );
    return toPage(rows, effectiveLimit, toBroadcastRecipient, (r) => r.id);
  }

  async listDueForSend(
    accountId: AccountId,
    broadcastId: BroadcastId,
    now: string,
    limit: number,
  ): Promise<readonly BroadcastRecipient[]> {
    if (limit <= 0) return [];
    const { rows } = await this.db.query<RecipientRow>(
      `select ${RECIPIENT_COLUMNS} from broadcast_recipients
       where account_id = $1 and broadcast_id = $2 and status = 'pending'
         and (next_attempt_at is null or next_attempt_at <= $3)
       order by created_at asc, id asc
       limit $4
       -- tenant_id equivalent for this table: account_id`,
      [accountId, broadcastId, now, limit],
    );
    return rows.map(toBroadcastRecipient);
  }

  async listFailed(
    accountId: AccountId,
    broadcastId: BroadcastId,
    cursor: string | null,
    limit: number,
  ): Promise<Page<BroadcastRecipient>> {
    const effectiveLimit = limit > 0 ? limit : DEFAULT_PAGE_SIZE;
    const { rows } = await this.db.query<RecipientRow>(
      `select ${RECIPIENT_COLUMNS} from broadcast_recipients
       where account_id = $1 and broadcast_id = $2 and status = 'failed' and ($3 is null or id > $3)
       order by id asc
       limit $4
       -- tenant_id equivalent for this table: account_id`,
      [accountId, broadcastId, cursor, effectiveLimit + 1],
    );
    return toPage(rows, effectiveLimit, toBroadcastRecipient, (r) => r.id);
  }

  async listRecentSentAt(accountId: AccountId, broadcastId: BroadcastId, since: string): Promise<readonly string[]> {
    const { rows } = await this.db.query<{ sent_at: string } & Row>(
      `select sent_at from broadcast_recipients
       where account_id = $1 and broadcast_id = $2 and sent_at is not null and sent_at >= $3
       -- tenant_id equivalent for this table: account_id`,
      [accountId, broadcastId, since],
    );
    return rows.map((r) => r.sent_at);
  }

  async getById(accountId: AccountId, recipientId: string): Promise<BroadcastRecipient | null> {
    const { rows } = await this.db.query<RecipientRow>(
      `select ${RECIPIENT_COLUMNS} from broadcast_recipients
       where account_id = $1 and id = $2
       limit 1
       -- tenant_id equivalent for this table: account_id`,
      [accountId, recipientId],
    );
    return rows[0] ? toBroadcastRecipient(rows[0]) : null;
  }

  async applyOutcome(accountId: AccountId, recipientId: string, update: RecipientOutcomeUpdate): Promise<void> {
    await this.db.query(
      `update broadcast_recipients
         set status = $3, error_code = $4, error_message = $5, disposition = $6,
             attempt_count = $7, next_attempt_at = $8,
             wamid = coalesce($9, wamid),
             sent_at = coalesce($10, sent_at),
             delivered_at = coalesce($11, delivered_at),
             read_at = coalesce($12, read_at),
             replied_at = coalesce($13, replied_at),
             updated_at = $14
       where account_id = $1 and id = $2
       -- tenant_id equivalent for this table: account_id`,
      [
        accountId,
        recipientId,
        update.status,
        update.errorCode,
        update.errorMessage,
        update.disposition,
        update.attemptCount,
        update.nextAttemptAt,
        update.wamid ?? null,
        update.sentAt ?? null,
        update.deliveredAt ?? null,
        update.readAt ?? null,
        update.repliedAt ?? null,
        new Date().toISOString(),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// shared pagination helper — fetches `limit + 1` rows and uses the extra row
// only to decide whether a `nextCursor` exists, never returning it.
// ---------------------------------------------------------------------------
function toPage<TRow extends Row, T>(
  rows: readonly TRow[],
  limit: number,
  toItem: (row: TRow) => T,
  idOf: (row: TRow) => string,
): Page<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(toItem),
    nextCursor: hasMore && lastRow ? idOf(lastRow) : null,
  };
}
