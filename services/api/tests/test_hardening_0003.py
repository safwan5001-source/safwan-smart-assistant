"""Regression tests for migration 0003 (second security review): definer search_path, irreversible revocation, schema CREATE."""
import hashlib
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from app.auth import create_session, revoke_session
from app.db.scope import owner_transaction
from tests.pg_support import ACCOUNT_A, make_account


# ── search_path of the SECURITY DEFINER functions ────────────────────────────────────────────────────────────────────────
def test_definer_search_path_is_exactly_pg_catalog_then_pg_temp(pg_owner):
    rows = pg_owner.execute("SELECT proname, proconfig FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace ORDER BY 1").fetchall()
    assert [r[0] for r in rows] == ["auth_claim_nonce", "auth_ensure_owner", "auth_passkey_lookup", "auth_passkey_used", "auth_resolve_session"]
    for name, cfg in rows:
        assert cfg == ["search_path=pg_catalog, pg_temp"], f"{name}: {cfg}"  # `public` is not searched


def test_a_shadow_make_interval_in_public_cannot_hijack_the_nonce_ttl(pg_app, pg_owner):
    """Mechanism of the finding: public.make_interval(secs integer) wins over pg_catalog.make_interval(secs double precision) for an
    integer argument when `public` is on the path. The owner creates it here to simulate a mis-granted CREATE on public."""
    pg_owner.execute("CREATE FUNCTION public.make_interval(secs integer) RETURNS interval LANGUAGE sql AS $$ SELECT interval '99 years' $$")
    try:
        h = hashlib.sha256(b"shadow").digest()
        assert pg_app.execute("SELECT auth_claim_nonce(%s, 180)", (h,)).fetchone()[0] is True
        ttl = pg_owner.execute("SELECT expires_at - now() FROM service_nonces WHERE nonce_hash = %s", (h,)).fetchone()[0]
        assert timedelta(seconds=100) < ttl <= timedelta(seconds=181), f"ttl was {ttl}"
    finally:
        pg_owner.execute("DROP FUNCTION IF EXISTS public.make_interval(integer)")


def test_nobody_but_the_owner_can_create_objects_in_public(pg_owner):
    row = pg_owner.execute("SELECT has_schema_privilege('public', 'public', 'CREATE'), has_schema_privilege('safwan_app', 'public', 'CREATE')").fetchone()
    assert row == (False, False)


def test_the_runtime_role_cannot_create_a_function_in_public(pg_app):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        pg_app.execute("CREATE FUNCTION public.make_interval(secs integer) RETURNS interval LANGUAGE sql AS $$ SELECT interval '1 year' $$")


# ── revoked_at is one-way ────────────────────────────────────────────────────────────────────────────────────────────────
@pytest.fixture
def revoked(pg_app, pg_owner):
    make_account(pg_owner, ACCOUNT_A, "A")
    secret, _ = create_session(pg_app, ACCOUNT_A)
    assert revoke_session(pg_app, ACCOUNT_A, secret) is True
    return secret


def test_the_runtime_role_cannot_un_revoke_a_session(pg_app, revoked):
    with owner_transaction(pg_app, ACCOUNT_A):
        with pytest.raises(psycopg.errors.CheckViolation):
            with pg_app.transaction():
                pg_app.execute("UPDATE sessions SET revoked_at = NULL")
        with pytest.raises(psycopg.errors.CheckViolation):
            with pg_app.transaction():
                pg_app.execute("UPDATE sessions SET revoked_at = now() + interval '5 years'")  # moving it is a change too
    assert pg_app.execute("SELECT auth_resolve_session(%s)", (hashlib.sha256(revoked.encode()).digest(),)).fetchone()[0] is None


def test_even_the_owner_cannot_un_revoke(pg_owner, revoked):
    with pytest.raises(psycopg.errors.CheckViolation):
        pg_owner.execute("UPDATE sessions SET revoked_at = NULL")


def test_revoking_twice_is_a_noop_and_last_seen_still_updates_on_a_revoked_session(pg_app, revoked):
    assert revoke_session(pg_app, ACCOUNT_A, revoked) is False  # already revoked: nothing changes, nothing raises
    with owner_transaction(pg_app, ACCOUNT_A):
        before = pg_app.execute("SELECT revoked_at FROM sessions").fetchone()[0]
        n = pg_app.execute("UPDATE sessions SET last_seen_at = now()").rowcount
        after = pg_app.execute("SELECT revoked_at, last_seen_at FROM sessions").fetchone()
    assert n == 1 and after[0] == before and after[1] is not None


def test_an_active_session_can_still_be_revoked_once(pg_app, pg_owner):
    make_account(pg_owner, ACCOUNT_A, "A")
    secret, _ = create_session(pg_app, ACCOUNT_A)
    assert pg_app.execute("SELECT auth_resolve_session(%s)", (hashlib.sha256(secret.encode()).digest(),)).fetchone()[0] == ACCOUNT_A
    assert revoke_session(pg_app, ACCOUNT_A, secret) is True
    assert pg_app.execute("SELECT auth_resolve_session(%s)", (hashlib.sha256(secret.encode()).digest(),)).fetchone()[0] is None


def test_the_trigger_function_is_not_callable_by_public_and_pins_its_path(pg_owner):
    row = pg_owner.execute(
        "SELECT has_function_privilege('public', 'sessions_revocation_is_irreversible()', 'execute'), proconfig, prosecdef"
        " FROM pg_proc WHERE proname = 'sessions_revocation_is_irreversible'"
    ).fetchone()
    assert row == (False, ["search_path=pg_catalog, pg_temp"], False)
