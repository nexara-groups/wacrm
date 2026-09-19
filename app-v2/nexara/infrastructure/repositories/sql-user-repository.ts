import type { UserRepository, UserRecord } from "../../core/repositories/user-repository.interface";
import type { TenantContext } from "../../core/context";
import type { DatabaseProvider, Row } from "../../core/database";
import { isRole } from "../../core/rbac";

/**
 * Portable SQL implementation of `UserRepository` — the identity read side
 * of the `users` table (see `db/migrations/{d1,postgres}/0001_identity.sql`).
 * Only `$1`, `$2`, ... positional parameters and ANSI-portable SQL are used
 * so the exact same queries run unmodified on both `D1DatabaseProvider` and
 * `PostgresDatabaseProvider` — no dialect-specific functions, no
 * database-side `NOW()`/`strftime()`.
 *
 * Every statement filters by `tenant_id` (the `TenantContext` value),
 * exactly matching `sql-credentials-repository.ts`'s column naming for the
 * same tenant concept — see the migration header comment for why this
 * table uses `tenant_id` rather than the `account_id` name most other
 * foundation tables use.
 */
export class SqlUserRepository implements UserRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async findById(tenant: TenantContext, userId: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<UserRow>(
      `select user_id, tenant_id, email, role, created_at from users where tenant_id = $1 and user_id = $2 limit 1`,
      [tenant.tenantId, userId],
    );
    return rows[0] ? toUserRecord(rows[0]) : null;
  }

  async findByEmail(tenant: TenantContext, email: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<UserRow>(
      `select user_id, tenant_id, email, role, created_at from users where tenant_id = $1 and email = $2 limit 1`,
      [tenant.tenantId, email],
    );
    return rows[0] ? toUserRecord(rows[0]) : null;
  }
}

interface UserRow extends Row {
  user_id: string;
  tenant_id: string;
  email: string;
  role: string;
  created_at: string;
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
    role: isRole(row.role) ? row.role : "member",
    createdAt: row.created_at,
  };
}
