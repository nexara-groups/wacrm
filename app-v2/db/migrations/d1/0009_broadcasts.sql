-- ============================================================
-- 0009_broadcasts.sql (D1 / SQLite dialect)
--
-- broadcasts + broadcast_recipients — the broadcasts module's own tables.
-- See META_ERROR_TAXONOMY.md §4's `broadcast_recipients` sketch
-- ("+ error_code, disposition, attempt_count, next_attempt_at") and §4b
-- (the report/preview surfaces this module's domain layer serves).
--
-- Column naming: `account_id` throughout, matching every migration in this
-- set except 0001's `users`/`sessions`-adjacent tables (see that file's
-- header for why). `account_id` is this table's tenant column.
--
-- `status` on `broadcasts` mirrors
-- packages/domain/src/status/broadcast-status.ts EXACTLY
-- (draft/scheduled/sending/sent/failed) — this module does not invent a
-- "paused" status value. Pause/resume are modeled with the separate
-- `paused_at`/`pause_reason` columns instead: `status = 'sending'` with a
-- non-null `paused_at` means "mid-run but paused", cleared on resume;
-- `status = 'failed'` (the enum's own terminal value) is reserved for
-- cancellation and unrecoverable runs. See
-- modules/broadcasts/application/ports.ts's `BroadcastRecord` docstring.
--
-- `status` on `broadcast_recipients` mirrors
-- packages/domain/src/status/recipient-status.ts EXACTLY
-- (pending/sent/delivered/read/replied/failed) — a RETRYABLE failure is
-- represented by staying in `pending` with `attempt_count`/
-- `next_attempt_at` advanced, not by a separate "retrying" status value
-- that does not exist in the imported vocabulary; `failed` is reserved for
-- the terminal case (permanent disposition, or retries exhausted), per
-- recipient-status.ts's LEGAL_TRANSITIONS (`failed` has no outbound
-- edges). See modules/broadcasts/domain/recipient-outcome.ts.
--
-- All ids are application-generated (crypto.randomUUID()) TEXT, never a
-- DB-side default. All timestamps are ISO-8601 TEXT produced by
-- application code, never database-side NOW()/strftime() — see 0001's
-- header for the full rationale (SQLite/Postgres portability).
-- ============================================================

CREATE TABLE IF NOT EXISTS broadcasts (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL,
  name                  TEXT NOT NULL,
  template_id           TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','sending','sent','failed')),
  scheduled_at          TEXT,
  created_by            TEXT NOT NULL,

  -- Pause/resume — orthogonal to `status` (see header). NULL = not paused.
  paused_at             TEXT,
  pause_reason          TEXT,

  -- Counts. `total_recipients`/`skipped_count` are set once, at audience
  -- build time (META_ERROR_TAXONOMY.md §4b: "the number they see is the
  -- number that goes out" — total_recipients MUST equal the count actually
  -- enqueued into broadcast_recipients, never the pre-filter candidate
  -- count). `sent_count`/`failed_count` accumulate as the queue drains.
  total_recipients      INTEGER NOT NULL DEFAULT 0,
  skipped_count         INTEGER NOT NULL DEFAULT 0,
  sent_count            INTEGER NOT NULL DEFAULT 0,
  failed_count          INTEGER NOT NULL DEFAULT 0,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_account ON broadcasts(account_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_account_status ON broadcasts(account_id, status);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  broadcast_id      TEXT NOT NULL REFERENCES broadcasts(id),
  contact_id        TEXT NOT NULL,

  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','delivered','read','replied','failed')),

  -- META_ERROR_TAXONOMY.md §4: error_code alongside the existing free-text
  -- error_message — error_message is now always the classifier's
  -- customer-facing layman copy (or a pre-send-guard block message), never
  -- Meta's raw developer string (§4b). error_code carries a Meta code, the
  -- synthetic "NETWORK"/"UNKNOWN" keys, or a pre-send-guard synthetic code
  -- (SUPPRESSED/OPTED_OUT/DO_NOT_CONTACT).
  error_code        TEXT,
  error_message     TEXT,
  disposition       TEXT CHECK (disposition IN ('TRANSIENT','THROTTLED','PERMANENT_NUMBER','PERMANENT_CONFIG')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT,

  wamid             TEXT,
  sent_at           TEXT,
  delivered_at      TEXT,
  read_at           TEXT,
  replied_at        TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Queue-draining index: (account_id, broadcast_id, status, next_attempt_at)
-- backs "the oldest due, still-pending recipients for this broadcast"
-- without a table scan (modules/broadcasts/infrastructure/broadcast-repository.ts's listDueForSend).
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_queue
  ON broadcast_recipients(account_id, broadcast_id, status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_account ON broadcast_recipients(account_id);

-- One recipient row per (broadcast, contact) — createMany relies on this to
-- make audience enqueue idempotent against accidental double-invocation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_recipients_unique
  ON broadcast_recipients(broadcast_id, contact_id);
