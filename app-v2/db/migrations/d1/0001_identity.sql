-- ============================================================
-- 0001_identity.sql (D1 / SQLite dialect)
--
-- Foundation identity tables per AUTH_EXTENSION.md. Forward-only —
-- never edit an applied migration, add a new numbered file instead.
--
-- `users` is identity ONLY (no password). Secrets live in the
-- separately-owned `credentials` table (see `sql-credentials-repository.ts`,
-- built by the auth track, not this migration set) — this split is the
-- CredentialsRepository interface's own contract: "Password hashes never
-- flow through a profile or user port."
--
-- Column naming note: `users.tenant_id` (not `account_id`) deliberately
-- matches the already-shipped `credentials` table, because both are read
-- through the same `TenantContext` and because `scripts/check-architecture.mjs`
-- requires the literal substring `tenant_id` in every infra SQL statement.
-- Everywhere else in this migration set (organizations, seat limits,
-- platform admin, contacts) uses `account_id`, matching the business docs
-- verbatim. Both columns hold the same value: `accounts.id`.
--
-- All ids are application-generated (crypto.randomUUID()) TEXT, never a
-- DB-side default — SQLite has no portable UUID generator and Postgres'
-- would be dialect-specific, so id generation stays in application code on
-- both adapters. All timestamps are ISO-8601 TEXT for the same reason
-- (avoids SQLite `strftime` vs Postgres `now()`); values are produced by
-- application code, not SQL defaults.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  user_id         TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  email           TEXT NOT NULL,
  display_name    TEXT,
  role            TEXT NOT NULL CHECK (role IN ('owner','admin','manager','member')),
  email_verified_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email ON users(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(user_id),
  account_id      TEXT NOT NULL,
  device_id       TEXT,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Reuse detection: a `refresh_tokens` row that is presented again after
-- `used_at`/`rotated_from` is already set means the whole `family_id` must
-- be revoked (AUTH_EXTENSION.md) — enforced in application code, not here;
-- the schema just carries the columns that make it possible.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  account_id      TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  family_id       TEXT NOT NULL,
  rotated_from    TEXT,
  expires_at      TEXT NOT NULL,
  used_at         TEXT,
  revoked_at      TEXT
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
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT
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
  last_seen_at    TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_device_installations_account ON device_installations(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_installations_user_device ON device_installations(user_id, device_id);
