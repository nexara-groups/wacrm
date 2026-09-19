-- ============================================================
-- 0005_contact_deliverability.sql (Postgres dialect)
--
-- Same logical schema and seed data as
-- db/migrations/d1/0005_contact_deliverability.sql — see that file's
-- header for why `contacts` here is a deliberately minimal placeholder.
-- ============================================================

CREATE TABLE IF NOT EXISTS contacts (
  id                        TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL,
  phone                     TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL,
  updated_at                TIMESTAMPTZ NOT NULL,

  deliverability_state      TEXT NOT NULL DEFAULT 'unknown'
    CHECK (deliverability_state IN ('unknown','reachable','suppressed','manually_cleared')),
  suppressed_at             TIMESTAMPTZ,
  suppressed_reason_code    TEXT,
  suppression_strikes       INTEGER NOT NULL DEFAULT 0,

  consent_state             TEXT NOT NULL DEFAULT 'unknown'
    CHECK (consent_state IN ('unknown','opted_in','opted_out','do_not_contact')),
  opted_out_at              TIMESTAMPTZ,
  opt_out_source            TEXT CHECK (opt_out_source IN ('keyword','quick_reply','inferred_block','operator','import')),
  opt_out_evidence          TEXT,
  opt_out_scope             TEXT NOT NULL DEFAULT 'all'
);

CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_phone ON contacts(account_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_account_deliverability ON contacts(account_id, deliverability_state);
CREATE INDEX IF NOT EXISTS idx_contacts_account_consent ON contacts(account_id, consent_state);

CREATE TABLE IF NOT EXISTS contact_delivery_events (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  contact_id      TEXT NOT NULL REFERENCES contacts(id),
  occurred_at     TIMESTAMPTZ NOT NULL,
  error_code      TEXT,
  disposition     TEXT CHECK (disposition IN ('TRANSIENT','THROTTLED','PERMANENT_NUMBER','PERMANENT_CONFIG')),
  raw_error       JSONB,
  message_ref     TEXT,
  broadcast_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_contact_delivery_events_account ON contact_delivery_events(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_contact_delivery_events_contact ON contact_delivery_events(contact_id, occurred_at);

CREATE TABLE IF NOT EXISTS meta_error_codes (
  code                        TEXT PRIMARY KEY,
  disposition                 TEXT NOT NULL CHECK (disposition IN ('TRANSIENT','THROTTLED','PERMANENT_NUMBER','PERMANENT_CONFIG')),
  layman_message              TEXT NOT NULL,
  operator_hint                TEXT NOT NULL,
  retry_max                   INTEGER NOT NULL,
  retry_base_delay_seconds    INTEGER NOT NULL,
  updated_at                  TIMESTAMPTZ NOT NULL
);

INSERT INTO meta_error_codes (code, disposition, layman_message, operator_hint, retry_max, retry_base_delay_seconds, updated_at) VALUES
  ('131026', 'PERMANENT_NUMBER', 'This number isn''t on WhatsApp, or can''t receive messages. We''ve stopped sending to it.', 'Meta code 131026: message undeliverable. Number is unreachable; suppressed automatically.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131021', 'PERMANENT_NUMBER', 'This is your own WhatsApp number — you can''t message yourself.', 'Meta code 131021: recipient cannot be sender.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131009', 'PERMANENT_NUMBER', 'This phone number isn''t valid. Check the country code and format.', 'Meta code 131009: parameter value not valid. Treat as PERMANENT_CONFIG instead if the invalid parameter is not the recipient number.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),

  ('131047', 'PERMANENT_CONFIG', 'It''s been over 24 hours since this person last messaged you. Use an approved template to reach them.', 'Meta code 131047: re-engagement required, 24-hour window closed.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('132001', 'PERMANENT_CONFIG', 'This template isn''t approved for the language you''re sending in.', 'Meta code 132001: template does not exist / not approved in that language.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('132000', 'PERMANENT_CONFIG', 'This template expects a different number of values than were provided.', 'Meta code 132000: parameter count mismatch.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('132015', 'PERMANENT_CONFIG', 'This template is paused because of poor quality ratings. Edit it or use a different one.', 'Meta code 132015: template paused.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('132016', 'PERMANENT_CONFIG', 'This template has been disabled by Meta and can''t be used.', 'Meta code 132016: template disabled.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('132012', 'PERMANENT_CONFIG', 'One of the values in this template is in the wrong format.', 'Meta code 132012: parameter format mismatch.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('132005', 'PERMANENT_CONFIG', 'The filled-in template message is too long to send.', 'Meta code 132005: hydrated text too long.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131031', 'PERMANENT_CONFIG', 'Your WhatsApp Business account has been restricted by Meta. Check WhatsApp Manager.', 'Meta code 131031: business account restricted.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131042', 'PERMANENT_CONFIG', 'There''s a billing problem on your WhatsApp Business account. Check your payment method with Meta.', 'Meta code 131042: business eligibility / payment issue.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('133010', 'PERMANENT_CONFIG', 'This WhatsApp number isn''t registered yet. Finish setup before sending.', 'Meta code 133010: phone number not registered.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('190', 'PERMANENT_CONFIG', 'Your WhatsApp connection has expired. Reconnect your account.', 'Meta code 190: access token expired/invalid.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('10', 'PERMANENT_CONFIG', 'We don''t have permission to do this. Reconnect your WhatsApp account.', 'Meta code 10: permission denied.', 0, 0, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),

  ('130429', 'THROTTLED', 'Sending too fast — we''ll slow down and keep going.', 'Meta code 130429: Cloud API throughput limit.', 5, 30, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131048', 'THROTTLED', 'Meta has temporarily limited your sending. We''ll retry shortly.', 'Meta code 131048: spam rate limit.', 5, 60, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131056', 'THROTTLED', 'Too many messages to this contact right now. We''ll retry shortly.', 'Meta code 131056: business/recipient pair rate limit.', 5, 60, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('4', 'THROTTLED', 'We''ve hit a temporary limit. Sending will resume automatically.', 'Meta code 4: app-level too many calls.', 5, 30, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('80007', 'THROTTLED', 'Your account''s sending limit was reached. Sending resumes automatically.', 'Meta code 80007: WABA rate limit.', 5, 60, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('133016', 'THROTTLED', 'Too many setup attempts. Wait a few minutes and try again.', 'Meta code 133016: register/deregister rate limit.', 3, 60, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131049', 'THROTTLED', 'Meta limited marketing messages to this person right now. We''ll try again later.', 'Meta code 131049: healthy ecosystem / marketing limit — per-user frequency cap, NOT a bad number. Never suppress on this code.', 3, 300, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),

  ('131000', 'TRANSIENT', 'Something went wrong on WhatsApp''s side. We''ll try again.', 'Meta code 131000: generic error.', 3, 15, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131016', 'TRANSIENT', 'WhatsApp is temporarily unavailable. We''ll try again.', 'Meta code 131016: service unavailable.', 3, 15, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('133004', 'TRANSIENT', 'WhatsApp is temporarily unavailable. We''ll try again.', 'Meta code 133004: server temporarily unavailable.', 3, 15, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131052', 'TRANSIENT', 'We couldn''t process the attached file. We''ll try again.', 'Meta code 131052: media download error.', 3, 15, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131053', 'TRANSIENT', 'We couldn''t process the attached file. We''ll try again.', 'Meta code 131053: media upload error.', 3, 15, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z'),
  ('131057', 'TRANSIENT', 'Your account is in maintenance mode. Sending resumes automatically.', 'Meta code 131057: account in maintenance mode.', 3, 30, TIMESTAMP WITH TIME ZONE '1970-01-01T00:00:00.000Z')
ON CONFLICT (code) DO NOTHING;
