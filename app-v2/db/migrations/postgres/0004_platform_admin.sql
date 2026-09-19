-- ============================================================
-- 0004_platform_admin.sql (Postgres dialect)
--
-- Same logical schema as db/migrations/d1/0004_platform_admin.sql — see
-- that file's header for why these tables carry no tenant isolation
-- filter of their own (SUPER_ADMIN_CONSOLE.md §2/§4).
--
-- Postgres CAN enforce "append-only" for real (REVOKE UPDATE, DELETE ON
-- platform_audit_log, compliance_case_reads, compliance_case_exports FROM
-- the application role, leaving only INSERT/SELECT) where D1 cannot. That
-- REVOKE is deliberately not included here: it depends on the application
-- DB role name, which is an operational/deployment concern the DB gate
-- (DATABASE_DECISION.md) has not resolved yet, not a schema one. Whoever
-- wires the Postgres connection should add it once the role is chosen.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_admins (
  user_id             TEXT PRIMARY KEY,
  platform_role       TEXT NOT NULL CHECK (platform_role IN ('platform_support','platform_admin','platform_superadmin')),
  granted_by          TEXT NOT NULL,
  granted_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  mfa_enrolled_at     TIMESTAMPTZ,
  last_access_at      TIMESTAMPTZ
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
  occurred_at         TIMESTAMPTZ NOT NULL,
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
  started_at          TIMESTAMPTZ NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ,
  ended_reason        TEXT
);

CREATE INDEX IF NOT EXISTS idx_platform_impersonation_target_account ON platform_impersonation_sessions(target_account_id);

CREATE TABLE IF NOT EXISTS compliance_cases (
  id                      TEXT PRIMARY KEY,
  external_ref            TEXT NOT NULL,
  category                TEXT NOT NULL,
  account_id              TEXT NOT NULL,
  scope_type              TEXT NOT NULL CHECK (scope_type IN ('message_ids','contact','template','date_range')),
  scope_value             JSONB NOT NULL,
  opened_by               TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  approved_by             TEXT,
  approved_at             TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ NOT NULL,
  closed_at               TIMESTAMPTZ,
  closed_by               TEXT,
  outcome                 TEXT,
  tenant_notified_at      TIMESTAMPTZ,
  disclosure_restricted   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_compliance_cases_account ON compliance_cases(account_id);

CREATE TABLE IF NOT EXISTS compliance_case_reads (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL REFERENCES compliance_cases(id),
  actor_user_id       TEXT NOT NULL,
  resource_type       TEXT NOT NULL,
  resource_id         TEXT NOT NULL,
  read_at             TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compliance_case_reads_case ON compliance_case_reads(case_id, read_at);

CREATE TABLE IF NOT EXISTS compliance_case_exports (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL REFERENCES compliance_cases(id),
  actor_user_id       TEXT NOT NULL,
  format              TEXT NOT NULL,
  watermark           TEXT NOT NULL,
  exported_at         TIMESTAMPTZ NOT NULL,
  row_count           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compliance_case_exports_case ON compliance_case_exports(case_id);
