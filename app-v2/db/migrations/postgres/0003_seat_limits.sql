-- ============================================================
-- 0003_seat_limits.sql (Postgres dialect)
--
-- Same logical schema as db/migrations/d1/0003_seat_limits.sql. The
-- single-row constraint on `platform_settings` uses the same
-- `CHECK (id = 1)` trick for parity with the D1 migration rather than a
-- Postgres-only mechanism (e.g. a partial unique index on a constant) —
-- keeps both adapters' DDL readable side by side.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  default_seat_limit    INTEGER NOT NULL DEFAULT 3,
  updated_at            TIMESTAMPTZ NOT NULL,
  updated_by            TEXT
);

INSERT INTO platform_settings (id, default_seat_limit, updated_at, updated_by)
VALUES (1, 3, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z', NULL)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS plans (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  included_seats      INTEGER,
  max_seats           INTEGER,
  extra_seat_price    NUMERIC,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS seat_limit_override INTEGER;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS seat_limit_reason TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS seat_limit_set_by TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS seat_limit_set_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS seat_usage_events (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  delta           INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  actor_user_id   TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seat_usage_events_account ON seat_usage_events(account_id, occurred_at);
