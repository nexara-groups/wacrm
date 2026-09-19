-- 0012_message_retention.sql (D1 / SQLite dialect)
--
-- Per-contact message retention. Resolved the same way seat limits are
-- (0003_seat_limits.sql), because the product rule is the same shape:
--
--   resolved_retention(account) =
--     account.message_retention_override ?? platform_settings.default_message_retention_per_contact
--
-- Default 500, not 200. The lower the cap, the more likely it is that the
-- message Meta asks about is already gone: META_ERROR_TAXONOMY.md and
-- SUPER_ADMIN_CONSOLE.md §7 both assume a compliance case can produce the
-- message a query is about, and a compliance case can only ever show what
-- still exists. Trimming history and answering Meta are in direct tension,
-- so the default leans toward being able to answer, and an account that
-- would rather save space can be set lower.
--
-- NOTE for whoever implements the trim: `messages.reply_to` REFERENCES
-- messages(id). SQLite enforces foreign keys only when
-- `PRAGMA foreign_keys = ON`, which this project's sql.js harness does not
-- set — but D1 enforces them. So a trim that deletes a message another
-- surviving message replies to PASSES in dev and FAILS in production. The
-- trim must null the dangling `reply_to` of survivors in the same batch as
-- the delete.

ALTER TABLE platform_settings
  ADD COLUMN default_message_retention_per_contact INTEGER NOT NULL DEFAULT 500;

ALTER TABLE accounts ADD COLUMN message_retention_override INTEGER;
ALTER TABLE accounts ADD COLUMN message_retention_reason TEXT;
ALTER TABLE accounts ADD COLUMN message_retention_set_by TEXT;
ALTER TABLE accounts ADD COLUMN message_retention_set_at TEXT;

-- The trim's own working index: "the Nth newest message for this contact".
-- Without it, every trim decision is a scan, and on D1's free tier — which
-- meters rows read — a scan per inbound message is the most expensive
-- possible way to save storage.
CREATE INDEX IF NOT EXISTS idx_messages_contact_created
  ON messages(account_id, contact_id, created_at DESC);
