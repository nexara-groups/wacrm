-- 0011_credentials.sql (Postgres)
--
-- The JWT credentials tables. These were MISSING from this repo's migration
-- stream: the framework ships them (nexara-repo-framework db/migrations/d1/
-- 0002_credentials.sql) but the scaffolding commit copied only src/ and
-- scripts/, not db/. The consequence was silent and total —
-- `SqlCredentialsRepository` exists, the container wires it whenever
-- AUTH_PROVIDER=jwt (the default), and every query it issues targets a table
-- that did not exist. Nobody could have logged in.
--
-- It went unnoticed because no test ran the credentials repository against a
-- real schema, and 0001_identity.sql's `users` table deliberately has no
-- password column — its header defers secrets to exactly this table.
--
-- Column shapes are carried over from the framework migration unchanged, so
-- the already-written repository works against them without modification.
-- Tenant column is `tenant_id` here (the framework's vocabulary) rather than
-- `account_id`; both are accepted by the architecture guard.

CREATE TABLE IF NOT EXISTS credentials (
  user_id         TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner','admin','manager','member')),
  session_version INTEGER NOT NULL DEFAULT 0,
  verified_at     TEXT,
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, email)
);

-- Single-use, TTL-bounded. `redemption_id` is what makes redemption atomic:
-- the password update and the token consumption are gated on the same id, so
-- a replayed token cannot change a password a second time.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash      TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  email           TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used_at         TEXT,
  redemption_id   TEXT
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_hash      TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  email           TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used_at         TEXT,
  redemption_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_tenant_user
  ON password_reset_tokens(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_tenant_user
  ON email_verification_tokens(tenant_id, user_id);
