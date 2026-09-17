/**
 * SQL implementation of `ContactRepository` over `DatabaseProvider`.
 *
 * Every statement filters `account_id` — the architecture guard enforces
 * this, and since the Supabase exit moved 163 RLS policies out of the
 * database, this filter IS the tenant boundary. There is no second layer
 * behind it.
 *
 * Parameters are always bound, never interpolated. `search` builds a
 * variable-length WHERE clause, which is exactly where string concatenation
 * usually creeps in; the clause fragments here are fixed literals and only
 * the placeholder indices vary.
 *
 * Schema: db/migrations/{d1,postgres}/0005_contact_deliverability.sql (base
 * table + the consent/deliverability axes) and 0007_contacts.sql (profile
 * columns, tags, custom fields, import audit).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseProvider, Row } from "@nexara/core/database";
import type { TenantContext } from "@nexara/core/context";
import { canonicalTagKey } from "../domain/tags";
import type { Tag, TagFilter, TagId } from "../domain/tags";
import type {
  ContactCustomFieldValue,
  CustomFieldDefinition,
  CustomFieldType,
  CustomFieldValue,
} from "../domain/custom-fields";
import type {
  ConsentPatch,
  ContactImportRun,
  ContactProfilePatch,
  ContactRecord,
  ContactRepository,
  ContactSearchFilter,
  DeliverabilityPatch,
  NewContactImportRun,
  NewContactInput,
  Page,
  PageRequest,
} from "../application/ports";
import type { ContactId } from "../../../packages/domain/src/ids";
import type { PhoneNumber } from "../../../packages/domain/src/phone-number";

/** Columns of `contacts`, in one place so every read maps identically. */
const CONTACT_COLUMNS = `id, account_id, phone, display_name, email, company,
  consent_state, opted_out_at, opt_out_source, opt_out_evidence, opt_out_scope,
  deliverability_state, suppressed_at, suppressed_reason_code, suppression_strikes,
  created_at, updated_at`;

