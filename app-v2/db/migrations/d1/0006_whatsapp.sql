-- ============================================================
-- 0006_whatsapp.sql (D1 / SQLite dialect)
--
-- modules/whatsapp — WhatsApp Cloud API configuration, the local template
-- mirror, and the append-only webhook idempotency log. Integrates with the
-- `contacts` / `contact_delivery_events` tables owned by migration 0005
-- (messaging-errors track, META_ERROR_TAXONOMY.md §4/§5) without
-- redefining them.
--
-- All ids are application-generated (crypto.randomUUID()) TEXT; all
-- timestamps are ISO-8601 TEXT — same conventions as every prior migration
-- in this set (see 0001's header for the full rationale). Every table
-- carries `account_id` and is indexed on it, per the architecture guard.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_configs (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL,
  phone_number_id       TEXT NOT NULL,
  waba_id               TEXT NOT NULL,
  display_name          TEXT,
  quality_rating        TEXT,
  verified_name         TEXT,
  -- Cloud API registration lifecycle — see MetaWhatsAppProvider /
  -- WhatsAppService.saveConfig. A saved config is not receiving webhooks
  -- until /register + /subscribed_apps have both succeeded.
  registration_state    TEXT NOT NULL DEFAULT 'unregistered'
    CHECK (registration_state IN ('unregistered','pending','registered','failed')),
  -- Opaque string. Encrypted at rest by the caller (mirrors the existing
  -- app's `whatsapp_config.access_token` handling) — this module stores
  -- and returns whatever it is given; encryption/decryption is outside
  -- this track's scope.
  access_token          TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- One Meta phone number can belong to exactly one account's config.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_configs_phone_number_id ON whatsapp_configs(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_configs_account ON whatsapp_configs(account_id);

CREATE TABLE IF NOT EXISTS message_templates (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL,
  -- Meta's template id (Business Management API `id`). Scopes edit/delete
  -- to a single language variant — see MetaWhatsAppProvider.deleteTemplate.
  meta_template_id      TEXT NOT NULL,
  name                  TEXT NOT NULL,
  -- BCP-47 / Meta locale code, e.g. "en_US".
  language              TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'utility'
    CHECK (category IN ('marketing','utility','authentication')),
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','paused','disabled')),
  body_text             TEXT NOT NULL DEFAULT '',
  -- Count of distinct {{n}} placeholders in body_text — validates send-time
  -- parameter counts against Meta code 132000 (META_ERROR_TAXONOMY.md §3).
  variable_count        INTEGER NOT NULL DEFAULT 0,
  -- Meta's full components array (header/body/footer/buttons), as JSON —
  -- needed verbatim to build a send-time components payload later.
  components            TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_account_meta_id ON message_templates(account_id, meta_template_id);
CREATE INDEX IF NOT EXISTS idx_message_templates_account ON message_templates(account_id);

-- Append-only. Never updated after insert (rows are written once, by
-- WhatsAppService.processWebhookEvent's idempotency claim) — see
-- domain/webhook-idempotency.ts for why `event_id` alone (not
-- account-scoped) is the uniqueness key: Meta's own message ids are
-- globally unique, and a single global key is what makes a REDELIVERY of
-- the exact same event collide, regardless of which account processes it
-- first.
CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  payload         TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  -- Set at insert time in this module's synchronous claim-and-process
  -- design (see application/whatsapp-service.ts#processWebhookEvent) —
  -- kept as its own nullable column, not derived from received_at, so a
  -- future asynchronous/queued processing model can claim a row (received)
  -- before it finishes processing without a schema change.
  processed_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_event_id ON whatsapp_webhook_events(event_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_account ON whatsapp_webhook_events(account_id, received_at);
