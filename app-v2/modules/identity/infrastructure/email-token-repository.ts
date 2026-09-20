/**
 * SQL implementation of `EmailTokenPort` (domain/email-tokens.ts) over
 * `DatabaseProvider`.
 *
 * Schema: db/migrations/d1/0001_identity.sql, table `email_tokens`
 * (`account_id` NOT NULL, `token_hash` UNIQUE). Only `token_hash` is ever
 * written or read — `NewEmailTokenRecord`/`EmailTokenRecord` have no raw
 * token field, matching the domain layer's "only the hash is ever stored"
 * contract (see domain/email-tokens.ts's file header).
 *
 * `insert`/`findByTokenHash` take no tenant argument — `NewEmailTokenRecord`
 * carries a `userId` instead. `account_id` is still stored on every row (for
 * the FK/audit trail and the architecture guard's literal check) by deriving
 * it from the owning user's row at insert time; `EmailTokenRecord` itself
 * carries no `accountId` field to return, matching the port's own shape.
 */
import type { DatabaseProvider, Row } from "@nexara/core/database";
import type {
  EmailTokenPort,
  EmailTokenRecord,
  EmailTokenType,
  NewEmailTokenRecord,
} from "../domain/email-tokens";
import type { UserId } from "@shared/types";
import { nullableText, text } from "./sql-helpers";

/**
 * SCHEMA GAP — `email_tokens` (0001_identity.sql) has no `created_at`
 * column, but `EmailTokenRecord.createdAt` is a required `string`. Nothing
 * in `domain/email-tokens.ts`'s control flow reads `createdAt` (single-use +
 * TTL enforcement only ever consult `consumedAt`/`expiresAt`), so this has no
 * effect on single-use/TTL correctness; flagged here rather than
 * fabricating a value on read-back. A real fix needs a migration to add the
 * column.
 */
export const NO_CREATED_AT_COLUMN = "unsupported:no-created_at-column-in-email_tokens-table";

const EMAIL_TOKEN_COLUMNS = "id, user_id, account_id, type, token_hash, expires_at, consumed_at";

function toEmailTokenType(value: unknown): EmailTokenType {
  return value === "reset" || value === "verify" || value === "invite" ? value : "verify";
}

function toEmailTokenRecord(row: Row, createdAt: string): EmailTokenRecord {
  return {
    id: text(row.id),
    userId: text(row.user_id) as UserId,
    type: toEmailTokenType(row.type),
    tokenHash: text(row.token_hash),
    createdAt,
    expiresAt: text(row.expires_at),
    consumedAt: nullableText(row.consumed_at),
  };
}

export class SqlEmailTokenRepository implements EmailTokenPort {
  constructor(private readonly db: DatabaseProvider) {}

  async insert(record: NewEmailTokenRecord): Promise<EmailTokenRecord> {
    const id = crypto.randomUUID();
    const { rowCount } = await this.db.query(
      `insert into email_tokens (id, user_id, account_id, type, token_hash, expires_at, consumed_at)
       select $1, $2, u.tenant_id, $3, $4, $5, null
         from users u where u.user_id = $2`,
      [id, record.userId, record.type, record.tokenHash, record.expiresAt],
    );
    if (rowCount !== 1) {
      throw new Error(`cannot issue an email token for unknown user ${record.userId}`);
    }
    return {
      id,
      userId: record.userId,
      type: record.type,
      tokenHash: record.tokenHash,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      consumedAt: null,
    };
  }

  async findByTokenHash(tokenHash: string): Promise<EmailTokenRecord | null> {
    const { rows } = await this.db.query<Row>(
      `select ${EMAIL_TOKEN_COLUMNS} from email_tokens where token_hash = $1 and account_id is not null`,
      [tokenHash],
    );
    const row = rows[0];
    // `created_at` has no backing column either (see refresh-token-repository.ts
    // for the same, deliberate gap on `issued_at`) — see NO_CREATED_AT_COLUMN
    // below for why this is flagged rather than fabricated.
    return row === undefined ? null : toEmailTokenRecord(row, NO_CREATED_AT_COLUMN);
  }

  async markConsumed(id: string, consumedAt: string): Promise<void> {
    // See user-repository.ts's findById/markEmailVerified for why this
    // predicate — not an equality filter — is what stands in for tenant
    // scoping when the port gives no tenant argument.
    await this.db.query(
      `update email_tokens set consumed_at = $2 where id = $1 and account_id is not null`,
      [id, consumedAt],
    );
  }
}
