"""The realistic managed-Postgres setup: the migration/table owner is NOT a superuser (it is the database owner with
CREATEROLE). This is what a hosted default role looks like, and what the guard must still refuse at runtime."""
import secrets

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from app.db.connection import OverPrivilegedRole, connect_runtime
from app.db.migrate import migrate
from tests import pg_support


@pytest.fixture
def hosted_style_db():
    base = pg_support.admin_url()
    suffix = secrets.token_hex(4)
    owner, dbname = f"hosted_owner_{suffix}", f"safwan_hosted_{suffix}"
    with psycopg.connect(base, autocommit=True) as admin:
        admin.execute(f"CREATE ROLE {owner} LOGIN PASSWORD 'o' NOSUPERUSER CREATEROLE CREATEDB")
        admin.execute(f'CREATE DATABASE "{dbname}" OWNER {owner}')
    owner_dsn = make_conninfo(base, dbname=dbname, user=owner, password="o")
    try:
        yield owner_dsn, dbname
    finally:
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
            admin.execute(f"DROP ROLE IF EXISTS {owner}")


def test_migrations_run_as_a_non_superuser_owner(hosted_style_db):
    owner_dsn, _ = hosted_style_db
    with psycopg.connect(owner_dsn, autocommit=True) as conn:
        assert conn.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user").fetchone() == (False,)
        assert migrate(conn)[:2] == ["0001", "0002"]


def test_a_non_superuser_owner_dsn_is_refused_in_production_but_allowed_nowhere_else_silently(hosted_style_db):
    owner_dsn, _ = hosted_style_db
    with psycopg.connect(owner_dsn, autocommit=True) as conn:
        migrate(conn)
    with pytest.raises(OverPrivilegedRole):
        connect_runtime(owner_dsn, production=True)
    connect_runtime(owner_dsn, production=False).close()  # dev/test may; production never


def test_a_role_that_merely_inherits_from_the_owner_is_refused(hosted_style_db):
    owner_dsn, dbname = hosted_style_db
    with psycopg.connect(owner_dsn, autocommit=True) as conn:
        migrate(conn)
        owner_name = conn.execute("SELECT current_user").fetchone()[0]
    base = pg_support.admin_url()
    inheritor = "inherits_owner_" + secrets.token_hex(3)
    with psycopg.connect(base, autocommit=True) as admin:
        admin.execute(f"CREATE ROLE {inheritor} LOGIN PASSWORD 'i' IN ROLE {owner_name} INHERIT")
    try:
        with pytest.raises(OverPrivilegedRole):
            connect_runtime(make_conninfo(base, dbname=dbname, user=inheritor, password="i"), production=True)
    finally:
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute(f"DROP ROLE IF EXISTS {inheritor}")


def test_the_intended_runtime_login_is_accepted_and_actually_subject_to_rls(hosted_style_db):
    owner_dsn, dbname = hosted_style_db
    base = pg_support.admin_url()
    with psycopg.connect(owner_dsn, autocommit=True) as conn:
        migrate(conn)
        owner_name = conn.execute("SELECT current_user").fetchone()[0]
    with psycopg.connect(base, autocommit=True) as admin:
        # In a fresh hosted database the owner itself creates safwan_app (migration 0001) and so holds ADMIN on it.
        # This shared test cluster created the role earlier, so grant the same right explicitly.
        admin.execute(f"GRANT safwan_app TO {owner_name} WITH ADMIN OPTION")
    with psycopg.connect(owner_dsn, autocommit=True) as conn:
        login = "runtime_" + secrets.token_hex(3)
        conn.execute(f"CREATE ROLE {login} LOGIN PASSWORD 'r' IN ROLE safwan_app NOSUPERUSER NOBYPASSRLS")
    dsn = make_conninfo(base, dbname=dbname, user=login, password="r")
    runtime = connect_runtime(dsn, production=True)
    try:
        # Real behavioural proof, not just attributes: with no account scope the restricted role sees nothing.
        with psycopg.connect(owner_dsn, autocommit=True) as conn:
            conn.execute("INSERT INTO accounts (display_name) VALUES ('x')")
        assert runtime.execute("SELECT count(*) FROM accounts").fetchone() == (0,)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("INSERT INTO accounts (display_name) VALUES ('y')")
    finally:
        runtime.close()
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute(f"DROP DATABASE IF EXISTS \"{dbname}\" WITH (FORCE)")
            admin.execute(f"DROP ROLE IF EXISTS {login}")


def test_a_preexisting_overprivileged_safwan_app_role_blocks_the_migration(pg_dsn):
    """Migration must refuse (not "fix") a safwan_app role that someone created with excess privileges."""
    base = pg_support.admin_url()
    dbname = "safwan_bad_" + secrets.token_hex(4)
    with psycopg.connect(base, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{dbname}"')
        admin.execute("ALTER ROLE safwan_app CREATEDB")  # temporarily over-privilege the shared (already migrated) role
    try:
        with psycopg.connect(make_conninfo(base, dbname=dbname), autocommit=True) as conn:
            with pytest.raises(psycopg.errors.RaiseException, match="excessive privileges"):
                migrate(conn)
    finally:
        with psycopg.connect(base, autocommit=True) as admin:
            admin.execute("ALTER ROLE safwan_app NOCREATEDB")
            admin.execute(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