function text(value: unknown): string {
  return String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toContactRecord(row: Row): ContactRecord {
  return {
    id: text(row.id),
    accountId: text(row.account_id),
    phoneNumber: text(row.phone),
    displayName: nullableText(row.display_name),
    email: nullableText(row.email),
    company: nullableText(row.company),
    consentState: text(row.consent_state),
    optedOutAt: nullableText(row.opted_out_at),
    optOutSource: nullableText(row.opt_out_source),
    optOutEvidence: nullableText(row.opt_out_evidence),
    optOutScope: text(row.opt_out_scope),
    deliverabilityState: text(row.deliverability_state),
    suppressedAt: nullableText(row.suppressed_at),
    suppressedReasonCode: nullableText(row.suppressed_reason_code),
    suppressionStrikes: Number(row.suppression_strikes ?? 0),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  } as unknown as ContactRecord;
}

function toTag(row: Row): Tag {
  return {
    id: text(row.id),
    accountId: text(row.account_id),
    name: text(row.name),
    color: nullableText(row.color),
    createdAt: text(row.created_at),
  } as unknown as Tag;
}

function toCustomFieldDefinition(row: Row): CustomFieldDefinition {
  const raw = nullableText(row.options);
  return {
    id: text(row.id),
    accountId: text(row.account_id),
    key: text(row.key),
    label: text(row.label),
    type: text(row.type) as CustomFieldType,
    options: raw === null ? null : (JSON.parse(raw) as readonly string[]),
    createdAt: text(row.created_at),
  } as unknown as CustomFieldDefinition;
}

/** Custom values are stored as text; the definition's `type` says how to read it back. */
function encodeCustomValue(value: CustomFieldValue): string {
  return typeof value.value === "boolean" ? (value.value ? "true" : "false") : String(value.value);
}

export class SqlContactRepository implements ContactRepository {
  constructor(private readonly db: DatabaseProvider) {}

  private now(): string {
    return new Date().toISOString();
  }

  async create(tenant: TenantContext, input: NewContactInput): Promise<ContactRecord> {
    const id = randomUUID();
    const now = this.now();
    await this.db.query(
      `insert into contacts
         (id, account_id, phone, display_name, email, company,
          consent_state, opted_out_at, opt_out_source, opt_out_evidence, opt_out_scope,
          deliverability_state, suppression_strikes, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unknown', 0, $12, $13)`,
      [
        id,
        tenant.tenantId,
        input.phoneNumber,
        input.displayName,
        input.email,
        input.company,
        input.consentState ?? "unknown",
        input.optedOutAt ?? null,
        input.optOutSource ?? null,
        input.optOutEvidence ?? null,
        input.optOutScope ?? "all",
        now,
        now,
      ],
    );
    const created = await this.findById(tenant, id as ContactId);
    if (created === null) {
      throw new Error("contact insert succeeded but the row could not be read back");
    }
    return created;
  }

  async findById(tenant: TenantContext, contactId: ContactId): Promise<ContactRecord | null> {
    const { rows } = await this.db.query(
      `select ${CONTACT_COLUMNS} from contacts where account_id = $1 and id = $2`,
      [tenant.tenantId, contactId],
    );
    return rows[0] === undefined ? null : toContactRecord(rows[0]);
  }

  async findByPhone(tenant: TenantContext, phone: PhoneNumber): Promise<ContactRecord | null> {
    const { rows } = await this.db.query(
      `select ${CONTACT_COLUMNS} from contacts where account_id = $1 and phone = $2`,
      [tenant.tenantId, phone],
    );
    return rows[0] === undefined ? null : toContactRecord(rows[0]);
  }

  async listAll(tenant: TenantContext): Promise<readonly ContactRecord[]> {
    const { rows } = await this.db.query(
      `select ${CONTACT_COLUMNS} from contacts where account_id = $1 order by created_at`,
      [tenant.tenantId],
    );
    return rows.map(toContactRecord);
  }

  async updateProfile(
    tenant: TenantContext,
    contactId: ContactId,
    patch: ContactProfilePatch,
  ): Promise<ContactRecord | null> {
    // Only the keys actually present are written — an absent key means "leave
    // alone", which is different from an explicit null meaning "clear it".
    const sets: string[] = [];
    const params: unknown[] = [tenant.tenantId, contactId];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if ("displayName" in patch) push("display_name", patch.displayName ?? null);
    if ("email" in patch) push("email", patch.email ?? null);
    if ("company" in patch) push("company", patch.company ?? null);
    if (sets.length === 0) return this.findById(tenant, contactId);

    params.push(this.now());
    sets.push(`updated_at = $${params.length}`);

    await this.db.query(
      `update contacts set ${sets.join(", ")} where account_id = $1 and id = $2`,
      params,
    );
    return this.findById(tenant, contactId);
  }

  /**
   * Consent columns are written as one unit. Writing them piecemeal is how a
   * contact ends up `opted_out` with no evidence recorded — which is exactly
   * the row you need when a regulator or Meta asks why you stopped sending.
   */
  async applyConsentPatch(
    tenant: TenantContext,
    contactId: ContactId,
    patch: ConsentPatch,
  ): Promise<ContactRecord | null> {
    await this.db.query(
      `update contacts
          set consent_state = $3, opted_out_at = $4, opt_out_source = $5,
              opt_out_evidence = $6, opt_out_scope = $7, updated_at = $8
        where account_id = $1 and id = $2`,
      [
        tenant.tenantId,
        contactId,
        patch.state,
        patch.optedOutAt,
        patch.source,
        patch.evidence,
        patch.scope,
        this.now(),
      ],
    );
    return this.findById(tenant, contactId);
  }

  async applyDeliverabilityPatch(
    tenant: TenantContext,
    contactId: ContactId,
    patch: DeliverabilityPatch,
  ): Promise<ContactRecord | null> {
    await this.db.query(
      `update contacts
          set deliverability_state = $3, suppressed_at = $4,
              suppressed_reason_code = $5, suppression_strikes = $6, updated_at = $7
        where account_id = $1 and id = $2`,
      [
        tenant.tenantId,
        contactId,
        patch.state,
        patch.suppressedAt,
        patch.suppressedReasonCode,
        patch.suppressionStrikes,
        this.now(),
      ],
    );
    return this.findById(tenant, contactId);
  }

  async delete(tenant: TenantContext, contactId: ContactId): Promise<void> {
    await this.db.query(`delete from contacts where account_id = $1 and id = $2`, [
      tenant.tenantId,
      contactId,
    ]);
  }

  async search(
    tenant: TenantContext,
    filter: ContactSearchFilter,
    page: PageRequest,
  ): Promise<Page<ContactRecord>> {
    // Deliberately NOT seeded with the tenant predicate: that lives literally
    // in each statement below, so it cannot be refactored away and the
    // architecture guard can actually verify it.
    const where: string[] = [];
    const params: unknown[] = [tenant.tenantId];
    const push = (fragment: (placeholder: string) => string, value: unknown): void => {
      params.push(value);
      where.push(fragment(`$${params.length}`));
    };

    if (filter.query !== undefined && filter.query.trim().length > 0) {
      const like = `%${filter.query.trim().toLowerCase()}%`;
      params.push(like);
      const p = `$${params.length}`;
      where.push(
        `(lower(coalesce(display_name,'')) like ${p} or lower(coalesce(email,'')) like ${p}
          or lower(coalesce(company,'')) like ${p} or lower(phone) like ${p})`,
      );
    }
    if (filter.consentState !== undefined) push((p) => `consent_state = ${p}`, filter.consentState);
    if (filter.deliverabilityState !== undefined) {
      push((p) => `deliverability_state = ${p}`, filter.deliverabilityState);
    }

    const tagClause = this.tagFilterClause(filter.tagFilter, params);
    if (tagClause !== null) where.push(tagClause);

    const extraSql = where.length > 0 ? ` and ${where.join(" and ")}` : "";

    const counted = await this.db.query(
      `select count(*) as total from contacts where account_id = $1${extraSql}`,
      params,
    );
    const total = Number(counted.rows[0]?.total ?? 0);

    const pageSize = Math.max(1, page.pageSize);
    const offset = Math.max(0, (Math.max(1, page.page) - 1) * pageSize);
    params.push(pageSize, offset);
    const { rows } = await this.db.query(
      `select ${CONTACT_COLUMNS} from contacts where account_id = $1${extraSql}
        order by coalesce(display_name, phone)
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return { items: rows.map(toContactRecord), total };
  }

  /**
   * `any` -> at least one of the tags; `all` -> every one of them. Both are
   * expressed as a correlated subquery over `contact_tags` so the filter
   * composes with the other WHERE fragments instead of needing a join that
   * would duplicate contact rows.
   */
  private tagFilterClause(filter: TagFilter | undefined, params: unknown[]): string | null {
    if (filter === undefined || filter.tagIds.length === 0) return null;
    const placeholders = filter.tagIds.map((id) => {
      params.push(id);
      return `$${params.length}`;
    });
    const inList = placeholders.join(", ");
    if (filter.mode === "all") {
      params.push(filter.tagIds.length);
      return `(select count(distinct ct.tag_id) from contact_tags ct
                where ct.account_id = contacts.account_id and ct.contact_id = contacts.id
                  and ct.tag_id in (${inList})) = $${params.length}`;
    }
    return `exists (select 1 from contact_tags ct
                     where ct.account_id = contacts.account_id and ct.contact_id = contacts.id
                       and ct.tag_id in (${inList}))`;
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  async listTags(tenant: TenantContext): Promise<readonly Tag[]> {
    const { rows } = await this.db.query(
      `select id, account_id, name, color, created_at from tags
        where account_id = $1 order by name`,
      [tenant.tenantId],
    );
    return rows.map(toTag);
  }

  /**
   * Get-or-create keyed by `canonicalTagKey`, so "VIP", "vip" and " Vip "
   * resolve to one tag rather than three. Matching happens in memory against
   * the account's existing tags because the canonical form is a domain rule,
   * not a SQL one — keeping it here would mean duplicating it in every
   * dialect.
   */
  async findOrCreateTagsByName(
    tenant: TenantContext,
    names: readonly string[],
  ): Promise<readonly Tag[]> {
    const existing = await this.listTags(tenant);
    const byKey = new Map(existing.map((t) => [canonicalTagKey(t.name), t]));
    const out: Tag[] = [];
    for (const name of names) {
      const trimmed = name.trim();
      if (trimmed.length === 0) continue;
      const key = canonicalTagKey(trimmed);
      const found = byKey.get(key);
      if (found !== undefined) {
        out.push(found);
        continue;
      }
      const id = randomUUID();
      const now = this.now();
      await this.db.query(
        `insert into tags (id, account_id, name, color, created_at) values ($1, $2, $3, null, $4)`,
        [id, tenant.tenantId, trimmed, now],
      );
      const created = { id, accountId: tenant.tenantId, name: trimmed, color: null, createdAt: now } as unknown as Tag;
      byKey.set(key, created);
      out.push(created);
    }
    return out;
  }

  /** Replaces the contact's tag set — assignments not in `tagIds` are removed. */
  async assignTags(
    tenant: TenantContext,
    contactId: ContactId,
    tagIds: readonly TagId[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(`delete from contact_tags where account_id = $1 and contact_id = $2`, [
        tenant.tenantId,
        contactId,
      ]);
      const now = this.now();
      for (const tagId of tagIds) {
        await tx.query(
          `insert into contact_tags (account_id, contact_id, tag_id, created_at)
           values ($1, $2, $3, $4)`,
          [tenant.tenantId, contactId, tagId, now],
        );
      }
    });
  }

  async listTagIdsForContact(
    tenant: TenantContext,
    contactId: ContactId,
  ): Promise<readonly TagId[]> {
    const { rows } = await this.db.query(
      `select tag_id from contact_tags where account_id = $1 and contact_id = $2`,
      [tenant.tenantId, contactId],
    );
    return rows.map((r) => text(r.tag_id) as unknown as TagId);
  }

  // -------------------------------------------------------------------------
  // Custom fields
  // -------------------------------------------------------------------------

  async listCustomFieldDefinitions(
    tenant: TenantContext,
  ): Promise<readonly CustomFieldDefinition[]> {
    const { rows } = await this.db.query(
      `select id, account_id, key, label, type, options, created_at
         from custom_field_definitions where account_id = $1 order by label`,
      [tenant.tenantId],
    );
    return rows.map(toCustomFieldDefinition);
  }

  async findOrCreateCustomFieldDefinition(
    tenant: TenantContext,
    key: string,
    label: string,
    type: CustomFieldType,
  ): Promise<CustomFieldDefinition> {
    const found = await this.db.query(
      `select id, account_id, key, label, type, options, created_at
         from custom_field_definitions where account_id = $1 and key = $2`,
      [tenant.tenantId, key],
    );
    if (found.rows[0] !== undefined) return toCustomFieldDefinition(found.rows[0]);

    const id = randomUUID();
    const now = this.now();
    await this.db.query(
      `insert into custom_field_definitions (id, account_id, key, label, type, options, created_at)
       values ($1, $2, $3, $4, $5, null, $6)`,
      [id, tenant.tenantId, key, label, type, now],
    );
    return {
      id,
      accountId: tenant.tenantId,
      key,
      label,
      type,
      options: null,
      createdAt: now,
    } as unknown as CustomFieldDefinition;
  }

  async getCustomFieldValues(
    tenant: TenantContext,
    contactId: ContactId,
  ): Promise<readonly ContactCustomFieldValue[]> {
    const { rows } = await this.db.query(
      `select v.field_id, v.value, d.type
         from contact_custom_values v
         join custom_field_definitions d on d.id = v.field_id and d.account_id = v.account_id
        where v.account_id = $1 and v.contact_id = $2`,
      [tenant.tenantId, contactId],
    );
    return rows.map((r) => {
      const type = text(r.type) as CustomFieldType;
      const raw = nullableText(r.value) ?? "";
      const value =
        type === "number"
          ? { type, value: Number(raw) }
          : type === "boolean"
            ? { type, value: raw === "true" }
            : { type, value: raw };
      return {
        contactId,
        fieldId: text(r.field_id),
        value,
      } as unknown as ContactCustomFieldValue;
    });
  }

  async setCustomFieldValues(
    tenant: TenantContext,
    contactId: ContactId,
    values: readonly ContactCustomFieldValue[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = this.now();
      for (const v of values) {
        await tx.query(
          `delete from contact_custom_values
            where account_id = $1 and contact_id = $2 and field_id = $3`,
          [tenant.tenantId, contactId, v.fieldId],
        );
        await tx.query(
          `insert into contact_custom_values (account_id, contact_id, field_id, value, updated_at)
           values ($1, $2, $3, $4, $5)`,
          [tenant.tenantId, contactId, v.fieldId, encodeCustomValue(v.value), now],
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // Import audit
  // -------------------------------------------------------------------------

  /**
   * Records an import run and every rejected row WITH its reason. Rejections
   * are persisted rather than logged so an operator can answer "why did 12 of
   * my 3,000 rows not import" days later, per META_ERROR_TAXONOMY.md §4b.
   */
  async recordImportRun(
    tenant: TenantContext,
    run: NewContactImportRun,
  ): Promise<ContactImportRun> {
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into contact_imports
           (id, account_id, started_by_user_id, file_name, total_rows,
            created_count, updated_count, rejected_count, started_at, completed_at)
         values ($1, $2, $3, null, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          tenant.tenantId,
          run.actorUserId,
          run.totalRows,
          run.createdCount,
          run.updatedCount,
          run.rejectedRows.length,
          run.startedAt,
          run.finishedAt,
        ],
      );
      for (const rejection of run.rejectedRows) {
        await tx.query(
          `insert into contact_import_rejections
             (id, account_id, import_id, row_number, raw_phone, reason, created_at)
           values ($1, $2, $3, $4, null, $5, $6)`,
          [randomUUID(), tenant.tenantId, id, rejection.rowNumber, rejection.reason, run.finishedAt],
        );
      }
    });
    return { ...run, id, accountId: tenant.tenantId };
  }
}
