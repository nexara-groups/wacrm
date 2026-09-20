import type { ProfileRepository, ProfileRecord } from "../../core/repositories/profile-repository.interface";
import type { TenantContext } from "../../core/context";
import type { DatabaseProvider, Row } from "../../core/database";
import { isRole } from "../../core/rbac";

/**
 * Portable SQL implementation of `ProfileRepository`, over the same
 * `users` table as `SqlUserRepository` (see that file and
 * `db/migrations/{d1,postgres}/0001_identity.sql` for the schema and the
 * `tenant_id` naming rationale). Only `$1`, `$2`, ... positional
 * parameters and ANSI-portable SQL are used, so these queries run
 * unmodified on both `D1DatabaseProvider` and `PostgresDatabaseProvider`.
 *
 * `updated_at` is computed in application code (an ISO-8601 string), never
 * with a database-side `NOW()`/`strftime()` call, so the same statement
 * text works on both dialects.
 */
export class SqlProfileRepository implements ProfileRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async findByUser(tenant: TenantContext, userId: string): Promise<ProfileRecord | null> {
    const { rows } = await this.db.query<ProfileRow>(
      `select user_id, tenant_id, email, display_name, role, created_at from users where tenant_id = $1 and user_id = $2 limit 1`,
      [tenant.tenantId, userId],
    );
    return rows[0] ? toProfileRecord(rows[0]) : null;
  }

  async updateDisplayName(
    tenant: TenantContext,
    userId: string,
    displayName: string | null,
  ): Promise<ProfileRecord | null> {
    const updatedAt = new Date().toISOString();
    const { rows } = await this.db.query<ProfileRow>(
      `update users
         set display_name = coalesce($3, display_name), updated_at = $4
       where tenant_id = $1 and user_id = $2
       returning user_id, tenant_id, email, display_name, role, created_at`,
      [tenant.tenantId, userId, displayName, updatedAt],
    );
    return rows[0] ? toProfileRecord(rows[0]) : null;
  }
}

interface ProfileRow extends Row {
  user_id: string;
  tenant_id: string;
  email: string;
  display_name: string | null;
  role: string;
  created_at: string;
}

function toProfileRecord(row: ProfileRow): ProfileRecord {
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    role: isRole(row.role) ? row.role : "member",
    createdAt: row.created_at,
  };
}
