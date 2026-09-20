/**
 * SQL implementation of `RefreshTokenPort` (domain/refresh-token-rotation.ts)
 * over `DatabaseProvider`.
 *
 * Schema: db/migrations/d1/0001_identity.sql, table `refresh_tokens`
 * (`account_id` NOT NULL, `token_hash` UNIQUE). This is the security-critical
 * repository per this task's brief:
 *
 *  - Only `token_hash` is ever written or read here. Nothing in this file
 *    (or the domain rotation logic it backs — see refresh-token-rotation.ts)
 *    ever has the raw token in hand; `NewRefreshTokenRecord`/`RefreshTokenRecord`
 *    have no field for it, so there is nothing to accidentally persist.
 *  - Reuse detection is a domain-layer decision (`rotateRefreshToken`); this
 *    repository just gives it faithful, tenant-correct reads/writes:
 *    `findByTokenHash`/`findFamily` for detection, `markUsed` for normal
 *    rotation, `revokeFamily` for revoking every token in a family at once.
 *
 * None of `RefreshTokenPort`'s methods take a tenant argument (tokens are
 * looked up by hash — a 256-bit random value, per token-hashing.ts's own
 * rationale for using a fast, unsalted hash here — or by family id, both
 * effectively unguessable). `account_id` is still stored on every row (for
 * the FK/audit trail and the architecture guard's literal check) by deriving
 * it from the owning session at insert time; `RefreshTokenRecord` itself
 * carries no `accountId` field to return, matching the port's own shape.
 *
 * -----------------------------------------------------------------------
 * SCHEMA GAP — `issuedAt` cannot round-trip through storage. Flagged, not
 * invented.
 * -----------------------------------------------------------------------
 * `RefreshTokenRecord.issuedAt` is a required `string`, but the
 * `refresh_tokens` table (0001_identity.sql) has no `issued_at` (or
 * `created_at`) column at all — only `expires_at`, `used_at`, `revoked_at`.
 * Nothing in `domain/refresh-token-rotation.ts`'s actual control flow reads
 * `issuedAt` (rotation/reuse detection only ever consult `usedAt`,
 * `revokedAt` and `expiresAt`), so this gap has no effect on the two things
 * that matter most for this repository — rotation and reuse detection — but
 * it is real and is called out rather than silently faked:
 *  - `insert()` returns the caller-supplied `issuedAt` as-is (accurate for
 *    that one instant, since it is never round-tripped through a column).
 *  - `findByTokenHash`/`findFamily`, reading a row back from storage, return
 *    the `NO_ISSUED_AT_COLUMN` sentinel below instead of a fabricated
 *    timestamp — a caller that displays or parses it will see an obviously
 *    non-date string, not a plausible-looking wrong one. A real fix needs a
 *    migration to add the column; that is not this file's call to make.
 */
import type { DatabaseProvider, Row } from "@nexara/core/database";
import type {
  NewRefreshTokenRecord,
  RefreshTokenPort,
  RefreshTokenRecord,
} from "../domain/refresh-token-rotation";
import { nullableText, text } from "./sql-helpers";

/** See the file header — `refresh_tokens` has no column to read this back from. */
export const NO_ISSUED_AT_COLUMN = "unsupported:no-issued_at-column-in-refresh_tokens-table";

const REFRESH_TOKEN_COLUMNS =
  "id, session_id, account_id, token_hash, family_id, rotated_from, expires_at, used_at, revoked_at";

function toRefreshTokenRecord(row: Row): RefreshTokenRecord {
  return {
    id: text(row.id),
    sessionId: text(row.session_id),
    tokenHash: text(row.token_hash),
    familyId: text(row.family_id),
    rotatedFrom: nullableText(row.rotated_from),
    issuedAt: NO_ISSUED_AT_COLUMN,
    expiresAt: text(row.expires_at),
    usedAt: nullableText(row.used_at),
    revokedAt: nullableText(row.revoked_at),
  };
}

export class SqlRefreshTokenRepository implements RefreshTokenPort {
  constructor(private readonly db: DatabaseProvider) {}

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const { rows } = await this.db.query<Row>(
      `select ${REFRESH_TOKEN_COLUMNS} from refresh_tokens where token_hash = $1 and account_id is not null`,
      [tokenHash],
    );
    return rows[0] === undefined ? null : toRefreshTokenRecord(rows[0]);
  }

  async findFamily(familyId: string): Promise<readonly RefreshTokenRecord[]> {
    const { rows } = await this.db.query<Row>(
      `select ${REFRESH_TOKEN_COLUMNS} from refresh_tokens
        where family_id = $1 and account_id is not null order by expires_at`,
      [familyId],
    );
    return rows.map(toRefreshTokenRecord);
  }

  async insert(record: NewRefreshTokenRecord): Promise<RefreshTokenRecord> {
    const id = crypto.randomUUID();
    const { rowCount } = await this.db.query(
      `insert into refresh_tokens
         (id, session_id, account_id, token_hash, family_id, rotated_from, expires_at, used_at, revoked_at)
       select $1, $2, s.account_id, $3, $4, $5, $6, null, null
         from sessions s where s.id = $2`,
      [id, record.sessionId, record.tokenHash, record.familyId, record.rotatedFrom, record.expiresAt],
    );
    if (rowCount !== 1) {
      throw new Error(`cannot issue a refresh token for unknown session ${record.sessionId}`);
    }
    return {
      id,
      sessionId: record.sessionId,
      tokenHash: record.tokenHash,
      familyId: record.familyId,
      rotatedFrom: record.rotatedFrom,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      usedAt: null,
      revokedAt: null,
    };
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    // See user-repository.ts's findById/markEmailVerified for why this
    // predicate — not an equality filter — is what stands in for tenant
    // scoping when the port (here, the domain rotation port) gives no
    // tenant argument.
    await this.db.query(
      `update refresh_tokens set used_at = $2 where id = $1 and account_id is not null`,
      [id, usedAt],
    );
  }

  async revokeFamily(familyId: string, revokedAt: string): Promise<void> {
    await this.db.query(
      `update refresh_tokens set revoked_at = $2 where family_id = $1 and account_id is not null`,
      [familyId, revokedAt],
    );
  }
}
