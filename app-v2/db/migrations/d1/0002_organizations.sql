-- ============================================================
-- 0002_organizations.sql (D1 / SQLite dialect)
--
-- Accounts (tenants), membership, invitations. Per SEAT_LIMITS.md §1 the
-- legacy role vocabulary (`owner`/`admin`/`agent`/`viewer`) is reconciled
-- to the framework's four roles (`owner`/`admin`/`manager`/`member`) here,
-- during the port, rather than carrying both — `agent` -> `member`,
-- `viewer` -> `member` (view-only enforcement is a `PermissionService`
-- policy concern, not a fifth stored role; see SEAT_LIMITS.md §1).
--
-- `memberships` is the normalized, potentially-many-to-many source of
-- truth for "who is on this account with what role" (mirrors the legacy
-- `profiles.account_id` + `profiles.account_role` it replaces). Today's
-- product rule is still one account per user (SEAT_LIMITS.md carries no
-- provision to relax this yet), enforced with a UNIQUE(user_id) index —
-- easy to relax later without a schema change if that rule ever changes.
-- ============================================================

CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  plan_id         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner','admin','manager','member')),
  created_at      TEXT NOT NULL,
  deactivated_at  TEXT
);

-- Locked design decision (see comment above): one account per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_one_per_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_account ON memberships(account_id);

CREATE TABLE IF NOT EXISTS account_invitations (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(id),
  token_hash            TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('admin','manager','member')),
  created_by_user_id    TEXT,
  label                 TEXT,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  accepted_at           TEXT,
  accepted_by_user_id   TEXT,
  revoked_at            TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_invitations_token ON account_invitations(token_hash);
CREATE INDEX IF NOT EXISTS idx_account_invitations_account_pending
  ON account_invitations(account_id, expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
