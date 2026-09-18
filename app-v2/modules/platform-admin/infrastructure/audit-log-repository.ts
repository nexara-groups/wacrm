/**
 * SQL implementation of `PlatformAuditLogPort` over `AtomicBatchDatabaseProvider`.
 *
 * Schema: db/migrations/{d1,postgres}/0004_platform_admin.sql, `platform_audit_log`.
 * Append-only by construction — see domain/audit.ts's file header. This file
 * adds no `update`/`delete` method; the only write member is `append`.
 *
 * `platform_audit_log` carries no `account_id`/`tenant_id` PRIMARY isolation
 * filter (it is the audit trail OF cross-tenant reads, keyed by
 * `target_account_id` — the *subject*, not a scoping boundary — see the
 * migration's file header and SUPER_ADMIN_CONSOLE.md §4). Every statement
 * below is therefore marked `tenant-scope-exempt` per that section, with the
 * specific reason spelled out per statement as `scripts/check-architecture.mjs`
 * requires.
 *
 * `auditInsertBatchQuery` is exported so every other repository in this
 * module can append an audit row INSIDE the same `batch()` as the mutation
 * it documents — never as a second, separate call. Per the module brief:
 * "An audit entry written separately can be lost while the action succeeds,
 * which is worse than no audit at all because it looks trustworthy."
 */
import type { AtomicBatchDatabaseProvider, BatchQuery, Row } from "@nexara/core/database";
import { isPlatformRole } from "@nexara/core/rbac";
import type { PlatformAuditEntry, PlatformAuditLogPort } from "../domain/audit";

const AUDIT_COLUMNS = `id, actor_user_id, platform_role, action, target_account_id,
  target_resource, reason, ip, user_agent, occurred_at, request_id`;

function auditParams(entry: PlatformAuditEntry): readonly unknown[] {
  return [
    entry.id,
    entry.actor,
    entry.platformRole,
    entry.action,
    entry.targetAccountId,
    entry.targetResource,
    entry.reason,
    entry.ip,
    entry.userAgent,
    entry.occurredAt,
    entry.requestId,
  ];
}

/**
 * Builds the `BatchQuery` for appending one audit row, for use inside a
 * mutation's own `batch()` call elsewhere in this module (grant, compliance
 * case, impersonation repositories). Kept here so every insert into
 * `platform_audit_log` — whether via `SqlPlatformAuditLogRepository.append`
 * or a sibling repository's batch — uses exactly the same column list and
 * parameter order.
 */
export function auditInsertBatchQuery(entry: PlatformAuditEntry): BatchQuery {
  return {
    sql: `-- tenant-scope-exempt: platform_audit_log is the cross-tenant audit
          -- trail itself (SUPER_ADMIN_CONSOLE.md §4/§5); target_account_id is
          -- the audited action's subject, not an isolation filter, and is
          -- nullable (many audited actions, e.g. a role grant, target no
          -- single account).
          insert into platform_audit_log (${AUDIT_COLUMNS})
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    params: auditParams(entry),
  };
}

function toAuditEntry(row: Row): PlatformAuditEntry {
  const platformRole = String(row.platform_role);
  return {
    id: String(row.id),
    actor: String(row.actor_user_id),
    platformRole: isPlatformRole(platformRole) ? platformRole : "platform_support",
    action: String(row.action),
    targetAccountId: row.target_account_id === null || row.target_account_id === undefined ? null : String(row.target_account_id),
    targetResource: row.target_resource === null || row.target_resource === undefined ? null : String(row.target_resource),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    ip: row.ip === null || row.ip === undefined ? null : String(row.ip),
    userAgent: row.user_agent === null || row.user_agent === undefined ? null : String(row.user_agent),
    occurredAt: String(row.occurred_at),
    requestId: String(row.request_id),
  };
}

export class SqlPlatformAuditLogRepository implements PlatformAuditLogPort {
  constructor(private readonly db: AtomicBatchDatabaseProvider) {}

  /** Append one entry. A single INSERT is trivially atomic on its own — no `batch()` needed here. */
  async append(entry: PlatformAuditEntry): Promise<void> {
    const q = auditInsertBatchQuery(entry);
    await this.db.query(q.sql, q.params);
  }

  /**
   * Not part of `PlatformAuditLogPort` (which is deliberately append/read-only
   * per its own read surface — see domain/audit.ts), but kept here as a small
   * read helper the other repositories' tests (and a future audit-log
   * viewer) can use without duplicating the row mapping.
   */
  async listForAccount(targetAccountId: string): Promise<readonly PlatformAuditEntry[]> {
    const { rows } = await this.db.query(
      // tenant-scope-exempt: platform-admin audit trail read, filtered to one
      // account's audited actions — SUPER_ADMIN_CONSOLE.md §4.
      `select ${AUDIT_COLUMNS} from platform_audit_log
        where target_account_id = $1
        order by occurred_at`,
      [targetAccountId],
    );
    return rows.map(toAuditEntry);
  }

  async listAll(): Promise<readonly PlatformAuditEntry[]> {
    const { rows } = await this.db.query(
      `-- tenant-scope-exempt: platform-admin audit trail, whole-fleet read by
       -- design — SUPER_ADMIN_CONSOLE.md §4.
       select ${AUDIT_COLUMNS} from platform_audit_log order by occurred_at`,
      [],
    );
    return rows.map(toAuditEntry);
  }
}
