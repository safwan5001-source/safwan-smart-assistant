-- Phase 5 draft PostgreSQL schema. NOT applied to any environment.
-- IDs are server-assigned. All tenant/user queries must be scoped to authenticated owner.
CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    email_normalized text NOT NULL UNIQUE,
    email_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_active_by_account ON sessions(account_id, expires_at) WHERE revoked_at IS NULL;
CREATE TABLE sync_records (
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('conversation','message','task','attachment')),
    id uuid NOT NULL,
    local_import_id uuid,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    body jsonb NOT NULL DEFAULT '{}'::jsonb,
    deleted_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, kind, id),
    UNIQUE (account_id, kind, local_import_id)
);
CREATE INDEX sync_records_updated ON sync_records(account_id, updated_at);
-- RLS is defense in depth; application MUST SET LOCAL app.account_id
-- inside the same explicit database transaction after verifying its session.
ALTER TABLE sync_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_records FORCE ROW LEVEL SECURITY;
CREATE POLICY account_records ON sync_records
  USING (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
-- Important: enforce equivalent owner-scoping on accounts and sessions
-- via restricted database roles and session service; do not expose raw tables.
-- Deployment prerequisites: backups, reviewed migrations, dedicated restricted
-- app role (no BYPASSRLS), and verified atomic revision conflict handling.
