-- 0001_core: runtime role, accounts, sessions, service-to-service nonce store.
-- Applied by the MIGRATION role (table owner). The application connects as a member of
-- safwan_app, which is NOSUPERUSER + NOBYPASSRLS, so row-level security always applies to it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'safwan_app') THEN
    CREATE ROLE safwan_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
-- Never ALTER the role's attributes: a non-superuser owner (e.g. a managed-Postgres default owner) is not allowed to,
-- and silently "fixing" a pre-existing over-privileged role is the wrong behaviour anyway. Verify instead, and refuse.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'safwan_app'
               AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolcanlogin OR rolreplication)) THEN
    RAISE EXCEPTION 'role safwan_app exists with excessive privileges; refusing to continue';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO safwan_app;

-- Transaction-local account scope. NULL (no rows) when unset, empty or the nil UUID;
-- a malformed value raises, which fails the statement closed.
CREATE FUNCTION app_account_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN nullif(current_setting('app.account_id', true), '') IS NULL THEN NULL
           WHEN current_setting('app.account_id', true)::uuid = '00000000-0000-0000-0000-000000000000'::uuid THEN NULL
           ELSE current_setting('app.account_id', true)::uuid
         END
$$;
GRANT EXECUTE ON FUNCTION app_account_id() TO safwan_app;

CREATE TABLE accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz
);
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_self ON accounts FOR SELECT TO safwan_app USING (id = app_account_id());
GRANT SELECT ON accounts TO safwan_app;  -- accounts are created by a reviewed bootstrap path (B2), never by request code

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),  -- SHA-256 of the secret; the secret is never stored
  remember     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_seen_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '31 days')
);
CREATE INDEX sessions_active_by_account ON sessions (account_id, expires_at) WHERE revoked_at IS NULL;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_owner ON sessions FOR ALL TO safwan_app
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT ON sessions TO safwan_app;
GRANT UPDATE (revoked_at, last_seen_at) ON sessions TO safwan_app;  -- nothing else on a session row is mutable

-- Pre-authentication lookup: the caller does not know the account yet, so this is the single
-- SECURITY DEFINER entry point. It answers only "which active account owns this token hash?".
-- Hardening for every SECURITY DEFINER function here: pg_temp is listed EXPLICITLY and LAST (otherwise PostgreSQL searches
-- the temporary schema first for relations, and a runtime login with the default TEMP privilege could shadow our tables),
-- and every relation is schema-qualified as defence in depth.
CREATE FUNCTION auth_resolve_session(p_token_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT s.account_id
    FROM public.sessions s JOIN public.accounts a ON a.id = s.account_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()          -- one clock: the database's
     AND a.disabled_at IS NULL
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION auth_resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_session(bytea) TO safwan_app;

-- Replay protection for signed BFF -> API calls. The runtime role has no table access at all.
CREATE TABLE service_nonces (
  nonce_hash bytea PRIMARY KEY CHECK (octet_length(nonce_hash) = 32),
  expires_at timestamptz NOT NULL
);
CREATE INDEX service_nonces_expiry ON service_nonces (expires_at);
REVOKE ALL ON service_nonces FROM PUBLIC;

CREATE FUNCTION auth_claim_nonce(p_nonce_hash bytea, p_ttl_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  claimed integer;
BEGIN
  IF p_nonce_hash IS NULL OR octet_length(p_nonce_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid nonce hash';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid ttl';
  END IF;
  DELETE FROM public.service_nonces WHERE nonce_hash = p_nonce_hash AND expires_at <= now();
  DELETE FROM public.service_nonces
   WHERE nonce_hash IN (SELECT nonce_hash FROM public.service_nonces WHERE expires_at <= now() LIMIT 100);  -- bounded housekeeping
  INSERT INTO public.service_nonces (nonce_hash, expires_at)
  VALUES (p_nonce_hash, now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (nonce_hash) DO NOTHING;
  GET DIAGNOSTICS claimed = ROW_COUNT;
  RETURN claimed = 1;
END
$$;
REVOKE ALL ON FUNCTION auth_claim_nonce(bytea, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_claim_nonce(bytea, integer) TO safwan_app;
