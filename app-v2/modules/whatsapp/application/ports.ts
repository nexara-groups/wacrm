/**
 * WhatsApp module — application-layer repository PORTS.
 *
 * Interfaces only: no SQL, no vendor imports, no `core/database` import.
 * `infrastructure/whatsapp-repository.ts` implements every one of these
 * against `DatabaseProvider`. Table mapping (migration 0006):
 *
 *   whatsapp_configs         -> WhatsAppConfigRepositoryPort
 *   message_templates        -> MessageTemplateRepositoryPort
 *   whatsapp_webhook_events  -> WebhookEventRepositoryPort
 *
 * `ContactStateRepositoryPort` reads/writes the `contacts` and
 * `contact_delivery_events` tables owned by migration 0005
 * (`messaging-errors` track, per META_ERROR_TAXONOMY.md §4/§5) — this
 * module is exactly the consumer that diagram describes
 * (WhatsAppProvider -> MetaErrorClassifier -> ContactDeliverabilityService),
 * so it depends on those tables' shape without owning or re-migrating them.
 */
import type { AccountId, ContactId, TemplateId } from "../../../packages/domain/src/ids";
import type { PhoneNumber } from "../../../packages/domain/src/phone-number";
import type { ConsentState } from "../../../packages/domain/src/status/consent-state";
import type { DeliverabilityState } from "../../../packages/domain/src/status/deliverability-state";
import type { Disposition } from "../../../packages/domain/src/status/disposition";
import type { Template, TemplateApprovalStatus } from "../../../packages/domain/src/entities/template";
import type { ISODateString } from "../../../packages/domain/src/entities/common";
import type { MappedTemplateFields } from "../domain/template-mapper";
import type { MetaTemplateDefinitionComponent } from "../domain/whatsapp-provider.interface";

// ---------------------------------------------------------------------------
// whatsapp_configs
// ---------------------------------------------------------------------------

export type WhatsAppRegistrationState = "unregistered" | "pending" | "registered" | "failed";

export interface WhatsAppConfigRecord {
  readonly id: string;
  readonly accountId: AccountId;
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly displayName: string | null;
  readonly qualityRating: string | null;
  readonly verifiedName: string | null;
  readonly registrationState: WhatsAppRegistrationState;
  /** ALWAYS the plaintext token on this record, in both directions: callers
   *  hand `upsert` the real token and get the real token back on a read.
   *  Encryption at rest happens inside `WhatsAppConfigRepository`, which
   *  seals on write and opens on read — see its constructor for why it lives
   *  there rather than in the callers this comment used to point at. */
  readonly accessToken: string;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

export interface NewWhatsAppConfigInput {
  readonly accountId: AccountId;
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly displayName: string | null;
  readonly qualityRating: string | null;
  readonly verifiedName: string | null;
  readonly registrationState: WhatsAppRegistrationState;
  readonly accessToken: string;
}

export interface WhatsAppConfigRepositoryPort {
  findByPhoneNumberId(accountId: AccountId, phoneNumberId: string): Promise<WhatsAppConfigRecord | null>;

