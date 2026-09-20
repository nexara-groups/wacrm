-- ============================================================
-- 0008_conversations.sql (Postgres dialect)
--
-- Same logical schema as db/migrations/d1/0008_conversations.sql — see that
-- file's header for the full rationale (account_id naming, maintained
-- unread_count invariant, updated_at as the incremental-sync cursor,
-- wamid uniqueness for idempotent webhook ingest).
-- ============================================================

CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  contact_id        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  assigned_to       TEXT,
  unread_count      INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message_at   TIMESTAMPTZ,
  last_inbound_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_account_last_message
  ON conversations(account_id, last_message_at);

CREATE INDEX IF NOT EXISTS idx_conversations_account_updated
  ON conversations(account_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_conversations_account_has_unread
  ON conversations(account_id)
  WHERE unread_count > 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact
  ON conversations(account_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_conversations_account_assigned
  ON conversations(account_id, assigned_to);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  contact_id        TEXT NOT NULL,
  wamid             TEXT,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  type              TEXT NOT NULL CHECK (type IN ('text','template','media','interactive','system')),
  body              TEXT,
  template_id       TEXT,
  media_ref         TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','delivered','read','replied','failed')),
  error_code        TEXT,
  reply_to          TEXT REFERENCES messages(id),
  sent_at           TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_account_conversation_created
  ON messages(account_id, conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_account_updated
  ON messages(account_id, updated_at);

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
  created_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_account_message
  ON message_reactions(account_id, message_id);

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
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_actions_account_conversation
  ON message_actions(account_id, conversation_id, created_at);
