"""Read-only readiness check for a hosted PostgreSQL, run from inside the platform (Railway private network).

    python -m app.db.smoke

It answers one question with PASS/FAIL lines: "does this database enforce the security design, as the production runtime role?"
It is built to be safe to run against live data:

  * It never prints, selects or counts user data. Output is check names, PASS/FAIL, and (INFO) the PostgreSQL major version and
    whether TLS is on. Driver error text is never printed (it can embed connection details): only the exception class name.
  * It makes NO lasting change. The only writes are two probes inside transactions that are always rolled back (a refused
    insert, and a nonce claim + replay). The migration-owner connection, used only to compare the applied migrations, is forced
    read-only at the session level.
  * It uses only APP_DATABASE_URL (the restricted runtime login) for the checks. DATABASE_URL is ignored by design.

Environment: APP_DATABASE_URL (required) · MIGRATION_DATABASE_URL (optional: also verifies the owner is refused as a runtime
role and that every migration of this build is applied) · BOOTSTRAP_DATABASE_URL (optional: verifies the superuser is refused)
· SMOKE_REQUIRE_SSL=1 (make a non-TLS connection a failure).
Exit code: 0 all checks passed · 1 a check failed · 2 not configured.
"""
from __future__ import annotations

import hashlib
import os
import sys
import uuid
from collections.abc import Callable

import psycopg

from ..auth.sessions import issue_secret, resolve_session
from .connection import OverPrivilegedRole, connect_runtime
from .migrate import discover
from .scope import owner_transaction

# The single source of truth for "what the runtime role may do". Tests import these, so a new table or grant cannot be added
# without updating (and therefore reviewing) this list.
EXPECTED_TABLE_PRIVILEGES: dict[str, set[str]] = {
    "accounts": {"SELECT"},                          # created only by a reviewed bootstrap path, never by request code
    "sessions": {"SELECT", "INSERT"},                # + column-level UPDATE(revoked_at, last_seen_at)
    "sync_records": {"SELECT", "INSERT", "UPDATE"},  # no DELETE: removal is a tombstone
    "audit_log": {"SELECT", "INSERT"},               # append-only
    "service_nonces": set(),                         # reachable only through a SECURITY DEFINER function
    "schema_migrations": set(),                      # the migration runner's bookkeeping is invisible to the application
}
EXPECTED_UPDATABLE_SESSION_COLUMNS = {"revoked_at", "last_seen_at"}
# (row-level security enabled, FORCEd). FORCE is deliberately absent on accounts/sessions: their only cross-scope reader is the
# SECURITY DEFINER session lookup, which runs as the owner and would be filtered to nothing under FORCE.
EXPECTED_RLS_FLAGS: dict[str, tuple[bool, bool]] = {
    "accounts": (True, False), "sessions": (True, False), "sync_records": (True, True), "audit_log": (True, True),
    "service_nonces": (False, False), "schema_migrations": (False, False),
}
TENANT_TABLES = ("accounts", "sessions", "sync_records", "audit_log")
ALL_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")


class Report:
    def __init__(self) -> None:
        self.failed = 0

    def info(self, text: str) -> None:
        print(f"INFO  {text}")

    def check(self, name: str, fn: Callable[[], bool]) -> None:
        reason = ""
        try:
            ok = bool(fn())
        except Exception as exc:  # noqa: BLE001 - never print driver text: it can contain connection details
            ok, reason = False, f"  [{type(exc).__name__}]"
        self.failed += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'}  {name}{reason}")


def _refused_as_runtime(url: str) -> bool:
    try:
        connect_runtime(url, production=True).close()
    except OverPrivilegedRole:
        return True
    return False  # accepted: the guard did not do its job


def _privilege_matrix(conn: psycopg.Connection) -> bool:
    tables = {r[0] for r in conn.execute(
        "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')").fetchall()}
    if tables != set(EXPECTED_TABLE_PRIVILEGES):  # a table nobody reviewed
        return False
    for table, wanted in EXPECTED_TABLE_PRIVILEGES.items():
        got = {p for p in ALL_PRIVILEGES
               if conn.execute("SELECT has_table_privilege(current_user, %s, %s)", (f"public.{table}", p)).fetchone()[0]}
        if got != wanted:
            return False
    updatable = {c for (c,) in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sessions'").fetchall()
        if conn.execute("SELECT has_column_privilege(current_user, 'public.sessions', %s, 'UPDATE')", (c,)).fetchone()[0]}
    return updatable == EXPECTED_UPDATABLE_SESSION_COLUMNS


def _rls_flags(conn: psycopg.Connection) -> bool:
    flags = {r[0]: (r[1], r[2]) for r in conn.execute(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class "
        "WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'").fetchall()}
    return flags == EXPECTED_RLS_FLAGS


def _policies_filter_by_account_scope(conn: psycopg.Connection) -> bool:
    """Structural and independent of whether any data exists: every policy on a tenant table is bound to the account scope
    (never `USING (true)`), and every tenant table has at least one."""
    rows = conn.execute("SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public'").fetchall()
    for table in TENANT_TABLES:
        mine = [r for r in rows if r[0] == table]
        if not mine:
            return False
        for _, qual, check in mine:
            if "app_account_id()" not in (qual or "") + (check or ""):
                return False
    return True


