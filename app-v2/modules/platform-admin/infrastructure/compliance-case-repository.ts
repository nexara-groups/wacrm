/**
 * SQL implementation of `ComplianceCasePort` over `AtomicBatchDatabaseProvider`.
 *
 * Schema: db/migrations/{d1,postgres}/0004_platform_admin.sql —
 * `compliance_cases`, `compliance_case_reads`, `compliance_case_exports`.
 * See SUPER_ADMIN_CONSOLE.md §7 and ../domain/compliance-case.ts, which this
 * repository delegates every state transition to (`openComplianceCase`,
 * `approveComplianceCase`, `closeComplianceCase`, `canReadContent`). This
 * file never re-implements those rules; it only persists their result.
 *
 * -----------------------------------------------------------------------
 * `readContent` — THE invariant this module exists to protect
 * -----------------------------------------------------------------------
 * This is the only method in the whole platform-admin infrastructure layer
 * that touches a customer's `messages`/`message_templates` rows. It:
 *   1. loads the case (if it does not exist, audits the attempt and returns
 *      null — there is nothing to check content against);
 *   2. calls `canReadContent(case_, resourceRef, now)` — the SAME domain
 *      gate unit-tested in ../domain/compliance-case.test.ts — and only
 *      queries content at all when that returns true;
 *   3. UNCONDITIONALLY appends a `compliance_case_reads` row and a
 *      `platform_audit_log` row, in one `batch()`, whether or not access
 *      was granted (ports.ts: "MUST append a ComplianceCaseRead row for
 *      every call, successful or not"). A denied read is exactly as
 *      important to have on the record as a granted one.
 * There is no parameter, override, or code path anywhere in this file that
 * returns content without both of those checks/writes happening first.
 *
 * -----------------------------------------------------------------------
 * SCHEMA GAP — flagged, not invented (module brief rule 2)
 * -----------------------------------------------------------------------
 * `compliance_cases.expires_at` is `NOT NULL` in both migration dialects,
 * but the domain model (`ComplianceCase.expiresAt`, ../domain/compliance-case.ts)
 * is `string | null` and the invariant "a case with `approvedBy === null`
 * has `expiresAt === null` too" is asserted directly in
 * `domain/compliance-case.test.ts`. A real column change needs a migration,
 * which this task may not add. Workaround: `open` writes a fixed sentinel
 * (`UNAPPROVED_EXPIRES_AT_SENTINEL`, the Unix epoch — a value that can never
 * be a genuine future expiry) into the NOT NULL column, and `toComplianceCase`
 * (the one place every row becomes a domain object) always reports
 * `expiresAt: null` whenever `approved_by IS NULL`, regardless of what the
 * column holds. `canReadContent` and every test therefore see exactly the
 * domain-level null the invariant requires; only this file's row mapper
 * knows the sentinel exists. `approve` overwrites the sentinel with a real
 * expiry, so an approved case's `expires_at` column is always meaningful.
 *
 * `compliance_cases`/`compliance_case_reads`/`compliance_case_exports` carry
 * `account_id`/`case_id` as the audited action's *subject*, not a
 * tenant-isolation filter — a platform principal's whole point is reading
 * across accounts (SUPER_ADMIN_CONSOLE.md §2/§4). Every statement here is
 * `tenant-scope-exempt` for that reason, same as the module's other
 * repositories; where the case's own `account_id` is known, statements
 * still filter on it as defense in depth (never reading account B's message
 * under an account A case), not because the guard requires it.
 */
import { randomUUID } from "node:crypto";
import type { AtomicBatchDatabaseProvider, Row } from "@nexara/core/database";
import type { VerifiedPlatformPrincipal } from "@nexara/core/rbac";
import { AppError } from "@shared/errors";
import { createAuditEntry } from "../domain/audit";
import {
  approveComplianceCase,
  canReadContent,
  closeComplianceCase,
  openComplianceCase,
  type ComplianceCase,
  type ComplianceCaseCategory,
  type ComplianceResourceRef,
  type ComplianceScope,
} from "../domain/compliance-case";
import type {
  ComplianceCaseExport,
  ComplianceCasePort,
  OpenComplianceCaseRequest,
} from "../application/ports";
import { auditInsertBatchQuery } from "./audit-log-repository";

/** See file header "SCHEMA GAP" — never surfaced past `toComplianceCase`. */
const UNAPPROVED_EXPIRES_AT_SENTINEL = "1970-01-01T00:00:00.000Z";

