-- ============================================================
-- 0001_identity.sql (Postgres dialect)
--
-- Same logical schema as db/migrations/d1/0001_identity.sql — see that
-- file's header for the full rationale (users/credentials split, the
-- tenant_id vs account_id column-naming decision, app-generated ids and
-- timestamps). Forward-only — never edit an applied migration.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  user_id         TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  email           TEXT NOT NULL,
  display_name    TEXT,
  role            TEXT NOT NULL CHECK (role IN ('owner','admin','manager','member')),
  email_verified_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email ON users(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  account_id      TEXT NOT NULL,
  device_id       TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  account_id      TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  family_id       TEXT NOT NULL,
  rotated_from    TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_account ON refresh_tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens(session_id);

CREATE TABLE IF NOT EXISTS email_tokens (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  account_id      TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('reset','verify','invite')),
  token_hash      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_tokens_hash ON email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_tokens_account ON email_tokens(account_id);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);

CREATE TABLE IF NOT EXISTS device_installations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  account_id      TEXT NOT NULL,
  platform        TEXT NOT NULL,
  push_token      TEXT,
  device_id       TEXT NOT NULL,
  app_version     TEXT,
  last_seen_at    TIMESTAMPTZ,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_device_installations_account ON device_installations(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_installations_user_device ON device_installations(user_id, device_id);
