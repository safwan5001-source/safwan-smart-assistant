-- 0004_ai_chat: durable Claude chat controls. Conversations/messages reuse sync_records (kinds 'conversation' / 'message').
-- Everything here is account-scoped by FORCE ROW LEVEL SECURITY, like 0002.

CREATE TABLE ai_settings (
  account_id    uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  default_model text NOT NULL CHECK (length(default_model) BETWEEN 1 AND 100),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_settings_owner ON ai_settings FOR ALL TO safwan_app
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, UPDATE ON ai_settings TO safwan_app;

-- Hard spend ledger, shared by every API instance. Amounts are micro-USD (1e-6 USD) so there is no float drift.
-- `reserved` is taken BEFORE the provider is called (worst case: whole context + max output) and settled afterwards,
-- so concurrent requests can never jointly exceed the cap. A crash between reserve and settle leaves the reservation in place
-- (the budget errs on the safe side).
CREATE TABLE ai_usage (
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period         text NOT NULL CHECK (period ~ '^(day:[0-9]{4}-[0-9]{2}-[0-9]{2}|month:[0-9]{4}-[0-9]{2})$'),
  reserved_micro bigint NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0),
  spent_micro    bigint NOT NULL DEFAULT 0 CHECK (spent_micro >= 0),
  requests       integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  input_tokens   bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens  bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, period)
);
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_usage_owner ON ai_usage FOR ALL TO safwan_app
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, UPDATE ON ai_usage TO safwan_app;

-- Per-minute request counter (shared across instances).
CREATE TABLE ai_rate (
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (account_id, window_start)
);
ALTER TABLE ai_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_rate FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_rate_owner ON ai_rate FOR ALL TO safwan_app
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, UPDATE ON ai_rate TO safwan_app;

-- Fast "messages of one conversation, in order".
CREATE INDEX sync_records_ai_messages ON sync_records (account_id, (body->>'conversation_id'), ((body->>'seq')::int))
  WHERE kind = 'message';