const CASE_COLUMNS = `id, external_ref, category, account_id, scope_type, scope_value,
  opened_by, reason, approved_by, approved_at, expires_at, closed_at, closed_by,
  outcome, tenant_notified_at, disclosure_restricted`;

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function scopeFromRow(row: Row): ComplianceScope {
  const scopeType = String(row.scope_type);
  const scopeValue = JSON.parse(String(row.scope_value)) as Record<string, unknown>;
  switch (scopeType) {
    case "message_ids":
      return { scopeType, scopeValue: { messageIds: scopeValue.messageIds as readonly string[] } };
    case "contact":
      return { scopeType, scopeValue: { contactId: String(scopeValue.contactId) } };
    case "template":
      return { scopeType, scopeValue: { templateId: String(scopeValue.templateId) } };
    case "date_range":
      return {
        scopeType,
        scopeValue: { from: String(scopeValue.from), to: String(scopeValue.to) },
      };
    default:
      throw AppError.database(`compliance_cases row ${String(row.id)} has unknown scope_type "${scopeType}"`);
  }
}

function toComplianceCase(row: Row): ComplianceCase {
  const approvedBy = nullableText(row.approved_by);
  return {
    ...scopeFromRow(row),
    id: String(row.id),
    externalRef: String(row.external_ref),
    category: String(row.category) as ComplianceCaseCategory,
    accountId: String(row.account_id),
    openedBy: String(row.opened_by),
    reason: String(row.reason),
    approvedBy,
    approvedAt: nullableText(row.approved_at),
    // SCHEMA GAP workaround — see file header. `expires_at` is NOT NULL in
    // storage; an unapproved case's column value is the sentinel and MUST
    // never be reported as a real expiry.
    expiresAt: approvedBy === null ? null : nullableText(row.expires_at),
    closedAt: nullableText(row.closed_at),
    closedBy: nullableText(row.closed_by),
    outcome: nullableText(row.outcome),
    tenantNotifiedAt: nullableText(row.tenant_notified_at),
    disclosureRestricted: Number(row.disclosure_restricted ?? 0) !== 0,
  } as ComplianceCase;
}

function resourceIdFor(ref: ComplianceResourceRef): string {
  switch (ref.type) {
    case "message_ids":
      return ref.messageId;
    case "contact":
      return ref.contactId;
    case "template":
      return ref.templateId;
    case "date_range":
      return ref.occurredAt;
  }
}

function toEvidenceMessage(row: Row): unknown {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    contactId: String(row.contact_id),
    wamid: nullableText(row.wamid),
    direction: String(row.direction),
    type: String(row.type),
    body: nullableText(row.body),
    templateId: nullableText(row.template_id),
    mediaRef: nullableText(row.media_ref),
    status: String(row.status),
    errorCode: nullableText(row.error_code),
    sentAt: nullableText(row.sent_at),
    deliveredAt: nullableText(row.delivered_at),
    readAt: nullableText(row.read_at),
    createdAt: String(row.created_at),
  };
}

export class SqlComplianceCaseRepository implements ComplianceCasePort {
  constructor(private readonly db: AtomicBatchDatabaseProvider) {}

  private auditQuery(
    principal: VerifiedPlatformPrincipal,
    action: string,
    opts: { targetAccountId?: string | null; targetResource?: string | null; reason?: string | null } = {},
  ) {
    return auditInsertBatchQuery(
      createAuditEntry({
        id: randomUUID(),
        actor: principal.userId,
        platformRole: principal.platformRole,
        action,
        targetAccountId: opts.targetAccountId ?? null,
        targetResource: opts.targetResource ?? null,
        reason: opts.reason ?? null,
        requestId: randomUUID(),
      }),
    );
  }

  async open(
    principal: VerifiedPlatformPrincipal,
    request: OpenComplianceCaseRequest,
  ): Promise<ComplianceCase> {
    const case_ = openComplianceCase({
      id: request.id,
      externalRef: request.externalRef,
      category: request.category,
      accountId: request.accountId,
      scope: request.scope,
      openedBy: principal.userId,
      reason: request.reason,
      disclosureRestricted: request.disclosureRestricted,
    });

    await this.db.batch([
      {
        // tenant-scope-exempt: compliance_cases is opened BY a platform
        // principal ABOUT one tenant account (SUPER_ADMIN_CONSOLE.md §7);
        // account_id is the case's subject and is bound below as defense
        // in depth, not because a tenant filter applies to who may open it.
        sql: `insert into compliance_cases
                (id, external_ref, category, account_id, scope_type, scope_value,
                 opened_by, reason, approved_by, approved_at, expires_at,
                 closed_at, closed_by, outcome, tenant_notified_at, disclosure_restricted)
              values ($1, $2, $3, $4, $5, $6, $7, $8, null, null, $9, null, null, null, null, $10)`,
        params: [
          case_.id,
          case_.externalRef,
          case_.category,
          case_.accountId,
          case_.scopeType,
          JSON.stringify(case_.scopeValue),
          case_.openedBy,
          case_.reason,
          UNAPPROVED_EXPIRES_AT_SENTINEL,
          case_.disclosureRestricted ? 1 : 0,
        ],
      },
      this.auditQuery(principal, "compliance_case:open", {
        targetAccountId: case_.accountId,
        targetResource: case_.id,
        reason: case_.reason,
      }),
    ]);

    return case_;
  }

