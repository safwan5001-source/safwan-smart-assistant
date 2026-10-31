-- 0002_tenant_data: first account-owned tables. FORCE ROW LEVEL SECURITY means even the table
-- owner is subject to the policies (superusers still bypass: never run the app as one).

CREATE TABLE sync_records (
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('conversation', 'message', 'task', 'attachment')),
  id              uuid NOT NULL,
  local_import_id uuid,
  revision        bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  body            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(body) <= 262144),
  deleted_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind, id),
  UNIQUE (account_id, kind, local_import_id)
);
CREATE INDEX sync_records_updated ON sync_records (account_id, updated_at);
ALTER TABLE sync_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_records FORCE ROW LEVEL SECURITY;
CREATE POLICY sync_records_owner ON sync_records FOR ALL TO safwan_app
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, UPDATE ON sync_records TO safwan_app;  -- no DELETE: removal is a tombstone (deleted_at)

-- Append-only from the application's point of view: it can write and read its own trail, never edit it.
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event      text NOT NULL CHECK (length(event) BETWEEN 1 AND 100),
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(detail) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_by_account ON audit_log (account_id, created_at);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_read ON audit_log FOR SELECT TO safwan_app USING (account_id = app_account_id());
CREATE POLICY audit_log_write ON audit_log FOR INSERT TO safwan_app WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT ON audit_log TO safwan_app;
