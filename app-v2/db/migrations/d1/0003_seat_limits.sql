-- ============================================================
-- 0003_seat_limits.sql (D1 / SQLite dialect)
--
-- Per SEAT_LIMITS.md §2: resolved_seat_limit(account) =
--   account.seat_limit_override ?? plan.included_seats ?? platform_settings.default_seat_limit
--
-- `platform_settings` is a single-row table; SQLite has no native
-- single-row constraint, so it is enforced with `CHECK (id = 1)` on a
-- fixed primary key, mirrored by the Postgres migration.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  default_seat_limit    INTEGER NOT NULL DEFAULT 3,
  updated_at            TEXT NOT NULL,
  updated_by            TEXT
);

INSERT OR IGNORE INTO platform_settings (id, default_seat_limit, updated_at, updated_by)
VALUES (1, 3, '1970-01-01T00:00:00.000Z', NULL);

CREATE TABLE IF NOT EXISTS plans (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  included_seats      INTEGER,
  max_seats           INTEGER,
  extra_seat_price    NUMERIC,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Per-account seat cap override (SEAT_LIMITS.md §2/§5) — most specific
-- level of the resolution order, set by `platform_admin`+ with a mandatory
-- reason, always audited (`platform_audit_log` + `seat_usage_events`).
ALTER TABLE accounts ADD COLUMN seat_limit_override INTEGER;
ALTER TABLE accounts ADD COLUMN seat_limit_reason TEXT;
ALTER TABLE accounts ADD COLUMN seat_limit_set_by TEXT;
ALTER TABLE accounts ADD COLUMN seat_limit_set_at TEXT;

CREATE TABLE IF NOT EXISTS seat_usage_events (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  delta           INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  actor_user_id   TEXT,
  occurred_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seat_usage_events_account ON seat_usage_events(account_id, occurred_at);