  async approve(
    principal: VerifiedPlatformPrincipal,
    caseId: string,
    ttlDays?: number,
  ): Promise<ComplianceCase> {
    const existing = await this.loadCase(caseId);
    if (existing === null) {
      throw AppError.notFound(`Compliance case ${caseId} not found`);
    }

    const result = approveComplianceCase(existing, principal.userId, { ttlDays });
    if (!result.ok) {
      throw result.error;
    }
    const approved = result.value;

    await this.db.batch([
      {
        // tenant-scope-exempt: see header — keyed by case id; account_id
        // bound as defense in depth.
        // `approved_by is null` is what makes the check-then-write atomic.
        // `approveComplianceCase` rejects a second approval, but it decides
        // that from a row read moments earlier: two approvers racing would
        // both read null, both pass the domain check, and both write —
        // with the later one's TTL winning. On a time-boxed grant to
        // customer message content, that turns "access expires in 7 days"
        // into "access expires whenever someone last re-approved", which is
        // the one property the TTL exists to guarantee.
        sql: `update compliance_cases
                 set approved_by = $2, approved_at = $3, expires_at = $4
               where id = $1 and account_id = $5 and approved_by is null and closed_at is null`,
        params: [caseId, approved.approvedBy, approved.approvedAt, approved.expiresAt, approved.accountId],
      },
      this.auditQuery(principal, "compliance_case:approve", {
        targetAccountId: approved.accountId,
        targetResource: caseId,
      }),
    ]);

    return approved;
  }

  async close(
    principal: VerifiedPlatformPrincipal,
    caseId: string,
    outcome: string,
  ): Promise<ComplianceCase> {
    const existing = await this.loadCase(caseId);
    if (existing === null) {
      throw AppError.notFound(`Compliance case ${caseId} not found`);
    }

    const closed = closeComplianceCase(existing, principal.userId, outcome);

    await this.db.batch([
      {
        // tenant-scope-exempt: see header — keyed by case id; account_id
        // bound as defense in depth.
        sql: `update compliance_cases
                 set closed_at = $2, closed_by = $3, outcome = $4
               where id = $1 and account_id = $5`,
        params: [caseId, closed.closedAt, closed.closedBy, closed.outcome, closed.accountId],
      },
      this.auditQuery(principal, "compliance_case:close", {
        targetAccountId: closed.accountId,
        targetResource: caseId,
        reason: outcome,
      }),
    ]);

    return closed;
  }

  async findById(principal: VerifiedPlatformPrincipal, caseId: string): Promise<ComplianceCase | null> {
    const case_ = await this.loadCase(caseId);

    const q = this.auditQuery(principal, "compliance_case:find_by_id", {
      targetAccountId: case_?.accountId ?? null,
      targetResource: caseId,
    });
    await this.db.query(q.sql, q.params);

    return case_;
  }

  async findActiveForAccount(
    principal: VerifiedPlatformPrincipal,
    accountId: string,
  ): Promise<readonly ComplianceCase[]> {
    const { rows } = await this.db.query(
      // tenant-scope-exempt: cross-tenant-by-role platform query, scoped to
      // one account by explicit argument (SUPER_ADMIN_CONSOLE.md §4).
      // "Active" = not yet closed — expiry is enforced at readContent time,
      // never by excluding a row from this list (§7: "no cleanup job").
      `select ${CASE_COLUMNS} from compliance_cases
        where account_id = $1 and closed_at is null
        order by approved_at is null desc, approved_at, id`,
      [accountId],
    );

    const q = this.auditQuery(principal, "compliance_case:find_active_for_account", {
      targetAccountId: accountId,
    });
    await this.db.query(q.sql, q.params);

    return rows.map(toComplianceCase);
  }