  /**
   * Resolve a config by `phone_number_id` ALONE, across every account.
   *
   * This exists for one caller: the inbound webhook. Meta's delivery
   * identifies the destination by `phone_number_id` and nothing else — it
   * carries no account id, because Meta has no concept of our tenants. So
   * "which tenant is this message for?" is the FIRST question the webhook
   * must answer, and every other method here presupposes the answer.
   *
   * Safe to look up globally because `phone_number_id` is globally unique in
   * the schema — `idx_whatsapp_configs_phone_number_id` is a UNIQUE index on
   * that column by itself (0006_whatsapp.sql), so this can return at most
   * one row and cannot be used to enumerate or cross tenants.
   *
   * Everything downstream of this call is tenant-scoped using the accountId
   * on the row RETURNED here, never one supplied by the caller. That is the
   * whole point: the tenant is derived from trusted data, not asserted.
   */
  findByPhoneNumberIdGlobal(phoneNumberId: string): Promise<WhatsAppConfigRecord | null>;
  listByAccount(accountId: AccountId): Promise<readonly WhatsAppConfigRecord[]>;
  /** Insert-or-update keyed on `(account_id, phone_number_id)` — the
   *  migration's UNIQUE constraint on `phone_number_id`. */
  upsert(input: NewWhatsAppConfigInput): Promise<WhatsAppConfigRecord>;
  updateRegistrationState(
    accountId: AccountId,
    phoneNumberId: string,
    state: WhatsAppRegistrationState,
    at: ISODateString,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// message_templates
// ---------------------------------------------------------------------------

export interface NewMessageTemplateInput extends MappedTemplateFields {
  readonly accountId: AccountId;
}

/**
 * `packages/domain`'s `Template` entity is deliberately vendor-neutral (no
 * Meta-specific fields) — see AGENTS' "do not redefine types that already
 * exist" rule, which this module follows by EXTENDING rather than
 * reshadowing it. `metaTemplateId` and `components` are WhatsApp/Meta-only
 * concerns this module owns; every other field is `Template` verbatim.
 */
export interface WhatsAppTemplateRecord extends Template {
  readonly metaTemplateId: string;
  readonly components: readonly MetaTemplateDefinitionComponent[];
}

export interface MessageTemplateRepositoryPort {
  listByAccount(accountId: AccountId): Promise<readonly WhatsAppTemplateRecord[]>;
  findByMetaTemplateId(accountId: AccountId, metaTemplateId: string): Promise<WhatsAppTemplateRecord | null>;
  findById(accountId: AccountId, id: TemplateId): Promise<WhatsAppTemplateRecord | null>;
  /** Insert-or-update keyed on `(account_id, meta_template_id)`. */
  upsert(input: NewMessageTemplateInput): Promise<WhatsAppTemplateRecord>;
  updateStatus(
    accountId: AccountId,
    metaTemplateId: string,
    status: TemplateApprovalStatus,
    at: ISODateString,
  ): Promise<void>;
  delete(accountId: AccountId, metaTemplateId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// whatsapp_webhook_events (idempotency + replay)
// ---------------------------------------------------------------------------

export interface WebhookClaimResult {
  /** `true` when THIS call inserted the row (first delivery of this event);
   *  `false` when the row already existed (a redelivery / duplicate). See
   *  `domain/webhook-idempotency.ts`. */
  readonly isNew: boolean;
}

export interface WebhookEventRepositoryPort {
  /** Atomically records `(account_id, event_id)` if absent (append-only —
   *  never updated afterward), and reports whether this call was the one
   *  that created the row. Must be implemented as a single
   *  `INSERT ... ON CONFLICT DO NOTHING` / `INSERT OR IGNORE` statement, not
   *  a separate read-then-write, so concurrent redeliveries cannot both
   *  observe "not found" and both proceed. */
  claim(accountId: AccountId, eventId: string, payload: unknown, receivedAt: ISODateString): Promise<WebhookClaimResult>;
}

// ---------------------------------------------------------------------------
// contacts / contact_delivery_events (migration 0005 — messaging-errors)
// ---------------------------------------------------------------------------

export interface ContactDeliveryStateSnapshot {
  readonly contactId: ContactId;
  readonly consentState: ConsentState;
  readonly deliverabilityState: DeliverabilityState;
  readonly suppressedReasonCode: string | null;
}

export interface DeliveryEventInput {
  readonly accountId: AccountId;
  readonly contactId: ContactId;
  readonly occurredAt: ISODateString;
  readonly errorCode: string | null;
  readonly disposition: Disposition | null;
  readonly rawError: unknown;
  /** e.g. the outbound `wamid` or broadcast recipient row id this event
   *  concerns — free-form reference, not a foreign key this port enforces. */
  readonly messageRef: string | null;
}

export interface ContactStateRepositoryPort {
  /** `null` when no contact row exists yet for this phone number in this
   *  account — callers treat that as "unknown" (never blocks a send). */
  findByPhoneNumber(accountId: AccountId, phone: PhoneNumber): Promise<ContactDeliveryStateSnapshot | null>;
  /** Append-only audit row — never mutated (META_ERROR_TAXONOMY.md §4). */
  recordDeliveryEvent(input: DeliveryEventInput): Promise<void>;
  /** Applies the `unknown|reachable|manually_cleared -> suppressed`
   *  transition (`domain/suppression.ts` in `messaging-errors`,
   *  re-implemented here only as a SQL `UPDATE`, not re-decided — the
   *  disposition->suppress decision itself is made by the caller via
   *  `messaging-errors`' pure functions before this is called). */
  applyPermanentNumberFailure(
    accountId: AccountId,
    contactId: ContactId,
    reasonCode: string,
    at: ISODateString,
  ): Promise<void>;
}
