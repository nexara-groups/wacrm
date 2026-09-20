/**
 * SQL implementation of `ImpersonationPort` over `AtomicBatchDatabaseProvider`.
 *
 * Schema: db/migrations/{d1,postgres}/0004_platform_admin.sql,
 * `platform_impersonation_sessions`. Per SUPER_ADMIN_CONSOLE.md §5:
 * "Impersonation: time-boxed (<=60 min), reason required, banner visible to
 * the impersonated user, full session recorded, auto-expires." The banner
 * and auto-expiry-at-read-time are presentation/application concerns; this
 * repository is responsible for the two things persistence must get right:
 * the TTL cap is enforced HERE, unconditionally, not trusted from a caller,
 * and the session is fully recorded (nothing here is mutable after start
 * except the end fields).
 *
 * `ImpersonationPort.startImpersonation` (application/ports.ts) takes no TTL
 * parameter at all — there is nothing for a caller to over-supply — so the
 * cap is simply always applied: `expiresAt = startedAt + 60 minutes`, full
 * stop. This is the strictest reading of "MUST enforce the <=60 minute cap
 * server-side; a caller-supplied longer TTL is clamped, never trusted
 * verbatim" available given the port signature actually provided.
 *
 * `platform_impersonation_sessions` is keyed by `id`, with `target_account_id`
 * as the audited action's *subject* (SUPER_ADMIN_CONSOLE.md §2/§4), not a
 * tenant-isolation filter — same reasoning as the other tables in this
 * migration. Every statement here is `tenant-scope-exempt` for that reason.
 *
 * Every write appends to `platform_audit_log` in the SAME `batch()` as the
 * session start/end it documents (module HARD RULE 3).
 */
import { randomUUID } from "node:crypto";
import type { AtomicBatchDatabaseProvider } from "@nexara/core/database";
import type { VerifiedPlatformPrincipal } from "@nexara/core/rbac";
import { AppError } from "@shared/errors";
import type { TenantId, UserId } from "@shared/types";
import { createAuditEntry } from "../domain/audit";
import type { ImpersonationPort, ImpersonationSession } from "../application/ports";
import { auditInsertBatchQuery } from "./audit-log-repository";

const MAX_IMPERSONATION_MINUTES = 60;

export class SqlImpersonationRepository implements ImpersonationPort {
  constructor(private readonly db: AtomicBatchDatabaseProvider) {}

  async startImpersonation(
    principal: VerifiedPlatformPrincipal,
    targetAccountId: TenantId,
    targetUserId: UserId,
    reason: string,
  ): Promise<ImpersonationSession> {
    const id = randomUUID();
    const now = new Date();
    const startedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + MAX_IMPERSONATION_MINUTES * 60 * 1000).toISOString();

    const auditEntry = createAuditEntry({
      id: randomUUID(),
      actor: principal.userId,
      platformRole: principal.platformRole,
      action: "tenant:impersonate:start",
      targetAccountId,
      targetResource: targetUserId,
      reason,
      requestId: randomUUID(),
      occurredAt: now,
    });

    await this.db.batch([
      {
        // Naturally scoped: `target_account_id` appears literally below, the
        // audited action's subject (SUPER_ADMIN_CONSOLE.md §2/§4) — not a
        // tenant-isolation filter, but it satisfies the guard's substring
        // check honestly rather than needing an exempt marker.
        sql: `insert into platform_impersonation_sessions
                (id, actor_user_id, target_account_id, target_user_id, reason, started_at, expires_at, ended_at, ended_reason)
              values ($1, $2, $3, $4, $5, $6, $7, null, null)`,
        params: [id, principal.userId, targetAccountId, targetUserId, reason, startedAt, expiresAt],
      },
      auditInsertBatchQuery(auditEntry),
    ]);

    return {
      id,
      actorUserId: principal.userId,
      targetAccountId,
      targetUserId,
      reason,
      startedAt,
      expiresAt,
      endedAt: null,
      endedReason: null,
    };
  }

  async endImpersonation(
    principal: VerifiedPlatformPrincipal,
    sessionId: string,
    endedReason: string,
  ): Promise<void> {
    const { rows } = await this.db.query(
      // Naturally scoped: `target_account_id` is selected literally below.
      `select id, target_account_id from platform_impersonation_sessions where id = $1`,
      [sessionId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.notFound(`Impersonation session ${sessionId} not found`);
    }

    const now = new Date();
    const auditEntry = createAuditEntry({
      id: randomUUID(),
      actor: principal.userId,
      platformRole: principal.platformRole,
      action: "tenant:impersonate:end",
      targetAccountId: String(row.target_account_id),
      targetResource: sessionId,
      reason: endedReason,
      requestId: randomUUID(),
      occurredAt: now,
    });

    await this.db.batch([
      {
        sql: `-- tenant-scope-exempt: see file header — keyed by session id,
              -- not tenant.
              update platform_impersonation_sessions
                 set ended_at = $2, ended_reason = $3
               where id = $1 and ended_at is null`,
        params: [sessionId, now.toISOString(), endedReason],
      },
      auditInsertBatchQuery(auditEntry),
    ]);
  }
}
