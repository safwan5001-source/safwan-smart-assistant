"""PostgreSQL connections. The DSN is a secret: it is never logged and never put in an exception message."""
from __future__ import annotations

import psycopg


class DatabaseUnavailable(RuntimeError):
    """Raised instead of leaking driver errors (which may embed connection details)."""


class OverPrivilegedRole(DatabaseUnavailable):
    """The application connected as a role that can bypass row-level security."""


def connect(url: str | None, *, application_name: str = "safwan-api", timeout: int = 5) -> psycopg.Connection:
    """Autocommit connection: callers open explicit transactions (`conn.transaction()`)."""
    if not url:
        raise DatabaseUnavailable("database is not configured")
    try:
        return psycopg.connect(url, autocommit=True, connect_timeout=timeout, application_name=application_name)
    except psycopg.Error:
        raise DatabaseUnavailable("database connection failed") from None


def connect_runtime(url: str | None, *, production: bool, application_name: str = "safwan-api", timeout: int = 5) -> psycopg.Connection:
    """Connect as the application role. In production a superuser / BYPASSRLS role is refused outright:
    RLS would silently not apply, which is the failure this whole design exists to prevent."""
    conn = connect(url, application_name=application_name, timeout=timeout)
    if production:
        row = conn.execute("SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user").fetchone()
        if row is None or row[0] is not False:
            conn.close()
            raise OverPrivilegedRole("runtime database role is over-privileged")
    return conn
