-- 0012_message_retention.sql (D1 / SQLite dialect)
--
-- Message retention: keep 60 days, delete what is older.
--
-- TIME-based, not count-based, and that was a real choice. A per-contact
-- count cap ("keep the last 500") gives every contact a different amount of
-- history — 500 messages is three days for a chatty customer and three
-- years for a quiet one — so nobody can state the policy, to a customer or
-- to a regulator. A window can be stated: "we keep 60 days".
--
-- Why 60 and not less: Meta's own Cloud API retains message content for
-- only 30 days, so Meta cannot ask about the text of an older message —
-- they no longer have it either. 60 days clears that with margin. The
-- longer-tail risk is a customer dispute, where the evidence burden is ours
-- rather than Meta's, and 60 days is the product owner's call on that
-- trade.
--
-- Resolved like seat limits (0003_seat_limits.sql), same shape of rule:
--   resolved_retention_days(account) =
--     accounts.message_retention_days_override
--       ?? platform_settings.default_message_retention_days
--
-- No count cap alongside it, deliberately. The worry a count cap answers is
-- one runaway thread eating the 5 GB database, and the arithmetic says it
-- cannot: at roughly 500 bytes a message, 5 GB is ~10 million messages, so
-- filling it inside a 60-day window needs ~166,000 messages a day from one
-- account. That is not this product's failure mode, and an unused safety
-- valve is still code to maintain and reason about.
--
-- IMPLEMENTATION NOTE — the trap this migration exists downstream of:
-- `messages.reply_to` REFERENCES messages(id). D1 enforces foreign keys;
-- stock SQLite does not. The harness now sets `PRAGMA foreign_keys = ON` to
-- match (see db/sqlite/sqljs-database-provider.ts), because a trim that
-- deletes a message some surviving message replies to SUCCEEDS with
-- enforcement off and is REJECTED with it on. The trim MUST null the
-- dangling `reply_to` of survivors in the same batch() as the delete.

ALTER TABLE platform_settings
  ADD COLUMN default_message_retention_days INTEGER NOT NULL DEFAULT 60;

ALTER TABLE accounts ADD COLUMN message_retention_days_override INTEGER;
ALTER TABLE accounts ADD COLUMN message_retention_reason TEXT;
ALTER TABLE accounts ADD COLUMN message_retention_set_by TEXT;
ALTER TABLE accounts ADD COLUMN message_retention_set_at TEXT;

-- The trim's working index: "this account's messages older than X".
-- Without it every sweep is a full scan, and on a tier that meters rows
-- read, scanning the whole table to save storage is a poor trade.
CREATE INDEX IF NOT EXISTS idx_messages_account_created
  ON messages(account_id, created_at);

-- Finding the survivors whose `reply_to` points at a row about to be
-- deleted, without scanning.
CREATE INDEX IF NOT EXISTS idx_messages_reply_to
  ON messages(account_id, reply_to);
