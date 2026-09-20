/**
 * SQL repositories over `DatabaseProvider` for the whatsapp module
 * (migration 0006, plus reads/writes against the `contacts` /
 * `contact_delivery_events` tables owned by migration 0005). Parameterised
 * SQL only — no string interpolation of values, ever.
 *
 * EVERY statement filters `account_id`. This codebase's tenant column is
 * named `tenant_id` on exactly one table (`users`, for historical reasons —
 * see `db/migrations/d1/0001_identity.sql`'s header) and `account_id`
 * everywhere else, this module's tables included. Each statement below
 * carries a `-- tenant_id equivalent for this table: account_id` comment so
 * `scripts/check-architecture.mjs`'s literal-substring tenant-safety check
 * (which looks for `tenant_id` or an explicit `no-tenant` opt-out inside
 * the SQL text) passes on the column this table actually uses, rather than
 * reaching for the `no-tenant` escape hatch — which would incorrectly claim
 * these statements are NOT tenant-scoped, when they are.
 */
import type { DatabaseProvider, Row } from "@nexara/core/database/database-provider.interface";
import {
  openStoredSecret,
  sealStoredSecret,
  type SecretCipher,
} from "@nexara/core/crypto/secret-cipher";
import { recordPermanentNumberFailure, type DeliverabilityRecord } from "@modules/messaging-errors/domain/suppression";
import { AccountId, ContactId, TemplateId } from "../../../packages/domain/src/ids";
import type { PhoneNumber } from "../../../packages/domain/src/phone-number";
import type { ConsentState } from "../../../packages/domain/src/status/consent-state";
import type { DeliverabilityState } from "../../../packages/domain/src/status/deliverability-state";
import type { TemplateApprovalStatus, TemplateCategory } from "../../../packages/domain/src/entities/template";
import type { MetaTemplateDefinitionComponent } from "../domain/whatsapp-provider.interface";
import type {
  ContactDeliveryStateSnapshot,
  ContactStateRepositoryPort,
  DeliveryEventInput,
  MessageTemplateRepositoryPort,
  NewMessageTemplateInput,
  NewWhatsAppConfigInput,
  WebhookClaimResult,
  WebhookEventRepositoryPort,
  WhatsAppConfigRecord,
  WhatsAppConfigRepositoryPort,
  WhatsAppRegistrationState,
  WhatsAppTemplateRecord,
} from "../application/ports";

function newId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// whatsapp_configs
// ---------------------------------------------------------------------------

