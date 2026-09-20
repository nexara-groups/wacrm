-- ============================================================
-- 0010_meta_onboarding.sql (D1 / SQLite dialect)
--
-- modules/meta-onboarding — the Embedded Signup wizard's persisted state:
-- one `onboarding_sessions` row per attempt, the account's single
-- `meta_business_connections` row (WABA + phone number identifiers plus a
-- REFERENCE to the Meta access token, never the token itself), and an
-- append-only `onboarding_events` audit trail of every transition.
--
-- State vocabulary is `modules/meta-onboarding/domain/onboarding-state-machine.ts`'s
-- `ONBOARDING_STATES` — kept in sync with the CHECK constraints below BY
-- HAND (SQL cannot import a TypeScript const):
--   created -> meta_connected -> phone_registered -> webhook_verified
--           -> template_ready -> complete
--
-- Like every migration since 0002, this set uses `account_id` (not
-- `tenant_id` — see 0001's header for why `users`/`credentials` are the one
-- exception). All ids are application-generated (crypto.randomUUID()) TEXT;
-- all timestamps are ISO-8601 TEXT — same conventions as every prior
-- migration.
--
-- SECURITY-CRITICAL: `meta_business_connections.access_token_ref` is a
-- REFERENCE to a secret held by a `SecretStorePort` implementation elsewhere
-- (see `modules/meta-onboarding/application/ports.ts`), never a raw Meta
-- access token. This table has no column shaped to hold one — the closest
-- thing, `access_token_ref`, is documented as opaque and this migration
-- intentionally does not add a second, more tempting column. Leaking a
-- customer's Meta access token is this module's worst possible failure.
-- ============================================================

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  state           TEXT NOT NULL
    CHECK (state IN ('created','meta_connected','phone_registered','webhook_verified','template_ready','complete')),
  started_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- Set only once `state` reaches 'complete'; null otherwise.
  completed_at    TEXT,
  -- Plain-English guidance for the last RECORD_FAILURE self-loop (see the
  -- state machine's module docstring) — cleared implicitly by the next
  -- successful transition's updateState call, which always re-supplies it.
  last_error      TEXT,
  -- Opaque, high-entropy (256-bit) resume-link token — see
  -- domain/resume-token.ts. Looked up directly, always additionally scoped
  -- by account_id at the query site (see OnboardingSessionRepositoryPort.
  -- findByResumeToken's docstring).
  resume_token    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_account ON onboarding_sessions(account_id, started_at);
-- Global uniqueness: a resume token is generated with 256 bits of entropy
-- and is meaningless outside the session it names, so one global index (not
-- one scoped per account) is both sufficient and simpler.
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_sessions_resume_token ON onboarding_sessions(resume_token);

-- One row per account — see MetaConnectionRepositoryPort.upsert's
-- `on conflict (account_id) do update`. A fresh onboarding attempt after a
-- prior `complete` overwrites this row rather than creating a second one:
-- there is exactly one live Meta connection per account, matching Meta's
-- own one-WABA-per-integration model.
CREATE TABLE IF NOT EXISTS meta_business_connections (
  account_id          TEXT PRIMARY KEY,
  waba_id             TEXT NOT NULL,
  business_id         TEXT NOT NULL,
  phone_number_id     TEXT NOT NULL,
  -- A SecretStorePort reference, NEVER a raw access token — see this file's
  -- header and application/ports.ts's SecretStorePort docstring.
  access_token_ref    TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Append-only (OnboardingEventRepositoryPort has no update/delete member —
-- see application/ports.ts's docstring on why: this table is evidence for
-- supporting a stuck customer, and evidence that can be rewritten is not
-- evidence).
CREATE TABLE IF NOT EXISTS onboarding_events (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  session_id      TEXT NOT NULL REFERENCES onboarding_sessions(id),
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('CONNECT_META','REGISTER_PHONE','VERIFY_WEBHOOK','SYNC_TEMPLATES','COMPLETE','RECORD_FAILURE')),
  -- Null only for an event with no meaningful "from" (there is none today —
  -- every transition, including a RECORD_FAILURE self-loop, has a
  -- well-defined from_state — but the column stays nullable to match
  -- OnboardingEventRecord.fromState's type without forcing a callers-invent-
  -- a-sentinel workaround later).
  from_state      TEXT
    CHECK (from_state IS NULL OR from_state IN ('created','meta_connected','phone_registered','webhook_verified','template_ready','complete')),
  to_state        TEXT NOT NULL
    CHECK (to_state IN ('created','meta_connected','phone_registered','webhook_verified','template_ready','complete')),
  detail          TEXT,
  occurred_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onboarding_events_account_session ON onboarding_events(account_id, session_id, occurred_at);