  /**
   * See file header. This is the ONLY method in this repository (and the
   * only content-reading method in the whole port set, per ports.ts) that
   * returns message content.
   */
  async readContent(
    principal: VerifiedPlatformPrincipal,
    caseId: string,
    resourceRef: ComplianceResourceRef,
    now: Date,
  ): Promise<unknown | null> {
    const case_ = await this.loadCase(caseId);

    if (case_ === null) {
      // No case to check scope against and no case row to satisfy the reads
      // table's FK — still an auditable attempted access.
      const q = this.auditQuery(principal, "compliance_case:read_content:case_not_found", {
        targetResource: caseId,
      });
      await this.db.query(q.sql, q.params);
      return null;
    }

    const allowed = canReadContent(case_, resourceRef, now);
    const content = allowed ? await this.fetchContent(case_, resourceRef) : null;

    // MUST append a ComplianceCaseRead row for every call, successful or
    // not (ports.ts) — same batch as the audit-log entry, so neither can be
    // recorded without the other.
    await this.db.batch([
      {
        sql: `-- tenant-scope-exempt: append-only case-read trail, keyed by
              -- case id (SUPER_ADMIN_CONSOLE.md §7).
              insert into compliance_case_reads (id, case_id, actor_user_id, resource_type, resource_id, read_at)
              values ($1, $2, $3, $4, $5, $6)`,
        params: [randomUUID(), caseId, principal.userId, resourceRef.type, resourceIdFor(resourceRef), now.toISOString()],
      },
      this.auditQuery(principal, allowed ? "compliance_case:read_content:granted" : "compliance_case:read_content:denied", {
        targetAccountId: case_.accountId,
        targetResource: `${caseId}:${resourceRef.type}:${resourceIdFor(resourceRef)}`,
      }),
    ]);

    return content;
  }

  async recordExport(principal: VerifiedPlatformPrincipal, exportRecord: ComplianceCaseExport): Promise<void> {
    const now = new Date().toISOString();
    await this.db.batch([
      {
        sql: `-- tenant-scope-exempt: append-only export trail, keyed by case
              -- id (SUPER_ADMIN_CONSOLE.md §7).
              insert into compliance_case_exports (id, case_id, actor_user_id, format, watermark, exported_at, row_count)
              values ($1, $2, $3, $4, $5, $6, $7)`,
        params: [
          randomUUID(),
          exportRecord.caseId,
          exportRecord.actorUserId,
          exportRecord.format,
          exportRecord.watermark,
          now,
          exportRecord.rowCount,
        ],
      },
      this.auditQuery(principal, "compliance_case:record_export", {
        targetResource: exportRecord.caseId,
        reason: exportRecord.watermark,
      }),
    ]);
  }

  // ---------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------

  private async loadCase(caseId: string): Promise<ComplianceCase | null> {
    const { rows } = await this.db.query(
      `-- tenant-scope-exempt: keyed by case id — see file header.
       select ${CASE_COLUMNS} from compliance_cases where id = $1`,
      [caseId],
    );
    return rows[0] === undefined ? null : toComplianceCase(rows[0]);
  }

  /**
   * Fetches the evidence matching the case's OWN declared scope — never a
   * broader query than what `canReadContent` just confirmed `resourceRef`
   * falls inside. Every statement filters on `case_.accountId`, so a case
   * about account A can never surface a row belonging to account B even if
   * a resource id collided.
   */
  private async fetchContent(case_: ComplianceCase, ref: ComplianceResourceRef): Promise<unknown | null> {
    switch (ref.type) {
      case "message_ids": {
        const { rows } = await this.db.query(
          `select id, account_id, conversation_id, contact_id, wamid, direction, type, body,
                  template_id, media_ref, status, error_code, sent_at, delivered_at, read_at, created_at
             from messages where account_id = $1 and id = $2`,
          [case_.accountId, ref.messageId],
        );
        return rows[0] === undefined ? null : toEvidenceMessage(rows[0]);
      }
      case "contact": {
        const { rows } = await this.db.query(
          `select id, account_id, conversation_id, contact_id, wamid, direction, type, body,
                  template_id, media_ref, status, error_code, sent_at, delivered_at, read_at, created_at
             from messages where account_id = $1 and contact_id = $2
             order by created_at`,
          [case_.accountId, ref.contactId],
        );
        return rows.map(toEvidenceMessage);
      }
      case "template": {
        const { rows } = await this.db.query(
          `select id, account_id, meta_template_id, name, language, category, status, body_text,
                  variable_count, components, created_at, updated_at
             from message_templates where account_id = $1 and id = $2`,
          [case_.accountId, ref.templateId],
        );
        const row = rows[0];
        return row === undefined
          ? null
          : {
              id: String(row.id),
              name: String(row.name),
              language: String(row.language),
              category: String(row.category),
              status: String(row.status),
              bodyText: String(row.body_text),
            };
      }
      case "date_range": {
        if (case_.scopeType !== "date_range") return null;
        const { rows } = await this.db.query(
          `select id, account_id, conversation_id, contact_id, wamid, direction, type, body,
                  template_id, media_ref, status, error_code, sent_at, delivered_at, read_at, created_at
             from messages where account_id = $1 and created_at >= $2 and created_at <= $3
             order by created_at`,
          [case_.accountId, case_.scopeValue.from, case_.scopeValue.to],
        );
        return rows.map(toEvidenceMessage);
      }
    }
  }
}
