"""Real-PostgreSQL test support.

CI sets SAFWAN_TEST_DATABASE_URL (a superuser DSN of a disposable postgres:16 service) and REQUIRE_POSTGRES=1,
so a missing database is a FAILURE there, never a silent skip. Locally the tests skip unless a DSN is provided.
Each session gets its own freshly-migrated database; the application role is exercised via `SET ROLE safwan_app`
(NOSUPERUSER, NOBYPASSRLS) because superusers bypass RLS and would make isolation tests meaningless.
"""
from __future__ import annotations

import os
import secrets
from collections.abc import Iterator
from uuid import UUID

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from app.db.migrate import migrate

ACCOUNT_A = UUID("11111111-1111-4111-8111-111111111111")
ACCOUNT_B = UUID("22222222-2222-4222-8222-222222222222")


def admin_url() -> str:
    url = os.environ.get("SAFWAN_TEST_DATABASE_URL")
    if url:
        return url
    if os.environ.get("REQUIRE_POSTGRES") == "1":
        pytest.fail("REQUIRE_POSTGRES=1 but SAFWAN_TEST_DATABASE_URL is not set")
    pytest.skip("PostgreSQL not configured (set SAFWAN_TEST_DATABASE_URL)")


def fresh_database(base_url: str) -> Iterator[str]:
    name = "safwan_test_" + secrets.token_hex(6)
    with psycopg.connect(base_url, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    dsn = make_conninfo(base_url, dbname=name)
    try:
        yield dsn
    finally:
        with psycopg.connect(base_url, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def migrated_conn(dsn: str) -> psycopg.Connection:
    conn = psycopg.connect(dsn, autocommit=True)
    migrate(conn)
    return conn


def runtime_connection(dsn: str) -> psycopg.Connection:
    """A connection that behaves like production: acting as safwan_app, never as a superuser."""
    conn = psycopg.connect(dsn, autocommit=True)
    conn.execute("SET ROLE safwan_app")
    row = conn.execute("SELECT current_user, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)").fetchone()
    assert row == ("safwan_app", False), "tests must run as the restricted application role"
    return conn


def make_account(owner: psycopg.Connection, account_id: UUID, name: str = "Test") -> None:
    owner.execute("INSERT INTO accounts (id, display_name) VALUES (%s, %s)", (account_id, name))
