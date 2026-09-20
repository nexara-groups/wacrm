-- 0007_contacts.sql (Postgres)
--
-- Completes the contacts module's schema. 0005 created `contacts` with only
-- the columns the deliverability/consent design needed (id, account_id,
-- phone, timestamps, and the two state axes). This adds the profile columns,
-- tags, custom fields and the import audit trail that modules/contacts
-- actually works with.
--
-- The dedup guarantee lives here: UNIQUE (account_id, phone) on normalised
-- E.164 is what makes consent survive a CSV re-import. Without it, a second
-- import of the same number inserts a fresh row with default consent, and
-- everyone who opted out is silently re-subscribed — the exact incident
-- META_ERROR_TAXONOMY.md §3b exists to prevent.

-- Column types mirror the D1 stream deliberately: timestamps are ISO-8601
-- TEXT in both dialects so one repository implementation reads from either
-- without dialect-specific mapping. The DB choice is still open
-- (DATABASE_DECISION.md); keeping the two streams shape-identical is what
-- lets the benchmark decide without a code change.

-- ---------------------------------------------------------------------------
-- Profile columns
-- ---------------------------------------------------------------------------
-- `company` is a contacts-module concept and deliberately absent from the
-- shared Contact entity (see modules/contacts/application/ports.ts).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company TEXT;

-- The dedup constraint. Phone is stored normalised to E.164 by
-- packages/domain's parsePhoneNumber before it ever reaches this table.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_phone ON contacts(account_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_account_name ON contacts(account_id, display_name);

-- ---------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  color           TEXT,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_name ON tags(account_id, name);

CREATE TABLE IF NOT EXISTS contact_tags (
  account_id      TEXT NOT NULL,
  contact_id      TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id          TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (contact_id, tag_id)
);
-- Filtering by tag is the hot path for audience building, so index the
-- direction that query runs: tag -> contacts, scoped to the account.
CREATE INDEX IF NOT EXISTS idx_contact_tags_account_tag ON contact_tags(account_id, tag_id);
CREATE INDEX IF NOT EXISTS idx_contact_tags_account_contact ON contact_tags(account_id, contact_id);

-- ---------------------------------------------------------------------------
-- Custom fields
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  key             TEXT NOT NULL,
  label           TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('text','number','boolean','date','select')),
  -- JSON array of permitted values; only meaningful when type = 'select'.
  options         TEXT,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_field_defs_account_key
  ON custom_field_definitions(account_id, key);

CREATE TABLE IF NOT EXISTS contact_custom_values (
  account_id      TEXT NOT NULL,
  contact_id      TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  field_id        TEXT NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  -- Stored as text in every case; the definition's `type` says how to read it.
  -- One column rather than one per type keeps reads simple, and the domain
  -- layer already validates the value against the definition on write.
  value           TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (contact_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_custom_values_account_field
  ON contact_custom_values(account_id, field_id);

-- ---------------------------------------------------------------------------
-- Import audit
-- ---------------------------------------------------------------------------
-- One row per import run. Rejected rows are recorded WITH their reason rather
-- than silently skipped (META_ERROR_TAXONOMY.md §4b: say what happened and
-- what to do next), so an operator can see why 12 of 3,000 rows did not land.
CREATE TABLE IF NOT EXISTS contact_imports (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL,
  started_by_user_id  TEXT,
  file_name           TEXT,
  total_rows          INTEGER NOT NULL DEFAULT 0,
  created_count       INTEGER NOT NULL DEFAULT 0,
  updated_count       INTEGER NOT NULL DEFAULT 0,
  rejected_count      INTEGER NOT NULL DEFAULT 0,
  started_at          TEXT NOT NULL,
  completed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_contact_imports_account ON contact_imports(account_id, started_at);

CREATE TABLE IF NOT EXISTS contact_import_rejections (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  import_id       TEXT NOT NULL REFERENCES contact_imports(id) ON DELETE CASCADE,
  row_number      INTEGER NOT NULL,
  raw_phone       TEXT,
  -- Customer-facing copy, never a stack trace or a parser internal.
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_import_rejections_account_import
  ON contact_import_rejections(account_id, import_id);