def _unscoped_insert_is_refused_by_rls(conn: psycopg.Connection) -> bool:
    try:
        with conn.transaction(force_rollback=True):  # rolled back whatever happens: nothing can persist
            conn.execute("INSERT INTO sync_records (account_id, kind, id) VALUES (%s, 'task', %s)", (uuid.uuid4(), uuid.uuid4()))
    except psycopg.errors.InsufficientPrivilege as exc:
        return "row-level security" in (exc.diag.message_primary or "").lower()
    except psycopg.Error:
        return False  # refused for some other reason (e.g. a constraint): RLS was not what stopped it
    return False  # the insert was accepted without a scope


def _unknown_scope_reads_nothing(conn: psycopg.Connection) -> bool:
    with owner_transaction(conn, uuid.uuid4()):  # an account that cannot exist
        return all(conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0] == 0 for t in TENANT_TABLES)


def _no_scope_reads_nothing(conn: psycopg.Connection) -> bool:
    return all(conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0] == 0 for t in TENANT_TABLES)


def _nonce_claim_then_replay(conn: psycopg.Connection) -> bool:
    digest = hashlib.sha256(os.urandom(32)).digest()
    with conn.transaction(force_rollback=True):  # both calls see each other, and nothing is stored afterwards
        first = conn.execute("SELECT auth_claim_nonce(%s, 180)", (digest,)).fetchone()[0]
        replay = conn.execute("SELECT auth_claim_nonce(%s, 180)", (digest,)).fetchone()[0]
    return first is True and replay is False


def _migrations_applied(owner_url: str) -> bool:
    # options: a READ-ONLY session, so this connection (the owner!) cannot change anything even by mistake.
    with psycopg.connect(owner_url, autocommit=True, connect_timeout=5, options="-c default_transaction_read_only=on") as conn:
        applied = {r[0]: r[1] for r in conn.execute("SELECT version, checksum FROM schema_migrations").fetchall()}
    return applied == {m.version: m.checksum for m in discover()}


def run(env: dict[str, str]) -> int:
    app_url = env.get("APP_DATABASE_URL")
    if not app_url:
        print("APP_DATABASE_URL is required (the restricted runtime login). DATABASE_URL is ignored by design.", file=sys.stderr)
        return 2
    report = Report()
    holder: dict[str, psycopg.Connection] = {}

    def login() -> bool:
        holder["rt"] = connect_runtime(app_url, production=True)
        holder["rt"].execute("SET statement_timeout = '10s'")  # session-local, dies with the connection
        return True

    report.check("runtime login is accepted by the production guard (not superuser / owner / BYPASSRLS / CREATEROLE)", login)
    rt = holder.get("rt")
    if rt is None:
        print(f"\nSMOKE FAILED ({report.failed})")
        return 1
    try:
        major = int(rt.execute("SHOW server_version_num").fetchone()[0]) // 10000
        tls = bool(rt.execute("SELECT coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false)").fetchone()[0])
        report.info(f"PostgreSQL major version {major}")
        report.info(f"TLS on this connection: {'on' if tls else 'off'}")
        if env.get("SMOKE_REQUIRE_SSL") == "1":
            report.check("the connection is encrypted (SMOKE_REQUIRE_SSL=1)", lambda: tls)
        report.check("runtime privileges are exactly the intended least-privilege set", lambda: _privilege_matrix(rt))
        report.check("row-level security flags are as designed (FORCE on tenant data)", lambda: _rls_flags(rt))
        report.check("every tenant-table policy is bound to the account scope", lambda: _policies_filter_by_account_scope(rt))
        report.check("without an account scope nothing is readable", lambda: _no_scope_reads_nothing(rt))
        report.check("without an account scope an insert is refused by row-level security (rolled back)", lambda: _unscoped_insert_is_refused_by_rls(rt))
        report.check("an unknown account scope reads nothing", lambda: _unknown_scope_reads_nothing(rt))
        report.check("an unknown session token resolves to nothing", lambda: resolve_session(rt, issue_secret()) is None)
        report.check("a nonce is claimable once and its replay is refused (rolled back)", lambda: _nonce_claim_then_replay(rt))
    finally:
        rt.close()

    owner_url, boot_url = env.get("MIGRATION_DATABASE_URL"), env.get("BOOTSTRAP_DATABASE_URL")
    if owner_url:
        report.check("the migration-owner login is refused as a runtime role", lambda: _refused_as_runtime(owner_url))
        report.check("every migration of this build is applied, none unknown, checksums equal (read-only session)", lambda: _migrations_applied(owner_url))
    else:
        report.info("MIGRATION_DATABASE_URL not set: owner-refusal and migration checks skipped")
    if boot_url:
        report.check("the instance superuser is refused as a runtime role", lambda: _refused_as_runtime(boot_url))
    print(f"\n{'SMOKE PASSED' if report.failed == 0 else f'SMOKE FAILED ({report.failed})'}")
    return 0 if report.failed == 0 else 1


def main() -> int:
    return run(dict(os.environ))


if __name__ == "__main__":
    raise SystemExit(main())
