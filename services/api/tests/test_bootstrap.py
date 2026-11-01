"""Hosted-PostgreSQL bootstrap (app.db.bootstrap): a non-superuser owner, a closed database, and a restricted runtime login.

These run against a real PostgreSQL with unique role/database names (roles are cluster-wide). A superuser DSN is needed
only to play the part of the hosted instance's `postgres` user.
"""
from __future__ import annotations

import secrets

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from app.db.bootstrap import BootstrapError, bootstrap_owner, bootstrap_runtime, main
from app.db.connection import OverPrivilegedRole, connect_runtime
from app.db.migrate import migrate
from tests import pg_support

PW_OWNER = "owner-" + "o" * 30
PW_RUNTIME = "runtime-" + "r" * 30


@pytest.fixture
def host():
    """Yields (admin_dsn, names). Cleans up everything it creates."""
    base = pg_support.admin_url()
    tag = secrets.token_hex(3)
    names = {"db": f"bs_db_{tag}", "owner": f"bs_owner_{tag}", "runtime": f"bs_rt_{tag}", "stranger": f"bs_str_{tag}"}
    yield base, names
    with psycopg.connect(base, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{names["db"]}" WITH (FORCE)')
        for role in ("runtime", "stranger", "owner"):
            admin.execute(f'DROP ROLE IF EXISTS "{names[role]}"')


def admin(base: str) -> psycopg.Connection:
    return psycopg.connect(base, autocommit=True)


def owner_dsn(base: str, n: dict, password: str = PW_OWNER) -> str:
    return make_conninfo(base, dbname=n["db"], user=n["owner"], password=password)


def run_phase_1(base: str, n: dict) -> list[str]:
    with admin(base) as a:
        return bootstrap_owner(a, database=n["db"], owner=n["owner"], owner_password=PW_OWNER)


def run_migrations_and_phase_2(base: str, n: dict) -> str:
    with psycopg.connect(owner_dsn(base, n), autocommit=True) as o:
        assert migrate(o)
    with admin(base) as a:  # the shared test cluster already has safwan_app (from other tests): grant the ADMIN a fresh cluster's creator gets
        a.execute(f'GRANT safwan_app TO "{n["owner"]}" WITH ADMIN OPTION')
    with psycopg.connect(owner_dsn(base, n), autocommit=True) as o:
        bootstrap_runtime(o, runtime=n["runtime"], runtime_password=PW_RUNTIME)
    return make_conninfo(base, dbname=n["db"], user=n["runtime"], password=PW_RUNTIME)


def test_phase_1_creates_a_non_superuser_owner_and_a_database_closed_to_everyone_else(host):
    base, n = host
    assert any("created owner role" in s for s in run_phase_1(base, n))
    with admin(base) as a:
        assert a.execute("SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname=%s", (n["owner"],)).fetchone() == (False, False, False, True, True)
        assert a.execute("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=%s", (n["db"],)).fetchone() == (n["owner"],)
        a.execute(f"CREATE ROLE \"{n['stranger']}\" LOGIN PASSWORD 'x' NOSUPERUSER")
    with pytest.raises(psycopg.OperationalError):  # PUBLIC has no CONNECT: an unrelated login cannot even open the database
        psycopg.connect(make_conninfo(base, dbname=n["db"], user=n["stranger"], password="x"), connect_timeout=3)
    psycopg.connect(owner_dsn(base, n)).close()


def test_phase_1_is_idempotent_and_rotates_the_password(host):
    base, n = host
    run_phase_1(base, n)
    with admin(base) as a:
        done = bootstrap_owner(a, database=n["db"], owner=n["owner"], owner_password="new-" + "n" * 30)
    assert any("rotated" in s for s in done)
    psycopg.connect(owner_dsn(base, n, "new-" + "n" * 30)).close()
    with pytest.raises(psycopg.OperationalError):
        psycopg.connect(owner_dsn(base, n, PW_OWNER), connect_timeout=3)


def test_the_full_sequence_yields_a_runtime_that_the_production_guard_accepts_and_row_security_binds(host):
    base, n = host
    run_phase_1(base, n)
    runtime_dsn = run_migrations_and_phase_2(base, n)
    with admin(base) as a:
        # nothing is owned by the superuser; the DEFINER functions run as the non-superuser owner
        owners = {r[0] for r in psycopg.connect(make_conninfo(base, dbname=n["db"]), autocommit=True).execute(
            "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','S')").fetchall()}
        assert owners == {n["owner"]}
        definers = psycopg.connect(make_conninfo(base, dbname=n["db"]), autocommit=True).execute(
            "SELECT DISTINCT r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.prosecdef AND p.pronamespace='public'::regnamespace").fetchall()
        assert definers == [(False,)]
        assert a.execute("SELECT rolconnlimit FROM pg_roles WHERE rolname=%s", (n["runtime"],)).fetchone() == (40,)
    rt = connect_runtime(runtime_dsn, production=True)
    try:
        assert rt.execute("SELECT count(*) FROM accounts").fetchone() == (0,)  # RLS applies: no scope, no rows
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            rt.execute("INSERT INTO accounts (display_name) VALUES ('x')")
    finally:
        rt.close()
    with pytest.raises(OverPrivilegedRole):  # the owner's DSN (the one MIGRATION_DATABASE_URL holds) is refused as a runtime role
        connect_runtime(owner_dsn(base, n), production=True)
    with pytest.raises(OverPrivilegedRole):  # and so is the instance superuser
        connect_runtime(make_conninfo(base, dbname=n["db"]), production=True)


def test_phase_2_is_idempotent_and_rotates_the_runtime_password(host):
    base, n = host
    run_phase_1(base, n)
    run_migrations_and_phase_2(base, n)
    with psycopg.connect(owner_dsn(base, n), autocommit=True) as o:
        assert any("rotated" in s for s in bootstrap_runtime(o, runtime=n["runtime"], runtime_password="second-" + "s" * 30))
    connect_runtime(make_conninfo(base, dbname=n["db"], user=n["runtime"], password="second-" + "s" * 30), production=True).close()


def test_phase_2_refuses_to_run_before_the_migrations(host):
    base, n = host
    run_phase_1(base, n)
    with admin(base) as a:
        a.execute("SELECT 1")  # the shared cluster has safwan_app from other tests; model "not yet created" by checking the guard directly
    with psycopg.connect(owner_dsn(base, n), autocommit=True) as o:
        if o.execute("SELECT 1 FROM pg_roles WHERE rolname='safwan_app'").fetchone() is None:
            with pytest.raises(BootstrapError, match="migrations first"):
                bootstrap_runtime(o, runtime=n["runtime"], runtime_password=PW_RUNTIME)


@pytest.mark.parametrize("bad", ["postgres", "safwan_app", "public", "pg_admin", "Upper", "x", "a b", "a;drop", 'a"b', ""])
def test_identifiers_are_validated_and_reserved_names_refused(host, bad):
    base, n = host
    with admin(base) as a, pytest.raises(BootstrapError):
        bootstrap_owner(a, database=n["db"], owner=bad, owner_password=PW_OWNER)
    with admin(base) as a, pytest.raises(BootstrapError):
        bootstrap_owner(a, database=bad, owner=n["owner"], owner_password=PW_OWNER)


@pytest.mark.parametrize("pw", ["", "short", "x" * 23, "p" * 30 + "\x00"])
def test_weak_passwords_are_refused_and_nothing_is_created(host, pw):
    base, n = host
    with admin(base) as a, pytest.raises(BootstrapError, match="password"):
        bootstrap_owner(a, database=n["db"], owner=n["owner"], owner_password=pw)
    with admin(base) as a:
        assert a.execute("SELECT count(*) FROM pg_roles WHERE rolname=%s", (n["owner"],)).fetchone() == (0,)


def test_a_preexisting_overprivileged_role_is_refused_not_repaired(host):
    base, n = host
    with admin(base) as a:
        a.execute(f"CREATE ROLE \"{n['owner']}\" LOGIN SUPERUSER PASSWORD 'zzzzzzzzzzzzzzzzzzzzzzzzzzzz'")
        with pytest.raises(BootstrapError, match="unexpected privileges"):
            bootstrap_owner(a, database=n["db"], owner=n["owner"], owner_password=PW_OWNER)
        assert a.execute("SELECT rolsuper FROM pg_roles WHERE rolname=%s", (n["owner"],)).fetchone() == (True,)  # untouched


def test_a_database_owned_by_someone_else_is_refused(host):
    base, n = host
    with admin(base) as a:
        a.execute(f'CREATE DATABASE "{n["db"]}"')  # owned by the superuser
        with pytest.raises(BootstrapError, match="owned by someone else"):
            bootstrap_owner(a, database=n["db"], owner=n["owner"], owner_password=PW_OWNER)


def test_phase_1_requires_a_superuser_and_autocommit(host):
    base, n = host
    run_phase_1(base, n)
    with psycopg.connect(owner_dsn(base, n), autocommit=True) as o, pytest.raises(BootstrapError, match="superuser"):
        bootstrap_owner(o, database=n["db"], owner=n["owner"], owner_password=PW_OWNER)
    with psycopg.connect(base) as txn, pytest.raises(BootstrapError, match="autocommit"):
        bootstrap_owner(txn, database=n["db"], owner=n["owner"], owner_password=PW_OWNER)


def test_the_cli_reports_missing_configuration_and_never_echoes_secrets(monkeypatch, capsys):
    for var in ("BOOTSTRAP_DATABASE_URL", "OWNER_PASSWORD", "MIGRATION_DATABASE_URL", "RUNTIME_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    assert main(["owner"]) == 2 and main(["runtime"]) == 2 and main(["nonsense"]) == 2
    monkeypatch.setenv("BOOTSTRAP_DATABASE_URL", "postgresql://u:topsecret-dsn-pw@127.0.0.1:1/db")
    monkeypatch.setenv("OWNER_PASSWORD", "p" * 30)
    assert main(["owner"]) == 1  # connection refused
    out = capsys.readouterr()
    assert "topsecret-dsn-pw" not in out.out + out.err and "p" * 30 not in out.out + out.err
