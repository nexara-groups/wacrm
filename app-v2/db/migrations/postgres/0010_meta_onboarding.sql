-- ============================================================
-- 0010_meta_onboarding.sql (Postgres dialect)
--
-- Same logical schema as db/migrations/d1/0010_meta_onboarding.sql — see
-- that file's header for the full rationale, including the
-- SECURITY-CRITICAL note on `access_token_ref` never holding a raw token.
-- Only the timestamp column type differs (TIMESTAMPTZ vs TEXT), per this
-- migration set's convention.
-- ============================================================

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  state           TEXT NOT NULL
    CHECK (state IN ('created','meta_connected','phone_registered','webhook_verified','template_ready','complete')),
  started_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  last_error      TEXT,
  resume_token    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_account ON onboarding_sessions(account_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_sessions_resume_token ON onboarding_sessions(resume_token);

CREATE TABLE IF NOT EXISTS meta_business_connections (
  account_id          TEXT PRIMARY KEY,
  waba_id             TEXT NOT NULL,
  business_id         TEXT NOT NULL,
  phone_number_id     TEXT NOT NULL,
  access_token_ref    TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_events (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  session_id      TEXT NOT NULL REFERENCES onboarding_sessions(id),
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('CONNECT_META','REGISTER_PHONE','VERIFY_WEBHOOK','SYNC_TEMPLATES','COMPLETE','RECORD_FAILURE')),
  from_state      TEXT
    CHECK (from_state IS NULL OR from_state IN ('created','meta_connected','phone_registered','webhook_verified','template_ready','complete')),
  to_state        TEXT NOT NULL
    CHECK (to_state IN ('created','meta_connected','phone_registered','webhook_verified','template_ready','complete')),
  detail          TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onboarding_events_account_session ON onboarding_events(account_id, session_id, occurred_at);
