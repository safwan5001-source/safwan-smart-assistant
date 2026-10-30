-- Phase 5 consolidated PREVIEW DRAFT. NOT automatically executed.
-- Requires reviewed migrations and restricted runtime DB role.
BEGIN;
CREATE TABLE accounts (
 id uuid PRIMARY KEY,
 email_normalized text NOT NULL UNIQUE,
 display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 100),
 email_verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_active_by_account ON sessions(account_id,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE email_verification_tokens (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_by_account ON email_verification_tokens(account_id,expires_at);
CREATE TABLE sync_records (
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('conversation','message','task','attachment')),
 id uuid NOT NULL,
 local_import_id uuid,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
 body jsonb NOT NULL DEFAULT '{}'::jsonb,
 deleted_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (account_id,kind,id),
 UNIQUE (account_id,kind,local_import_id)
);
CREATE INDEX sync_records_updated ON sync_records(account_id,updated_at);
ALTER TABLE sync_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_records FORCE ROW LEVEL SECURITY;
CREATE POLICY account_records ON sync_records
 USING (account_id=nullif(current_setting('app.account_id',true),'')::uuid)
 WITH CHECK (account_id=nullif(current_setting('app.account_id',true),'')::uuid);
COMMIT;
-- Do NOT execute with a runtime owner/superuser role; establish privileges
-- and verify RLS using a dedicated non-BYPASSRLS role before activation.
