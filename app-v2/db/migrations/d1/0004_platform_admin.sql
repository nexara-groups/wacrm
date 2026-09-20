-- ============================================================
-- 0004_platform_admin.sql (D1 / SQLite dialect)
--
-- Per SUPER_ADMIN_CONSOLE.md §2/§6/§7. `platformRole` is an orthogonal
-- principal dimension, never a tenant role — these tables are
-- intentionally NOT tenant-scoped by a `tenant_id`/`account_id` filter on
-- their primary key; `target_account_id` / `account_id` columns below are
-- the *subject* of a cross-tenant action, not an isolation boundary. Access
-- to these tables is gated in application code by an explicit, enumerated
-- guard exemption (SUPER_ADMIN_CONSOLE.md §4), not by this schema.
--
-- `platform_audit_log`, `compliance_case_reads` and `compliance_case_exports`
-- are append-only by convention (no UPDATE/DELETE code path is to be
-- written against them); SQLite/D1 has no per-table privilege system to
-- enforce this at the DB level the way Postgres REVOKE could, so it is
-- enforced by never writing that code, same as Postgres will be here.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_admins (
  user_id             TEXT PRIMARY KEY,
  platform_role       TEXT NOT NULL CHECK (platform_role IN ('platform_support','platform_admin','platform_superadmin')),
  granted_by          TEXT NOT NULL,
  granted_at          TEXT NOT NULL,
  revoked_at          TEXT,
  mfa_enrolled_at     TEXT,
  last_access_at      TEXT
);

CREATE TABLE IF NOT EXISTS platform_audit_log (
  id                  TEXT PRIMARY KEY,
  actor_user_id       TEXT NOT NULL,
  platform_role       TEXT NOT NULL,
  action              TEXT NOT NULL,
  target_account_id   TEXT,
  target_resource     TEXT,
  reason              TEXT,
  ip                  TEXT,
  user_agent          TEXT,
  occurred_at         TEXT NOT NULL,
  request_id          TEXT
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_log_actor ON platform_audit_log(actor_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_platform_audit_log_target_account ON platform_audit_log(target_account_id, occurred_at);

CREATE TABLE IF NOT EXISTS platform_impersonation_sessions (
  id                  TEXT PRIMARY KEY,
  actor_user_id       TEXT NOT NULL,
  target_account_id   TEXT NOT NULL,
  target_user_id      TEXT NOT NULL,
  reason              TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  ended_at            TEXT,
  ended_reason        TEXT
);

CREATE INDEX IF NOT EXISTS idx_platform_impersonation_target_account ON platform_impersonation_sessions(target_account_id);

-- Compliance cases (SUPER_ADMIN_CONSOLE.md §7) — scope declared before
-- access, 2-person rule (`approved_by`), TTL enforced at query time by
-- application code (`expires_at` alone must never be trusted as "closed").
CREATE TABLE IF NOT EXISTS compliance_cases (
  id                      TEXT PRIMARY KEY,
  external_ref            TEXT NOT NULL,
  category                TEXT NOT NULL,
  account_id              TEXT NOT NULL,
  scope_type              TEXT NOT NULL CHECK (scope_type IN ('message_ids','contact','template','date_range')),
  scope_value             TEXT NOT NULL,
  opened_by               TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  approved_by             TEXT,
  approved_at             TEXT,
  expires_at              TEXT NOT NULL,
  closed_at               TEXT,
  closed_by               TEXT,
  outcome                 TEXT,
  tenant_notified_at      TEXT,
  disclosure_restricted   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_compliance_cases_account ON compliance_cases(account_id);

CREATE TABLE IF NOT EXISTS compliance_case_reads (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL REFERENCES compliance_cases(id),
  actor_user_id       TEXT NOT NULL,
  resource_type       TEXT NOT NULL,
  resource_id         TEXT NOT NULL,
  read_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compliance_case_reads_case ON compliance_case_reads(case_id, read_at);

CREATE TABLE IF NOT EXISTS compliance_case_exports (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL REFERENCES compliance_cases(id),
  actor_user_id       TEXT NOT NULL,
  format              TEXT NOT NULL,
  watermark           TEXT NOT NULL,
  exported_at         TEXT NOT NULL,
  row_count           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compliance_case_exports_case ON compliance_case_exports(case_id);
