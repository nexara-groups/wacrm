-- ============================================================
-- 0008_conversations.sql (D1 / SQLite dialect)
--
-- Core CRM tables per modules/conversations: `conversations`, `messages`,
-- `message_reactions`, `message_actions`. Forward-only — never edit an
-- applied migration, add a new numbered file instead.
--
-- Column naming: `account_id` throughout (matching `contacts` in
-- 0005_contact_deliverability.sql and the business docs verbatim — see
-- 0001_identity.sql's header for why `users`/`sessions`/etc. are the one
-- exception that uses `tenant_id`). All ids are application-generated
-- (crypto.randomUUID()) TEXT; all timestamps are ISO-8601 TEXT produced by
-- application code, never a DB-side default — see 0001_identity.sql's
-- header for the full rationale (SQLite `strftime` vs Postgres `now()`
-- portability).
--
-- `conversations.unread_count` is a MAINTAINED COUNTER, not a value derived
-- by counting `messages` rows on read (modules/conversations/domain/
-- conversation.ts documents the exact invariants). `updated_at` on both
-- `conversations` and `messages` is the incremental-sync cursor column
-- (modules/conversations/domain/incremental-sync.ts) — every write to
-- either table MUST bump `updated_at` to the same application-generated
-- "now" used for the write itself, non-decreasing, so the keyset+tie-break
-- cursor algorithm cannot skip a concurrently-committed row.
--
-- `messages.wamid` (Meta's WhatsApp message id) is UNIQUE PER ACCOUNT, not
-- globally — the same physical `wamid` value cannot exist twice for one
-- account, but the column is otherwise nullable (a message may not have one
-- yet, e.g. a locally-composed outbound message not yet sent). The
-- uniqueness is what makes Meta webhook redelivery idempotent: an insert
-- that collides on `(account_id, wamid)` returns the existing row instead of
-- creating a duplicate (see infrastructure/message-repository.ts).
-- ============================================================

CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  contact_id        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  assigned_to       TEXT,
  unread_count      INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  -- Advances on every message, inbound or outbound.
  last_message_at   TEXT,
  -- Advances on INBOUND messages only — the sole anchor for the 24h
  -- customer-service window (modules/conversations/domain/24h-window.ts;
  -- the domain rule behind Meta error 131047).
  last_inbound_at   TEXT,
  created_at        TEXT NOT NULL,
  -- Incremental-sync cursor column — see header.
  updated_at        TEXT NOT NULL
);

-- Conversation list hot path: "this account's conversations, newest
-- last_message_at first" (the inbox's default view).
CREATE INDEX IF NOT EXISTS idx_conversations_account_last_message
  ON conversations(account_id, last_message_at);

-- Incremental-sync cursor hot path.
CREATE INDEX IF NOT EXISTS idx_conversations_account_updated
  ON conversations(account_id, updated_at);

-- Total-unread badge: a partial index over exactly the rows that count,
-- so `countUnreadConversations` is a cheap index-only count, never a scan
-- of every conversation (let alone every message).
CREATE INDEX IF NOT EXISTS idx_conversations_account_has_unread
  ON conversations(account_id)
  WHERE unread_count > 0;

-- One conversation per contact per account (WhatsApp is inherently 1:1
-- business<->customer per number) — also what makes
-- `findByContactId`/find-or-create race-safe via `INSERT ... ON CONFLICT`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact
  ON conversations(account_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_conversations_account_assigned
  ON conversations(account_id, assigned_to);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  contact_id        TEXT NOT NULL,
  -- Meta's WhatsApp message id. NULL until a send round-trips (or absent
  -- entirely for a purely local draft) — see header for the uniqueness rule.
  wamid             TEXT,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  type              TEXT NOT NULL CHECK (type IN ('text','template','media','interactive','system')),
  body              TEXT,
  template_id       TEXT,
  -- Opaque StorageProvider reference — required when type = 'media', forbidden otherwise (modules/conversations/domain/message.ts `assertMediaInvariant`).
  media_ref         TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','delivered','read','replied','failed')),
  -- The Meta error code behind a 'failed' status, if any.
  error_code        TEXT,
  reply_to          TEXT REFERENCES messages(id),
  sent_at           TEXT,
  delivered_at      TEXT,
  read_at           TEXT,
  created_at        TEXT NOT NULL,
  -- Incremental-sync cursor column — see header. Also bumped on every
  -- status transition (a delivery-receipt webhook), not just on insert.
  updated_at        TEXT NOT NULL
);

-- Thread hot path: "this conversation's messages, oldest/newest by
-- created_at" — keyset-paginated, never OFFSET-paginated (see
-- application/inbox-service.ts `getThread`).
CREATE INDEX IF NOT EXISTS idx_messages_account_conversation_created
  ON messages(account_id, conversation_id, created_at);

-- Incremental-sync cursor hot path.
CREATE INDEX IF NOT EXISTS idx_messages_account_updated
  ON messages(account_id, updated_at);

-- Idempotent webhook ingest / wamid lookup (delivery-receipt webhooks are
-- addressed by wamid, not by our internal id). Partial: most rows will have
-- a wamid, but it must stay optional for locally-composed drafts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_account_wamid
  ON messages(account_id, wamid)
  WHERE wamid IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_reactions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL REFERENCES messages(id),
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('user','contact')),
  actor_id      TEXT NOT NULL,
  emoji         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_account_message
  ON message_reactions(account_id, message_id);

-- One reaction slot per (actor, message) — modules/conversations/domain/
-- message.ts `applyReaction` swaps-in-place rather than accumulating.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reactions_actor
  ON message_reactions(message_id, actor_type, actor_id);

CREATE TABLE IF NOT EXISTS message_actions (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  message_id        TEXT REFERENCES messages(id),
  actor_user_id     TEXT,
  action_type       TEXT NOT NULL
    CHECK (action_type IN ('sent','status_changed','reopened_conversation','note_added')),
  -- Small, action-specific JSON blob. TEXT on D1 (no native JSON type);
  -- JSONB on Postgres — see 0005_contact_deliverability.sql's
  -- `raw_error` for the same per-dialect split.
  metadata          TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_actions_account_conversation
  ON message_actions(account_id, conversation_id, created_at);
