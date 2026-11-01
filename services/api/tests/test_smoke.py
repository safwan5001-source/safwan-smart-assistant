"""app.db.smoke: it must PASS on a correct database, FAIL on every broken one, expose no user data, and change nothing."""
from __future__ import annotations

import secrets
from contextlib import contextmanager
from uuid import UUID

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from app.auth.sessions import create_session
from app.db import smoke
from app.db.migrate import migrate
from tests import pg_support

A, B = UUID("11111111-1111-4111-8111-111111111111"), UUID("22222222-2222-4222-8222-222222222222")
CANARIES = ("Canary-Name-Alice", "Canary-Name-Bob", "canary-body-value-123", "canary-audit-event")  # must never appear in any output


def seed(owner_dsn: str, runtime_dsn: str) -> list[str]:
    """Real-looking data in every tenant table, including live sessions. Returns the session secrets (also canaries)."""
    with psycopg.connect(owner_dsn, autocommit=True) as o:
        o.execute("INSERT INTO accounts (id, display_name) VALUES (%s, 'Canary-Name-Alice'), (%s, 'Canary-Name-Bob')", (A, B))
        o.execute("INSERT INTO sync_records (account_id, kind, id, body) VALUES (%s,'task',gen_random_uuid(),'{\"k\":\"canary-body-value-123\"}')", (A,))
        o.execute("INSERT INTO sync_records (account_id, kind, id, body) VALUES (%s,'task',gen_random_uuid(),'{\"k\":\"canary-body-value-123\"}')", (B,))
        o.execute("INSERT INTO audit_log (account_id, event) VALUES (%s, 'canary-audit-event')", (A,))
    rt = smoke.connect_runtime(runtime_dsn, production=True)
    try:
        return [create_session(rt, A)[0], create_session(rt, B, remember=True)[0]]
    finally:
        rt.close()


def snapshot(owner_dsn: str) -> dict[str, str]:
    """A fingerprint of ALL content, sequences included: equal before and after means the smoke changed nothing."""
    out: dict[str, str] = {}
    with psycopg.connect(owner_dsn, autocommit=True) as o:
        for t in smoke.EXPECTED_TABLE_PRIVILEGES:
            out[t] = str(o.execute(f"SELECT count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM {t} x").fetchone())
        out["sequences"] = str(o.execute("SELECT sequencename, last_value FROM pg_sequences WHERE schemaname='public' ORDER BY 1").fetchall())
    return out


@contextmanager
def scratch(migrated: bool = True):
    """A throwaway database + its own restricted login, so a test may break the schema on purpose."""
    base = pg_support.admin_url()
    gen = pg_support.fresh_database(base)
    owner_dsn = next(gen)
    login, pw = "smk_" + secrets.token_hex(4), "smoke-" + secrets.token_hex(12)
    try:
        if migrated:
            with psycopg.connect(owner_dsn, autocommit=True) as o:
                migrate(o)
            with psycopg.connect(owner_dsn, autocommit=True) as o:
                o.execute(f"CREATE ROLE {login} LOGIN PASSWORD '{pw}' IN ROLE safwan_app NOSUPERUSER NOBYPASSRLS")
        yield owner_dsn, make_conninfo(owner_dsn, user=login, password=pw), pw
    finally:
        next(gen, None)  # drops the database first: a role cannot be dropped while it still has privileges inside one
        with psycopg.connect(base, autocommit=True) as a:
            a.execute(f"DROP ROLE IF EXISTS {login}")


