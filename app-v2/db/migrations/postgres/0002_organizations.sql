-- ============================================================
-- 0002_organizations.sql (Postgres dialect)
--
-- Same logical schema as db/migrations/d1/0002_organizations.sql — see
-- that file's header for the role-vocabulary reconciliation and the
-- one-account-per-user design note.
-- ============================================================

CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  plan_id         TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner','admin','manager','member')),
  created_at      TIMESTAMPTZ NOT NULL,
  deactivated_at  TIMESTAMPTZ
);

-- Locked design decision (see d1/0002_organizations.sql): one account per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_one_per_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_account ON memberships(account_id);

CREATE TABLE IF NOT EXISTS account_invitations (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(id),
  token_hash            TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('admin','manager','member')),
  created_by_user_id    TEXT,
  label                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  accepted_at           TIMESTAMPTZ,
  accepted_by_user_id   TEXT,
  revoked_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_invitations_token ON account_invitations(token_hash);
CREATE INDEX IF NOT EXISTS idx_account_invitations_account_pending
  ON account_invitations(account_id, expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