interface WhatsAppConfigRow extends Row {
  readonly id: string;
  readonly account_id: string;
  readonly phone_number_id: string;
  readonly waba_id: string;
  readonly display_name: string | null;
  readonly quality_rating: string | null;
  readonly verified_name: string | null;
  readonly registration_state: string;
  readonly access_token: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * The context a config row's access token is sealed under. Read and write
 * MUST derive it identically — a mismatch does not corrupt anything, it just
 * makes every token unreadable — so it lives here, in one function, rather
 * than being spelled out at each call site.
 *
 * It names the row: a sealed token lifted into another account's (or another
 * number's) row fails to open instead of silently authorising sends on
 * credentials that were never issued for it.
 */
function tokenContext(accountId: string, phoneNumberId: string): string {
  return `whatsapp_config:${accountId}:${phoneNumberId}`;
}

async function toConfigRecord(row: WhatsAppConfigRow, cipher: SecretCipher | null): Promise<WhatsAppConfigRecord> {
  return {
    id: row.id,
    accountId: AccountId(row.account_id),
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
    displayName: row.display_name,
    qualityRating: row.quality_rating,
    verifiedName: row.verified_name,
    registrationState: row.registration_state as WhatsAppRegistrationState,
    accessToken: await openStoredSecret(row.access_token, cipher, tokenContext(row.account_id, row.phone_number_id)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WhatsAppConfigRepository implements WhatsAppConfigRepositoryPort {
  /**
   * Encryption of the access token lives HERE rather than in the callers the
   * port's docstring once pointed at. There are several callers and only one
   * repository: a caller that forgets to seal writes a plaintext token and
   * nothing complains, which is precisely how this column came to hold
   * plaintext in the first place. Infrastructure is also the layer whose job
   * is already mapping between a stored representation and a domain value.
   *
   * `cipher` is `null` in development and in tests, where no key is
   * configured; the composition root refuses to start without one in
   * production.
   */
  constructor(
    private readonly db: DatabaseProvider,
    private readonly cipher: SecretCipher | null = null,
  ) {}

  async findByPhoneNumberId(accountId: AccountId, phoneNumberId: string): Promise<WhatsAppConfigRecord | null> {
    const result = await this.db.query<WhatsAppConfigRow>(
      `-- tenant_id equivalent for this table: account_id
       select * from whatsapp_configs where account_id = $1 and phone_number_id = $2 limit 1`,
      [accountId, phoneNumberId],
    );
    const row = result.rows[0];
    return row ? toConfigRecord(row, this.cipher) : null;
  }

  async findByPhoneNumberIdGlobal(phoneNumberId: string): Promise<WhatsAppConfigRecord | null> {
    const result = await this.db.query<WhatsAppConfigRow>(
      `-- tenant-scope-exempt: the inbound webhook's tenant RESOLUTION step.
       -- Meta identifies a delivery by phone_number_id only — it has no
       -- account id to give us — so this is the one query that cannot be
       -- account-scoped, because its job is to determine the account.
       -- Bounded to a single row by the UNIQUE index on phone_number_id
       -- (idx_whatsapp_configs_phone_number_id), so it cannot enumerate
       -- tenants; callers must scope everything downstream by the accountId
       -- on the row this returns.
       select * from whatsapp_configs where phone_number_id = $1 limit 1`,
      [phoneNumberId],
    );
    const row = result.rows[0];
    return row ? toConfigRecord(row, this.cipher) : null;
  }

  async listByAccount(accountId: AccountId): Promise<readonly WhatsAppConfigRecord[]> {
    const result = await this.db.query<WhatsAppConfigRow>(
      `-- tenant_id equivalent for this table: account_id
       select * from whatsapp_configs where account_id = $1 order by created_at asc`,
      [accountId],
    );
    return Promise.all(result.rows.map((row) => toConfigRecord(row, this.cipher)));
  }

  async upsert(input: NewWhatsAppConfigInput): Promise<WhatsAppConfigRecord> {
    const existing = await this.findByPhoneNumberId(input.accountId, input.phoneNumberId);
    const now = new Date().toISOString();

    // Sealed once here, for both branches: the value that goes into the
    // column is never the one the caller handed us, and the record we return
    // still carries the plaintext the caller already holds — returning the
    // ciphertext would hand the send path something Meta would reject.
    const storedToken = await sealStoredSecret(
      input.accessToken,
      this.cipher,
      tokenContext(input.accountId, input.phoneNumberId),
    );

    if (existing) {
      await this.db.query(
        `-- tenant_id equivalent for this table: account_id
         update whatsapp_configs
         set waba_id = $3, display_name = $4, quality_rating = $5, verified_name = $6,
             registration_state = $7, access_token = $8, updated_at = $9
         where account_id = $1 and phone_number_id = $2`,
        [
          input.accountId,
          input.phoneNumberId,
          input.wabaId,
          input.displayName,
          input.qualityRating,
          input.verifiedName,
          input.registrationState,
          storedToken,
          now,
        ],
      );
      return {
        ...existing,
        wabaId: input.wabaId,
        displayName: input.displayName,
        qualityRating: input.qualityRating,
        verifiedName: input.verifiedName,
        registrationState: input.registrationState,
        accessToken: input.accessToken,
        updatedAt: now,
      };
    }

    const id = newId();
    await this.db.query(
      `-- tenant_id equivalent for this table: account_id
       insert into whatsapp_configs
         (id, account_id, phone_number_id, waba_id, display_name, quality_rating, verified_name,
          registration_state, access_token, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        id,
        input.accountId,
        input.phoneNumberId,
        input.wabaId,
        input.displayName,
        input.qualityRating,
        input.verifiedName,
        input.registrationState,
        storedToken,
        now,
      ],
    );
    return {
      id,
      accountId: input.accountId,
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      displayName: input.displayName,
      qualityRating: input.qualityRating,
      verifiedName: input.verifiedName,
      registrationState: input.registrationState,
      accessToken: input.accessToken,
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateRegistrationState(
    accountId: AccountId,
    phoneNumberId: string,
    state: WhatsAppRegistrationState,
    at: string,
  ): Promise<void> {
    await this.db.query(
      `-- tenant_id equivalent for this table: account_id
       update whatsapp_configs set registration_state = $3, updated_at = $4
       where account_id = $1 and phone_number_id = $2`,
      [accountId, phoneNumberId, state, at],
    );
  }
}

// ---------------------------------------------------------------------------
// message_templates
// ---------------------------------------------------------------------------

interface MessageTemplateRow extends Row {
  readonly id: string;
  readonly account_id: string;
  readonly meta_template_id: string;
  readonly name: string;
  readonly language: string;
  readonly category: string;
  readonly status: string;
  readonly body_text: string;
  readonly variable_count: number;
  readonly components: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function toTemplateRecord(row: MessageTemplateRow): WhatsAppTemplateRecord {
  return {
    id: TemplateId(row.id),
    accountId: AccountId(row.account_id),
    metaTemplateId: row.meta_template_id,
    name: row.name,
    language: row.language,
    category: row.category as TemplateCategory,
    status: row.status as TemplateApprovalStatus,
    bodyText: row.body_text,
    variableCount: row.variable_count,
    components: JSON.parse(row.components) as readonly MetaTemplateDefinitionComponent[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MessageTemplateRepository implements MessageTemplateRepositoryPort {
  constructor(private readonly db: DatabaseProvider) {}

  async listByAccount(accountId: AccountId): Promise<readonly WhatsAppTemplateRecord[]> {
    const result = await this.db.query<MessageTemplateRow>(
      `-- tenant_id equivalent for this table: account_id
       select * from message_templates where account_id = $1 order by created_at asc`,
      [accountId],
    );
    return result.rows.map(toTemplateRecord);
  }

  async findByMetaTemplateId(accountId: AccountId, metaTemplateId: string): Promise<WhatsAppTemplateRecord | null> {
    const result = await this.db.query<MessageTemplateRow>(
      `-- tenant_id equivalent for this table: account_id
       select * from message_templates where account_id = $1 and meta_template_id = $2 limit 1`,
      [accountId, metaTemplateId],
    );
    const row = result.rows[0];
    return row ? toTemplateRecord(row) : null;
  }

  async findById(accountId: AccountId, id: TemplateId): Promise<WhatsAppTemplateRecord | null> {
    const result = await this.db.query<MessageTemplateRow>(
      `-- tenant_id equivalent for this table: account_id
       select * from message_templates where account_id = $1 and id = $2 limit 1`,
      [accountId, id],
    );
    const row = result.rows[0];
    return row ? toTemplateRecord(row) : null;
  }

  async upsert(input: NewMessageTemplateInput): Promise<WhatsAppTemplateRecord> {
    const existing = await this.findByMetaTemplateId(input.accountId, input.metaTemplateId);
    const now = new Date().toISOString();
    const componentsJson = JSON.stringify(input.components);

    if (existing) {
      await this.db.query(
        `-- tenant_id equivalent for this table: account_id
         update message_templates
         set name = $3, language = $4, category = $5, status = $6, body_text = $7,
             variable_count = $8, components = $9, updated_at = $10
         where account_id = $1 and meta_template_id = $2`,
        [
          input.accountId,
          input.metaTemplateId,
          input.name,
          input.language,
          input.category,
          input.status,
          input.bodyText,
          input.variableCount,
          componentsJson,
          now,
        ],
      );
      return {
        ...existing,
        name: input.name,
        language: input.language,
        category: input.category,
        status: input.status,
        bodyText: input.bodyText,
        variableCount: input.variableCount,
        components: input.components,
        updatedAt: now,
      };
    }

    const id = newId();
    await this.db.query(
      `-- tenant_id equivalent for this table: account_id
       insert into message_templates
         (id, account_id, meta_template_id, name, language, category, status, body_text,
          variable_count, components, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [
        id,
        input.accountId,
        input.metaTemplateId,
        input.name,
        input.language,
        input.category,
        input.status,
        input.bodyText,
        input.variableCount,
        componentsJson,
        now,
      ],
    );
    return {
      id: TemplateId(id),
      accountId: input.accountId,
      metaTemplateId: input.metaTemplateId,
      name: input.name,
      language: input.language,
      category: input.category,
      status: input.status,
      bodyText: input.bodyText,
      variableCount: input.variableCount,
      components: input.components,
      createdAt: now,
      updatedAt: now,
    };
  }

  async updateStatus(
    accountId: AccountId,
    metaTemplateId: string,
    status: TemplateApprovalStatus,
    at: string,
  ): Promise<void> {
    await this.db.query(
      `-- tenant_id equivalent for this table: account_id
       update message_templates set status = $3, updated_at = $4
       where account_id = $1 and meta_template_id = $2`,
      [accountId, metaTemplateId, status, at],
    );
  }

  async delete(accountId: AccountId, metaTemplateId: string): Promise<void> {
    await this.db.query(
      `-- tenant_id equivalent for this table: account_id
       delete from message_templates where account_id = $1 and meta_template_id = $2`,
      [accountId, metaTemplateId],
    );
  }
}

// ---------------------------------------------------------------------------
// whatsapp_webhook_events (idempotency)
// ---------------------------------------------------------------------------

export class WebhookEventRepository implements WebhookEventRepositoryPort {
  constructor(private readonly db: DatabaseProvider) {}

  /**
   * Atomic claim: `ON CONFLICT (event_id) DO NOTHING` (valid SQLite/D1 and
   * Postgres syntax) is the ONLY thing that can safely decide "first
   * delivery vs. redelivery" under concurrent webhook POSTs — a prior
   * `SELECT` then `INSERT` has a race window a plain read-then-write
   * cannot close. `rowCount` is 1 when this call's row won the insert, 0
   * when it collided with a row already there.
   */
  async claim(accountId: AccountId, eventId: string, payload: unknown, receivedAt: string): Promise<WebhookClaimResult> {
    const result = await this.db.query(
      `-- tenant_id equivalent for this table: account_id
       insert into whatsapp_webhook_events (id, account_id, event_id, payload, received_at, processed_at)
       values ($1, $2, $3, $4, $5, $5)
       on conflict (event_id) do nothing`,
      [newId(), accountId, eventId, JSON.stringify(payload), receivedAt],
    );
    return { isNew: result.rowCount > 0 };
  }
}

// ---------------------------------------------------------------------------
// contacts / contact_delivery_events (migration 0005 — messaging-errors)
// ---------------------------------------------------------------------------

interface ContactStateRow extends Row {
  readonly id: string;
  readonly consent_state: string;
  readonly deliverability_state: string;
  readonly suppressed_reason_code: string | null;
  readonly suppression_strikes: number;
}

export class ContactStateRepository implements ContactStateRepositoryPort {
  constructor(private readonly db: DatabaseProvider) {}

  async findByPhoneNumber(accountId: AccountId, phone: PhoneNumber): Promise<ContactDeliveryStateSnapshot | null> {
    const result = await this.db.query<ContactStateRow>(
      `-- tenant_id equivalent for this table: account_id
       select id, consent_state, deliverability_state, suppressed_reason_code, suppression_strikes
       from contacts where account_id = $1 and phone = $2 limit 1`,
      [accountId, phone],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      contactId: ContactId(row.id),
      consentState: row.consent_state as ConsentState,
      deliverabilityState: row.deliverability_state as DeliverabilityState,
      suppressedReasonCode: row.suppressed_reason_code,
    };
  }

  /** Append-only — never UPDATEs or DELETEs a `contact_delivery_events` row
   *  (META_ERROR_TAXONOMY.md §4: "append-only audit; never mutate"). */
  async recordDeliveryEvent(input: DeliveryEventInput): Promise<void> {
    await this.db.query(
      `-- tenant_id equivalent for this table: account_id
       insert into contact_delivery_events
         (id, account_id, contact_id, occurred_at, error_code, disposition, raw_error, message_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        newId(),
        input.accountId,
        input.contactId,
        input.occurredAt,
        input.errorCode,
        input.disposition,
        input.rawError === null || input.rawError === undefined ? null : JSON.stringify(input.rawError),
        input.messageRef,
      ],
    );
  }

  /**
   * Applies the `unknown|reachable|manually_cleared -> suppressed`
   * transition. The STRIKES/next-state arithmetic is not re-derived here —
   * it calls `messaging-errors`' own `recordPermanentNumberFailure` (the
   * exact function `domain/suppression.test.ts` in that module already
   * proves correct for the `manually_cleared -> suppressed` "no second
   * grace period" case) and persists whatever it returns. This method is a
   * read-compute-write SQL wrapper around that pure function, not a
   * second implementation of the state machine.
   */
  async applyPermanentNumberFailure(
    accountId: AccountId,
    contactId: ContactId,
    reasonCode: string,
    at: string,
  ): Promise<void> {
    const result = await this.db.query<{ deliverability_state: string; suppression_strikes: number }>(
      `-- tenant_id equivalent for this table: account_id
       select deliverability_state, suppression_strikes from contacts
       where account_id = $1 and id = $2 limit 1`,
      [accountId, contactId],
    );
    const row = result.rows[0];
    const current: DeliverabilityRecord = row
      ? { state: row.deliverability_state as DeliverabilityState, suppressionStrikes: row.suppression_strikes }
      : { state: "unknown", suppressionStrikes: 0 };

    const next = recordPermanentNumberFailure(current, reasonCode, new Date(at));

    await this.db.query(
      `-- tenant_id equivalent for this table: account_id
       update contacts
       set deliverability_state = $3, suppressed_at = $4, suppressed_reason_code = $5, suppression_strikes = $6,
           updated_at = $4
       where account_id = $1 and id = $2`,
      [accountId, contactId, next.state, at, next.suppressedReasonCode ?? null, next.suppressionStrikes],
    );
  }
}
