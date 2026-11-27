-- 0005_owner_auth (A1): one owner session for the whole app, opened by the owner code or by a passkey (Face ID).
-- Additive only: no existing table, policy or function changes. Nothing here is used until OWNER_ACCESS_CODE is set on the API.

-- Passkeys (WebAuthn credentials) of an account. The public key is public material; the private key never leaves the device.
CREATE TABLE passkeys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE CHECK (octet_length(credential_id) BETWEEN 16 AND 1023),
  public_key    bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 16 AND 2048),
  sign_count    bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX passkeys_by_account ON passkeys (account_id);
-- RLS like `sessions` (enabled, not FORCEd): its only cross-scope reader is the SECURITY DEFINER lookup below, which runs as the
-- owner and would see nothing under FORCE. The runtime role always goes through the policy.
ALTER TABLE passkeys ENABLE ROW LEVEL SECURITY;
CREATE POLICY passkeys_owner ON passkeys FOR ALL TO safwan_app
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, DELETE ON passkeys TO safwan_app;  -- counters move only through auth_passkey_used (below)

-- The owner account of this single-owner app. Called ONLY after the API verified the owner code (app/auth/owner.py).
-- Creates the account once if the database has none; never resurrects a disabled owner; serialised by an advisory lock.
-- Hardening (see 0001 and 0003): search_path is exactly pg_catalog, pg_temp; every relation is schema-qualified.
CREATE FUNCTION auth_ensure_owner() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  owner_id uuid;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(7710051);
  SELECT a.id INTO owner_id FROM public.accounts a WHERE a.disabled_at IS NULL ORDER BY a.created_at, a.id LIMIT 1;
  IF owner_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.accounts) THEN
      RETURN NULL;  -- every account is disabled: the owner was locked out on purpose
    END IF;
    INSERT INTO public.accounts (display_name) VALUES ('المالك') RETURNING id INTO owner_id;
  END IF;
  RETURN owner_id;
END
$$;
REVOKE ALL ON FUNCTION auth_ensure_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_ensure_owner() TO safwan_app;

-- Pre-authentication passkey lookup (the caller does not know the account yet): public key + counter of an ACTIVE account only.
CREATE FUNCTION auth_passkey_lookup(p_credential_id bytea) RETURNS TABLE (account_id uuid, public_key bytea, sign_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p.account_id, p.public_key, p.sign_count
    FROM public.passkeys p JOIN public.accounts a ON a.id = p.account_id
   WHERE p.credential_id = p_credential_id
     AND a.disabled_at IS NULL
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION auth_passkey_lookup(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_passkey_lookup(bytea) TO safwan_app;

-- After a VERIFIED assertion: record use and move the signature counter forward only (never backwards).
CREATE FUNCTION auth_passkey_used(p_credential_id bytea, p_sign_count bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_sign_count IS NULL OR p_sign_count < 0 THEN
    RAISE EXCEPTION 'invalid sign count';
  END IF;
  UPDATE public.passkeys
     SET sign_count = GREATEST(sign_count, p_sign_count), last_used_at = now()
   WHERE credential_id = p_credential_id;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION auth_passkey_used(bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_passkey_used(bytea, bigint) TO safwan_app;
