-- 0003_hardening: findings from the second security review of B1 (2026-10-31). Applied after 0001/0002 so no applied
-- migration is edited. See docs/B1-SECURITY-REVIEW.md §5.
--
-- 1. SECURITY DEFINER functions: `public` leaves the search_path and every callable is schema-qualified.
--    With `public` on the path, a function `public.make_interval(secs integer)` shadows `pg_catalog.make_interval(secs double
--    precision)` for an integer argument (exact-type match beats path order) and would run with the owner's privileges.
--    The runtime role has no CREATE on `public` on PostgreSQL 15+, but 14 and earlier grant it to PUBLIC, and a later
--    GRANT would silently re-open the hole. Both are closed: no `public` on the path, and CREATE revoked below.
-- 2. Session revocation is irreversible (a compromised scoped runtime could otherwise set revoked_at back to NULL).
-- 3. CREATE on schema public is not available to PUBLIC or to the application role.

CREATE OR REPLACE FUNCTION auth_resolve_session(p_token_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.account_id
    FROM public.sessions s JOIN public.accounts a ON a.id = s.account_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > pg_catalog.now()          -- one clock: the database's
     AND a.disabled_at IS NULL
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION auth_resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_session(bytea) TO safwan_app;

CREATE OR REPLACE FUNCTION auth_claim_nonce(p_nonce_hash bytea, p_ttl_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  claimed integer;
BEGIN
  IF p_nonce_hash IS NULL OR pg_catalog.octet_length(p_nonce_hash) <> 32 THEN
    RAISE EXCEPTION 'invalid nonce hash';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid ttl';
  END IF;
  DELETE FROM public.service_nonces WHERE nonce_hash = p_nonce_hash AND expires_at <= pg_catalog.now();
  DELETE FROM public.service_nonces
   WHERE nonce_hash IN (SELECT nonce_hash FROM public.service_nonces WHERE expires_at <= pg_catalog.now() LIMIT 100);  -- bounded housekeeping
  INSERT INTO public.service_nonces (nonce_hash, expires_at)
  VALUES (p_nonce_hash, pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_seconds::double precision))
  ON CONFLICT (nonce_hash) DO NOTHING;
  GET DIAGNOSTICS claimed = ROW_COUNT;
  RETURN claimed = 1;
END
$$;
REVOKE ALL ON FUNCTION auth_claim_nonce(bytea, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_claim_nonce(bytea, integer) TO safwan_app;

-- Revocation can only move NULL -> a timestamp. Any later change of revoked_at (including back to NULL) is refused for every
-- role, the table owner included. Updating last_seen_at on a revoked session stays possible (revoked_at is unchanged).
CREATE FUNCTION sessions_revocation_is_irreversible() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'session revocation is irreversible' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION sessions_revocation_is_irreversible() FROM PUBLIC;
CREATE TRIGGER sessions_revocation_is_irreversible
  BEFORE UPDATE OF revoked_at ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_revocation_is_irreversible();

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM safwan_app;
