/**
 * SQL implementation of `PlatformRoleGrantPort` over `AtomicBatchDatabaseProvider`.
 *
 * Schema: db/migrations/{d1,postgres}/0004_platform_admin.sql, `platform_admins`
 * — one row per user, `platform_role` + `granted_by`/`granted_at` +
 * nullable `revoked_at`. Per SUPER_ADMIN_CONSOLE.md §5/§6: "Platform roles
 * granted only by platform_superadmin, with a 2-person rule." The 2-person
 * rule (grantor cannot be the grantee) is enforced here, at the persistence
 * boundary, exactly as `ports.ts` documents; the tier check ("only
 * `platform_superadmin` may call `grant`/`revoke`") is `PlatformPermissionService`'s
 * job one layer up (ports.ts's file header), not this repository's.
 *
 * `platform_admins` is a grant table keyed by `user_id`, not tenant-scoped —
 * see the migration's header. Every statement here is `tenant-scope-exempt`
 * for that reason, same as `audit-log-repository.ts`.
 *
 * Every write appends to `platform_audit_log` in the SAME `batch()` as the
 * grant/revoke it documents (module HARD RULE 3) via `auditInsertBatchQuery`
 * from `./audit-log-repository`.
 */
import { randomUUID } from "node:crypto";
import type { AtomicBatchDatabaseProvider, Row } from "@nexara/core/database";
import { isPlatformRole, type PlatformRole, type VerifiedPlatformPrincipal } from "@nexara/core/rbac";
import { AppError } from "@shared/errors";
import type { UserId } from "@shared/types";
import { createAuditEntry } from "../domain/audit";
import type { PlatformRoleGrant, PlatformRoleGrantPort } from "../application/ports";
import { auditInsertBatchQuery } from "./audit-log-repository";

function toGrant(row: Row): PlatformRoleGrant {
  const role = String(row.platform_role);
  return {
    userId: String(row.user_id),
    platformRole: isPlatformRole(role) ? role : "platform_support",
    grantedBy: String(row.granted_by),
    grantedAt: String(row.granted_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
  };
}

export class SqlPlatformRoleGrantRepository implements PlatformRoleGrantPort {
  constructor(private readonly db: AtomicBatchDatabaseProvider) {}

  /**
   * 2-person rule (ports.ts): REJECTS `grantedBy === userId` before touching
   * the database — the same rule `approveComplianceCase` applies to case
   * approval (SUPER_ADMIN_CONSOLE.md §5: "the same rule already applied to
   * platform-role grants").
   */
  async grant(
    principal: VerifiedPlatformPrincipal,
    userId: UserId,
    role: PlatformRole,
    reason: string,
  ): Promise<PlatformRoleGrant> {
    if (principal.userId === userId) {
      throw AppError.forbidden("Two-person rule: a platform role cannot be self-granted");
    }

    const grantedAt = new Date().toISOString();
    const auditEntry = createAuditEntry({
      id: randomUUID(),
      actor: principal.userId,
      platformRole: principal.platformRole,
      action: "platform_role:grant",
      targetResource: userId,
      reason,
      requestId: randomUUID(),
      occurredAt: new Date(grantedAt),
    });

    await this.db.batch([
      {
        sql: `-- tenant-scope-exempt: platform_admins is the platform-role
              -- grant table, keyed by user_id — not tenant-scoped
              -- (SUPER_ADMIN_CONSOLE.md §2).
              insert into platform_admins (user_id, platform_role, granted_by, granted_at, revoked_at)
              values ($1, $2, $3, $4, null)
              on conflict(user_id) do update set
                platform_role = excluded.platform_role,
                granted_by = excluded.granted_by,
                granted_at = excluded.granted_at,
                revoked_at = null`,
        params: [userId, role, principal.userId, grantedAt],
      },
      auditInsertBatchQuery(auditEntry),
    ]);

    return { userId, platformRole: role, grantedBy: principal.userId, grantedAt, revokedAt: null };
  }

  async revoke(principal: VerifiedPlatformPrincipal, userId: UserId, reason: string): Promise<void> {
    const revokedAt = new Date().toISOString();
    const auditEntry = createAuditEntry({
      id: randomUUID(),
      actor: principal.userId,
      platformRole: principal.platformRole,
      action: "platform_role:revoke",
      targetResource: userId,
      reason,
      requestId: randomUUID(),
      occurredAt: new Date(revokedAt),
    });

    await this.db.batch([
      {
        sql: `-- tenant-scope-exempt: platform_admins is the platform-role
              -- grant table, keyed by user_id — not tenant-scoped
              -- (SUPER_ADMIN_CONSOLE.md §2).
              update platform_admins set revoked_at = $2 where user_id = $1 and revoked_at is null`,
        params: [userId, revokedAt],
      },
      auditInsertBatchQuery(auditEntry),
    ]);
  }

  async findOwnGrant(userId: UserId): Promise<PlatformRoleGrant | null> {
    const { rows } = await this.db.query(
      `-- tenant-scope-exempt: platform_admins is the platform-role grant
       -- table, keyed by user_id — not tenant-scoped (SUPER_ADMIN_CONSOLE.md §2).
       select user_id, platform_role, granted_by, granted_at, revoked_at
         from platform_admins where user_id = $1 and revoked_at is null`,
      [userId],
    );
    const row = rows[0];
    if (row === undefined) {
      // No grant, so no platform event happened — an ordinary tenant user
      // landing on a platform URL is not staff activity, and writing a row
      // for it would fill the log with entries attributing a platform role
      // to people who hold none. Refusal is still observable: the route
      // returns 403, and whatever fronts it logs that.
      return null;
    }
    const grant = toGrant(row);

    // The role recorded is the one actually found, never a claimed one —
    // that is the whole reason this method takes no principal.
    const auditEntry = createAuditEntry({
      id: randomUUID(),
      actor: userId,
      platformRole: grant.platformRole,
      action: "platform_role:self_lookup",
      targetResource: userId,
      requestId: randomUUID(),
    });
    const q = auditInsertBatchQuery(auditEntry);
    await this.db.query(q.sql, q.params);

    return grant;
  }

  async findActiveForUser(
    principal: VerifiedPlatformPrincipal,
    userId: UserId,
  ): Promise<PlatformRoleGrant | null> {
    const { rows } = await this.db.query(
      `-- tenant-scope-exempt: platform_admins is the platform-role grant
       -- table, keyed by user_id — not tenant-scoped (SUPER_ADMIN_CONSOLE.md §2).
       select user_id, platform_role, granted_by, granted_at, revoked_at
         from platform_admins where user_id = $1 and revoked_at is null`,
      [userId],
    );
    const row = rows[0];

    // Reading platform-role grants is itself a cross-tenant-relevant,
    // auditable act (ports.ts file header) even though this lookup carries
    // no single target account.
    const auditEntry = createAuditEntry({
      id: randomUUID(),
      actor: principal.userId,
      platformRole: principal.platformRole,
      action: "platform_role:find_active_for_user",
      targetResource: userId,
      requestId: randomUUID(),
    });
    const q = auditInsertBatchQuery(auditEntry);
    await this.db.query(q.sql, q.params);

    return row === undefined ? null : toGrant(row);
  }
}
