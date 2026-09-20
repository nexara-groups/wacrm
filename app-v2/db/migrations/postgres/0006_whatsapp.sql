-- ============================================================
-- 0006_whatsapp.sql (Postgres dialect)
--
-- Same logical schema as db/migrations/d1/0006_whatsapp.sql — see that
-- file's header for the full rationale. Only the timestamp column type
-- differs (TIMESTAMPTZ vs TEXT), per this migration set's convention.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_configs (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL,
  phone_number_id       TEXT NOT NULL,
  waba_id               TEXT NOT NULL,
  display_name          TEXT,
  quality_rating        TEXT,
  verified_name         TEXT,
  registration_state    TEXT NOT NULL DEFAULT 'unregistered'
    CHECK (registration_state IN ('unregistered','pending','registered','failed')),
  access_token          TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_configs_phone_number_id ON whatsapp_configs(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_configs_account ON whatsapp_configs(account_id);

CREATE TABLE IF NOT EXISTS message_templates (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL,
  meta_template_id      TEXT NOT NULL,
  name                  TEXT NOT NULL,
  language              TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'utility'
    CHECK (category IN ('marketing','utility','authentication')),
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','paused','disabled')),
  body_text             TEXT NOT NULL DEFAULT '',
  variable_count        INTEGER NOT NULL DEFAULT 0,
  components            TEXT NOT NULL DEFAULT '[]',
  created_at            TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_account_meta_id ON message_templates(account_id, meta_template_id);
CREATE INDEX IF NOT EXISTS idx_message_templates_account ON message_templates(account_id);

CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  payload         TEXT NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL,
  processed_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_event_id ON whatsapp_webhook_events(event_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_account ON whatsapp_webhook_events(account_id, received_at);
