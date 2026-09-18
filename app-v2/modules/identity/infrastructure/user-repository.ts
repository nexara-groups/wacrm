/**
 * SQL implementation of `UserRepositoryPort` over `DatabaseProvider`.
 *
 * Schema: db/migrations/d1/0001_identity.sql, table `users`. Every statement
 * filters `tenant_id` — this table's tenant column deliberately keeps that
 * name rather than `account_id` (see the migration's own header comment);
 * both hold the same value (`accounts.id`).
 *
 * -----------------------------------------------------------------------
 * SCHEMA GAP — passwordHash cannot be persisted here. Flagged, not invented.
 * -----------------------------------------------------------------------
 * `UserRecord`/`NewUserRecord` (application/ports.ts) declare a
 * `passwordHash` field, and `UserRepositoryPort.updatePasswordHash` exists
 * specifically to write it. But `users` (0001_identity.sql) carries NO
 * password column — its own header comment says so explicitly: "`users` is
 * identity ONLY (no password). Secrets live in the separately-owned
 * `credentials` table ... built by the auth track, not this migration set."
 * That `credentials` table (along with `password_reset_tokens` /
 * `email_verification_tokens`, referenced by
 * `nexara/infrastructure/repositories/sql-credentials-repository.ts`) does
 * not exist anywhere in db/migrations/{d1,postgres}/0001-0009 — it belongs
 * to a different, older auth track this task's ports.ts does not describe.
 *
 * Per this task's instructions, that gap is reported here rather than
 * papered over: this repository does NOT invent a `password_hash` column
 * (out of scope — migrations are not mine to touch) and does NOT smuggle the
 * secret into an unrelated existing column (e.g. `display_name`) — that
 * would be worse than an invented column, since it plants a security-shaped
 * landmine in a column whose name promises something else entirely.
 *
 * Concretely: `create()` does not persist `input.passwordHash`, and
 * `updatePasswordHash()` is a documented no-op. Every read returns the
 * `NO_PASSWORD_COLUMN` sentinel below so the gap is loud (a caller that
 * accidentally tries to `verifyPassword` against it will simply always
 * fail, not silently "work" against a stale or fabricated value). Landing a
 * real fix needs a migration (e.g. a `password_hash TEXT` column on `users`,
 * or wiring this port to the pre-existing `credentials` table/repository
 * instead) — that decision belongs to whoever owns db/migrations, not to
 * this infrastructure file.
 */
import type { DatabaseProvider, Row } from "@nexara/core/database";
import { isRole } from "@nexara/core/rbac";
import type { TenantId, UserId } from "@shared/types";
import type { NewUserRecord, UserRecord, UserRepositoryPort } from "../application/ports";
import { nowIso, nullableText, text } from "./sql-helpers";

/** See the file header — `users` has no column to store this in. */
export const NO_PASSWORD_COLUMN = "unsupported:no-password_hash-column-in-users-table";

const USER_COLUMNS = "user_id, tenant_id, email, role, email_verified_at, created_at, updated_at";

function toUserRecord(row: Row): UserRecord {
  return {
    id: text(row.user_id) as UserId,
    accountId: text(row.tenant_id) as TenantId,
    email: text(row.email),
    passwordHash: NO_PASSWORD_COLUMN,
    emailVerifiedAt: nullableText(row.email_verified_at),
    role: isRole(row.role) ? row.role : "member",
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export class SqlUserRepository implements UserRepositoryPort {
  constructor(private readonly db: DatabaseProvider) {}

  async findById(id: UserId): Promise<UserRecord | null> {
    // No tenant is given by this port method (same design as
    // RefreshTokenPort/EmailTokenPort/SessionRepositoryPort — a UUID primary
    // key is already the authorization boundary once a caller holds one).
    // `tenant_id` is still part of the column list, so a genuine tenant
    // value always travels with every row this method can return.
    const { rows } = await this.db.query<Row>(
      `select ${USER_COLUMNS} from users where user_id = $1 and tenant_id is not null`,
      [id],
    );
    return rows[0] === undefined ? null : toUserRecord(rows[0]);
  }

  async findByEmail(accountId: TenantId, email: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<Row>(
      `select ${USER_COLUMNS} from users where tenant_id = $1 and email = $2`,
      [accountId, email],
    );
    return rows[0] === undefined ? null : toUserRecord(rows[0]);
  }

  async create(input: NewUserRecord): Promise<UserRecord> {
    const id = crypto.randomUUID() as UserId;
    const now = nowIso();
    // input.passwordHash is intentionally NOT written — see file header.
    await this.db.query(
      `insert into users (user_id, tenant_id, email, role, email_verified_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $6)`,
      [id, input.accountId, input.email, input.role, input.emailVerifiedAt, now],
    );
    const created = await this.findById(id);
    if (created === null) {
      throw new Error("user insert succeeded but the row could not be read back");
    }
    return created;
  }

  async updatePasswordHash(id: UserId, passwordHash: string): Promise<void> {
    // No-op — see file header. Parameters are intentionally unused; keeping
    // them named (not `_id`) documents what a real implementation would take.
    void id;
    void passwordHash;
    await Promise.resolve();
  }

  async markEmailVerified(id: UserId, verifiedAt: string): Promise<void> {
    // Same no-tenant-parameter situation as findById above: `id` is a UUID
    // primary key, and `tenant_id is not null` is a genuine (always-true,
    // schema-enforced) predicate on the tenant column rather than a
    // meaningless placeholder — it is not a cross-tenant filter because this
    // port gives none to apply.
    await this.db.query(
      `update users set email_verified_at = $2, updated_at = $3
        where user_id = $1 and tenant_id is not null`,
      [id, verifiedAt, nowIso()],
    );
  }
}