def run_smoke(monkeypatch, capsys, **env) -> tuple[int, str]:
    for var in ("APP_DATABASE_URL", "MIGRATION_DATABASE_URL", "BOOTSTRAP_DATABASE_URL", "DATABASE_URL", "SMOKE_REQUIRE_SSL"):
        monkeypatch.delenv(var, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    code = smoke.main()
    out = capsys.readouterr()
    return code, out.out + out.err


# ── it passes on a correct, populated database ─────────────────────────────────────────────────────────────────────
def test_passes_on_a_correct_database_and_exposes_no_user_data(monkeypatch, capsys):
    with scratch() as (owner_dsn, runtime_dsn, pw):
        secrets_ = seed(owner_dsn, runtime_dsn)
        code, out = run_smoke(monkeypatch, capsys, APP_DATABASE_URL=runtime_dsn, MIGRATION_DATABASE_URL=owner_dsn)
    assert code == 0 and "SMOKE PASSED" in out and "FAIL" not in out
    assert out.count("PASS  ") >= 11
    for canary in (*CANARIES, *secrets_, pw, str(A), str(B)):  # names, record bodies, session secrets, password, account ids
        assert canary not in out, f"output leaked {canary[:12]}…"
    assert "postgresql://" not in out and "password" not in out.lower()
    # Only these kinds of lines exist: INFO (version / TLS), PASS, FAIL, blank, and the final verdict.
    assert all(l.split("  ")[0] in ("INFO", "PASS", "FAIL") or l.startswith("SMOKE") or not l for l in out.splitlines())


def test_changes_nothing_and_is_repeatable(monkeypatch, capsys):
    with scratch() as (owner_dsn, runtime_dsn, _):
        seed(owner_dsn, runtime_dsn)
        before = snapshot(owner_dsn)
        results = [run_smoke(monkeypatch, capsys, APP_DATABASE_URL=runtime_dsn, MIGRATION_DATABASE_URL=owner_dsn) for _ in range(3)]
        after = snapshot(owner_dsn)
    assert before == after  # rows, content hashes AND sequence values (an aborted insert would have advanced one)
    assert [r[0] for r in results] == [0, 0, 0] and results[0][1] == results[1][1] == results[2][1]


def test_runs_on_an_empty_database_too(monkeypatch, capsys):
    with scratch() as (owner_dsn, runtime_dsn, _):
        code, out = run_smoke(monkeypatch, capsys, APP_DATABASE_URL=runtime_dsn, MIGRATION_DATABASE_URL=owner_dsn)
    assert code == 0, out


def test_the_owner_connection_it_uses_is_read_only(monkeypatch, capsys):
    """Even with owner credentials in the environment, smoke cannot write through them."""
    with scratch() as (owner_dsn, runtime_dsn, _):
        with psycopg.connect(owner_dsn, autocommit=True, options="-c default_transaction_read_only=on") as c:
            with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
                c.execute("INSERT INTO accounts (display_name) VALUES ('x')")
        assert run_smoke(monkeypatch, capsys, APP_DATABASE_URL=runtime_dsn, MIGRATION_DATABASE_URL=owner_dsn)[0] == 0


# ── it FAILS on every way the database can be wrong ────────────────────────────────────────────────────────────────
def broken(monkeypatch, capsys, mutate: str, expect_fragment: str, **extra) -> None:
    with scratch() as (owner_dsn, runtime_dsn, _):
        with psycopg.connect(owner_dsn, autocommit=True) as o:
            o.execute(mutate)
        code, out = run_smoke(monkeypatch, capsys, APP_DATABASE_URL=runtime_dsn, MIGRATION_DATABASE_URL=owner_dsn, **extra)
    assert code == 1, out
    failing = [l for l in out.splitlines() if l.startswith("FAIL")]
    assert any(expect_fragment in l for l in failing), out


def test_fails_when_row_level_security_is_switched_off(monkeypatch, capsys):
    broken(monkeypatch, capsys, "ALTER TABLE sync_records DISABLE ROW LEVEL SECURITY", "row-level security")


def test_fails_when_a_policy_stops_filtering_by_account(monkeypatch, capsys):
    broken(monkeypatch, capsys, "DROP POLICY sync_records_owner ON sync_records; "
           "CREATE POLICY sync_records_owner ON sync_records FOR ALL TO safwan_app USING (true) WITH CHECK (true)", "bound to the account scope")


def test_fails_when_the_runtime_role_gains_a_privilege(monkeypatch, capsys):
    broken(monkeypatch, capsys, "GRANT DELETE ON sync_records TO safwan_app", "least-privilege")


def test_fails_when_the_runtime_role_can_reach_the_nonce_table(monkeypatch, capsys):
    broken(monkeypatch, capsys, "GRANT SELECT ON service_nonces TO safwan_app", "least-privilege")


def test_fails_when_a_migration_is_missing(monkeypatch, capsys):
    broken(monkeypatch, capsys, "DELETE FROM schema_migrations WHERE version = '0003'", "every migration")


def test_fails_when_an_applied_migration_was_modified(monkeypatch, capsys):
    broken(monkeypatch, capsys, "UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '0001'", "every migration")


def test_fails_when_force_rls_is_removed_from_tenant_data(monkeypatch, capsys):
    broken(monkeypatch, capsys, "ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY", "flags")


def test_fails_when_an_unreviewed_table_appears(monkeypatch, capsys):
    broken(monkeypatch, capsys, "CREATE TABLE sneaky (x int)", "least-privilege")


def test_fails_when_tls_is_required_but_the_connection_is_not_encrypted(monkeypatch, capsys):
    with scratch() as (owner_dsn, runtime_dsn, _):
        plain = make_conninfo(runtime_dsn, sslmode="disable")  # deterministic: independent of how the test cluster is configured
        code, out = run_smoke(monkeypatch, capsys, APP_DATABASE_URL=plain, SMOKE_REQUIRE_SSL="1")
    assert "TLS on this connection: off" in out and code == 1 and "FAIL  the connection is encrypted" in out


def test_passes_the_tls_requirement_when_the_connection_is_encrypted(monkeypatch, capsys):
    with scratch() as (owner_dsn, runtime_dsn, _):
        with psycopg.connect(owner_dsn) as c:
            if c.execute("SHOW ssl").fetchone()[0] != "on":
                pytest.skip("this test cluster has TLS disabled")
        code, out = run_smoke(monkeypatch, capsys, APP_DATABASE_URL=make_conninfo(runtime_dsn, sslmode="require"), SMOKE_REQUIRE_SSL="1")
    assert code == 0 and "TLS on this connection: on" in out and "PASS  the connection is encrypted" in out


def test_fails_when_the_runtime_url_is_an_over_privileged_role(monkeypatch, capsys):
    with scratch() as (owner_dsn, runtime_dsn, _):
        code, out = run_smoke(monkeypatch, capsys, APP_DATABASE_URL=owner_dsn)  # superuser stands in for a misconfigured URL
    assert code == 1 and "FAIL  runtime login is accepted" in out and "SMOKE FAILED" in out


def test_owner_and_superuser_logins_are_refused_as_runtime_roles(monkeypatch, capsys):
    with scratch() as (owner_dsn, runtime_dsn, _):
        code, out = run_smoke(monkeypatch, capsys, APP_DATABASE_URL=runtime_dsn, MIGRATION_DATABASE_URL=owner_dsn, BOOTSTRAP_DATABASE_URL=owner_dsn)
    assert code == 0
    assert "PASS  the migration-owner login is refused" in out and "PASS  the instance superuser is refused" in out


# ── configuration and secrecy ──────────────────────────────────────────────────────────────────────────────────────
def test_requires_the_runtime_url_and_ignores_database_url(monkeypatch, capsys):
    code, out = run_smoke(monkeypatch, capsys, DATABASE_URL="postgresql://postgres:topsecret-super@127.0.0.1:1/x")
    assert code == 2 and "APP_DATABASE_URL is required" in out and "topsecret-super" not in out


def test_a_wrong_password_fails_without_echoing_any_credential(monkeypatch, capsys):
    with scratch() as (owner_dsn, runtime_dsn, pw):
        bad = make_conninfo(runtime_dsn, password="definitely-wrong-password-123")
        code, out = run_smoke(monkeypatch, capsys, APP_DATABASE_URL=bad)
    assert code == 1 and "FAIL  runtime login is accepted" in out
    assert "definitely-wrong-password-123" not in out and pw not in out and "password" not in out.lower()
    assert "[DatabaseUnavailable]" in out  # only the exception CLASS is shown
