"""One-time, idempotent role/database bootstrap for a HOSTED PostgreSQL (Railway), in two phases around the migrations.

Why this exists: a hosted instance hands you ONE superuser (`postgres`). Running the schema as that role would make it the
owner of every table and of the SECURITY DEFINER functions, and a superuser bypasses row-level security. So:

  phase 1  `python -m app.db.bootstrap owner`    (as the superuser, once)  creates a NON-superuser owner role and an empty
                                                  database owned by it, and closes the database to PUBLIC.
  migrate  `python -m app.db.migrate`            (as that owner)           creates the schema and the restricted `safwan_app` role.
  phase 2  `python -m app.db.bootstrap runtime`  (as the owner)            creates the LOGIN role the API connects as: a mere
                                                  member of `safwan_app` (never owner, never BYPASSRLS), with a connection cap.

Everything is driven by environment variables so no secret appears on a command line, in a file or in this repository, and nothing
secret is ever printed. Re-running a phase is safe (it rotates the password and re-verifies attributes); a pre-existing role with
excess privileges is REFUSED, never silently "fixed".
"""
from __future__ import annotations

import os
import re
import sys

import psycopg
from psycopg import sql

_IDENT = re.compile(r"[a-z][a-z0-9_]{2,40}")
RESERVED = {"postgres", "public", "safwan_app", "template0", "template1"}
MIN_PASSWORD_CHARS = 24
RUNTIME_CONNECTION_LIMIT = 40  # the API opens short-lived connections; a cap keeps a bug from exhausting the whole instance


class BootstrapError(RuntimeError):
    """Messages never contain passwords or connection strings."""


def _ident(value: str, what: str) -> str:
    if not isinstance(value, str) or not _IDENT.fullmatch(value) or value in RESERVED or value.startswith("pg_"):
        raise BootstrapError(f"invalid or reserved {what} name")
    return value


def _password(value: str, what: str) -> str:
    if not isinstance(value, str) or len(value) < MIN_PASSWORD_CHARS or "\x00" in value:
        raise BootstrapError(f"{what} password must be at least {MIN_PASSWORD_CHARS} characters")
    return value


def _role(conn: psycopg.Connection, name: str):
    return conn.execute(
        "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin FROM pg_roles WHERE rolname = %s",
        (name,),
    ).fetchone()


def bootstrap_owner(admin: psycopg.Connection, *, database: str, owner: str, owner_password: str) -> list[str]:
    """Phase 1. `admin` must be an autocommit superuser connection."""
    database, owner, owner_password = _ident(database, "database"), _ident(owner, "owner role"), _password(owner_password, "owner")
    if not admin.autocommit:
        raise BootstrapError("an autocommit connection is required (CREATE DATABASE cannot run in a transaction)")
    me = admin.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user").fetchone()
    if me is None or me[0] is not True:
        raise BootstrapError("phase 1 must run as the instance superuser")
    done: list[str] = []

    existing = _role(admin, owner)
    if existing is None:
        admin.execute(sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE NOREPLICATION PASSWORD {}")
                      .format(sql.Identifier(owner), sql.Literal(owner_password)))
        done.append(f"created owner role {owner}")
    else:
        sup, byp, cdb, crole, repl, login = existing
        if sup or byp or cdb or repl or not login or not crole:
            raise BootstrapError(f"role {owner} exists with unexpected privileges; refusing to continue")
        admin.execute(sql.SQL("ALTER ROLE {} PASSWORD {}").format(sql.Identifier(owner), sql.Literal(owner_password)))
        done.append(f"rotated password of {owner}")

    row = admin.execute("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = %s", (database,)).fetchone()
    if row is None:
        admin.execute(sql.SQL("CREATE DATABASE {} OWNER {}").format(sql.Identifier(database), sql.Identifier(owner)))
        done.append(f"created database {database}")
    elif row[0] != owner:
        raise BootstrapError(f"database {database} exists but is owned by someone else; refusing to continue")
    # Closed to everyone by default; the runtime role is let in explicitly in phase 2.
    admin.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(database)))
    admin.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(database), sql.Identifier(owner)))
    done.append(f"database {database} closed to PUBLIC")
    return done


def bootstrap_runtime(owner_conn: psycopg.Connection, *, runtime: str, runtime_password: str) -> list[str]:
    """Phase 2. `owner_conn` is an autocommit connection to the application database AS THE OWNER, after the migrations ran."""
    runtime, runtime_password = _ident(runtime, "runtime role"), _password(runtime_password, "runtime")
    if not owner_conn.autocommit:
        raise BootstrapError("an autocommit connection is required")
    if _role(owner_conn, "safwan_app") is None:
        raise BootstrapError("role safwan_app does not exist: run the migrations first")
    done: list[str] = []
    existing = _role(owner_conn, runtime)
    if existing is None:
        owner_conn.execute(sql.SQL(
            "CREATE ROLE {} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT {} "
            "IN ROLE safwan_app PASSWORD {}").format(sql.Identifier(runtime), sql.Literal(RUNTIME_CONNECTION_LIMIT), sql.Literal(runtime_password)))
        done.append(f"created runtime login {runtime}")
    else:
        if any(existing[:5]) or not existing[5]:
            raise BootstrapError(f"role {runtime} exists with unexpected privileges; refusing to continue")
        member = owner_conn.execute(
            "SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles r ON r.oid = m.member "
            "WHERE g.rolname = 'safwan_app' AND r.rolname = %s", (runtime,)).fetchone()
        if member is None:
            raise BootstrapError(f"role {runtime} exists but is not a member of safwan_app; refusing to continue")
        owner_conn.execute(sql.SQL("ALTER ROLE {} PASSWORD {} CONNECTION LIMIT {}")
                           .format(sql.Identifier(runtime), sql.Literal(runtime_password), sql.Literal(RUNTIME_CONNECTION_LIMIT)))
        done.append(f"rotated password of {runtime}")
    db = owner_conn.execute("SELECT current_database()").fetchone()[0]
    owner_conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO safwan_app").format(sql.Identifier(db)))
    done.append("runtime may connect")
    return done


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    env = os.environ
    try:
        if args == ["owner"]:
            url, pw = env.get("BOOTSTRAP_DATABASE_URL"), env.get("OWNER_PASSWORD")
            if not url or not pw:
                print("BOOTSTRAP_DATABASE_URL (superuser) and OWNER_PASSWORD are required.", file=sys.stderr)
                return 2
            with psycopg.connect(url, autocommit=True, connect_timeout=10) as conn:
                done = bootstrap_owner(conn, database=env.get("APP_DB_NAME", "safwan"), owner=env.get("OWNER_ROLE", "safwan_owner"), owner_password=pw)
        elif args == ["runtime"]:
            url, pw = env.get("MIGRATION_DATABASE_URL"), env.get("RUNTIME_PASSWORD")
            if not url or not pw:
                print("MIGRATION_DATABASE_URL (the owner role) and RUNTIME_PASSWORD are required.", file=sys.stderr)
                return 2
            with psycopg.connect(url, autocommit=True, connect_timeout=10) as conn:
                done = bootstrap_runtime(conn, runtime=env.get("RUNTIME_ROLE", "safwan_runtime"), runtime_password=pw)
        else:
            print("usage: python -m app.db.bootstrap owner|runtime", file=sys.stderr)
            return 2
    except (BootstrapError, psycopg.Error) as exc:
        print(f"bootstrap failed: {type(exc).__name__}: {exc if isinstance(exc, BootstrapError) else ''}".rstrip(": "), file=sys.stderr)
        return 1
    print("; ".join(done))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
