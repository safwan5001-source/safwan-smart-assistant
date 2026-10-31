"""SECURITY DEFINER functions must not be hijackable through the temporary schema.

PostgreSQL searches pg_temp FIRST for relations unless it is listed explicitly later in search_path. A runtime login has
the default TEMP privilege, so without hardening it could create temporary tables named like ours and make a function that
runs with the OWNER's privileges read or write them instead of the real tables.
"""
import hashlib

import pytest

from app.auth import create_session
from tests.pg_support import ACCOUNT_A, ACCOUNT_B, make_account


def test_a_temporary_table_cannot_forge_a_session_lookup(pg_app, pg_owner):
    make_account(pg_owner, ACCOUNT_A, "A")
    make_account(pg_owner, ACCOUNT_B, "victim")
    forged = hashlib.sha256(b"attacker-chosen-secret").digest()
    pg_app.execute("CREATE TEMP TABLE accounts (id uuid, disabled_at timestamptz)")
    pg_app.execute("CREATE TEMP TABLE sessions (account_id uuid, token_hash bytea, revoked_at timestamptz, expires_at timestamptz)")
    pg_app.execute("INSERT INTO pg_temp.accounts VALUES (%s, NULL)", (ACCOUNT_B,))
    pg_app.execute("INSERT INTO pg_temp.sessions VALUES (%s, %s, NULL, now() + interval '1 day')", (ACCOUNT_B, forged))
    assert pg_app.execute("SELECT auth_resolve_session(%s)", (forged,)).fetchone()[0] is None


def test_a_temporary_nonce_table_cannot_capture_or_bypass_replay_protection(pg_app, pg_owner):
    pg_app.execute("CREATE TEMP TABLE service_nonces (nonce_hash bytea PRIMARY KEY, expires_at timestamptz)")
    h = hashlib.sha256(b"n").digest()
    assert pg_app.execute("SELECT auth_claim_nonce(%s, 180)", (h,)).fetchone()[0] is True
    assert pg_app.execute("SELECT count(*) FROM pg_temp.service_nonces").fetchone()[0] == 0, "claim leaked into the attacker's table"
    assert pg_owner.execute("SELECT count(*) FROM public.service_nonces").fetchone()[0] == 1  # the real table recorded it
    assert pg_app.execute("SELECT auth_claim_nonce(%s, 180)", (h,)).fetchone()[0] is False  # and replay is still refused


def test_a_temporary_trigger_cannot_run_with_owner_privileges(pg_app, pg_owner):
    """The worst case: a trigger on a shadow table executing as the definer."""
    pg_app.execute("CREATE TEMP TABLE service_nonces (nonce_hash bytea PRIMARY KEY, expires_at timestamptz)")
    # A function the attacker can create can only run as the attacker; if the definer function touched this table, the
    # trigger would fire with owner rights. Observable effect: record who the trigger ran as.
    pg_app.execute("CREATE TEMP TABLE who (u text)")
    pg_app.execute("CREATE FUNCTION pg_temp.spy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO pg_temp.who VALUES (current_user); RETURN NEW; END $$")
    pg_app.execute("CREATE TRIGGER t BEFORE INSERT ON pg_temp.service_nonces FOR EACH ROW EXECUTE FUNCTION pg_temp.spy()")
    pg_app.execute("SELECT auth_claim_nonce(%s, 180)", (hashlib.sha256(b"x").digest(),))
    assert pg_app.execute("SELECT count(*) FROM pg_temp.who").fetchone()[0] == 0


def test_every_definer_function_pins_a_safe_search_path_with_pg_temp_last(pg_owner):
    rows = pg_owner.execute(
        "SELECT proname, proconfig FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace ORDER BY 1"
    ).fetchall()
    assert [r[0] for r in rows] == ["auth_claim_nonce", "auth_resolve_session"]
    for name, cfg in rows:
        paths = [c for c in (cfg or []) if c.startswith("search_path=")]
        assert paths, name
        parts = [p.strip() for p in paths[0].split("=", 1)[1].split(",")]
        assert parts[0] == "pg_catalog" and parts[-1] == "pg_temp" and parts.count("pg_temp") == 1, f"{name}: {parts}"


def test_definer_bodies_reference_only_schema_qualified_relations(pg_owner):
    for name in ("auth_claim_nonce", "auth_resolve_session"):
        body = pg_owner.execute("SELECT prosrc FROM pg_proc WHERE proname = %s", (name,)).fetchone()[0].lower()
        import re

        for rel in ("sessions", "accounts", "service_nonces"):
            for m in re.finditer(rf"\b(from|join|into|update|delete\s+from)\s+(\S+)", body):
                if m.group(2).strip("(,;") == rel:
                    pytest.fail(f"{name} references {rel} without a schema qualifier")
