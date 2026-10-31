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


_PRIVILEGE_CHECK = """
SELECT r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
       -- owner of (or inheriting from the owner of) any application relation: owners bypass RLS unless FORCEd,
       -- and can alter tables/policies. This is the usual managed-Postgres default role.
       OR EXISTS (SELECT 1 FROM pg_class c
                   WHERE c.relnamespace = 'public'::regnamespace
                     AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
                     AND pg_has_role(current_user, c.relowner, 'USAGE'))
  FROM pg_roles r WHERE r.rolname = current_user
"""


def connect_runtime(url: str | None, *, production: bool, application_name: str = "safwan-api", timeout: int = 5) -> psycopg.Connection:
    """Connect as the application role. In production a role that could bypass or rewrite row-level security is refused
    outright (superuser, BYPASSRLS, CREATEROLE/CREATEDB/REPLICATION, or owner of application tables, directly or by
    inheritance): RLS would silently not apply, which is the failure this whole design exists to prevent."""
    conn = connect(url, application_name=application_name, timeout=timeout)
    if production:
        row = conn.execute(_PRIVILEGE_CHECK).fetchone()
        if row is None or row[0] is not False:
            conn.close()
            raise OverPrivilegedRole("runtime database role is over-privileged")
    return conn
