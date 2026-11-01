"""Phase 3 adversarial tests, run against a REAL PostgreSQL as the production runtime login (a LOGIN role that is merely a
member of `safwan_app`, connected through `connect_runtime(production=True)`), never as a superuser.

They complement the per-feature suites with the questions a reviewer asks before a database goes live:
  * can an account scope leak through nesting, exceptions, interleaving or concurrent connections?
  * can one account read, revoke or resurrect another account's sessions?
  * is the runtime role's privilege set exactly the intended, least-privilege one (so a new table or a changed default
    privilege on the hosting platform cannot silently widen it)?
"""
from __future__ import annotations

import random
import threading
from uuid import UUID, uuid4

import psycopg
import pytest

from app.auth.sessions import create_session, digest_secret, resolve_session, revoke_all_sessions, revoke_session
from app.db.connection import connect_runtime
from app.db.scope import owner_transaction
from tests.pg_support import ACCOUNT_A, ACCOUNT_B, make_account

ACCOUNT_C = UUID("33333333-3333-4333-8333-333333333333")
ACCOUNTS = (ACCOUNT_A, ACCOUNT_B, ACCOUNT_C)


@pytest.fixture
def runtime(pg_runtime_dsn, pg_owner):
    conn = connect_runtime(pg_runtime_dsn, production=True)
    yield conn
    conn.close()


def scope(conn: psycopg.Connection) -> str:
    return conn.execute("SELECT coalesce(current_setting('app.account_id', true), '')").fetchone()[0]


def seed_rows(owner: psycopg.Connection, counts: dict[UUID, int]) -> None:
    for account, n in counts.items():
        make_account(owner, account)
        for _ in range(n):
            owner.execute("INSERT INTO sync_records (account_id, kind, id) VALUES (%s, 'task', %s)", (account, uuid4()))


# ── scope leakage ─────────────────────────────────────────────────────────────────────────────────────────────────────
def test_random_nesting_with_random_failures_never_leaks_scope(runtime, pg_owner):
    seed_rows(pg_owner, {ACCOUNT_A: 3, ACCOUNT_B: 4, ACCOUNT_C: 5})
    rng = random.Random(20261101)  # deterministic: a failure is reproducible
    checks = 0

    class Boom(Exception):
        pass

    def walk(depth: int, outer_scope: str) -> None:
        nonlocal checks
        for _ in range(rng.randint(1, 3)):
            account = rng.choice(ACCOUNTS)
            try:
                with owner_transaction(runtime, account):
                    assert scope(runtime) == str(account)
                    seen = {r[0] for r in runtime.execute("SELECT DISTINCT account_id FROM sync_records").fetchall()}
                    assert seen <= {account}, f"{account} saw rows of {seen - {account}}"
                    checks += 2
                    if depth < 4:
                        walk(depth + 1, str(account))
                    if rng.random() < 0.25:
                        raise Boom
            except Boom:
                pass
            assert scope(runtime) == outer_scope, f"scope after a depth-{depth} block is {scope(runtime)!r}, expected {outer_scope!r}"
            checks += 1

    for _ in range(25):
        walk(0, "")
        assert scope(runtime) == ""
    assert checks > 500  # the fuzz really exercised the code, it did not trivially pass


def test_concurrent_connections_never_see_each_others_rows(pg_runtime_dsn, pg_owner):
    expected = {ACCOUNT_A: 5, ACCOUNT_B: 7, ACCOUNT_C: 11}
    seed_rows(pg_owner, expected)
    problems: list[str] = []

    def worker(account: UUID) -> None:
        conn = connect_runtime(pg_runtime_dsn, production=True)
        try:
            for _ in range(60):
                with owner_transaction(conn, account):
                    n = conn.execute("SELECT count(*) FROM sync_records").fetchone()[0]
                    if n != expected[account]:
                        problems.append(f"{account}: saw {n}, expected {expected[account]}")
                n = conn.execute("SELECT count(*) FROM sync_records").fetchone()[0]
                if n != 0:
                    problems.append(f"unscoped read after a block returned {n} rows")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"{type(exc).__name__}")
        finally:
            conn.close()

    threads = [threading.Thread(target=worker, args=(a,)) for a in ACCOUNTS for _ in range(3)]
    [t.start() for t in threads]
    [t.join(timeout=60) for t in threads]
    assert not any(t.is_alive() for t in threads)
    assert problems == []


# ── sessions: cross-account and revocation ───────────────────────────────────────────────────────────────────────────
def test_one_account_cannot_read_revoke_or_resurrect_anothers_sessions(runtime, pg_owner):
    make_account(pg_owner, ACCOUNT_A)
    make_account(pg_owner, ACCOUNT_B)
    secret_a, _ = create_session(runtime, ACCOUNT_A)
    secret_b, _ = create_session(runtime, ACCOUNT_B)
    hash_a = digest_secret(secret_a)

    with owner_transaction(runtime, ACCOUNT_B):
        assert [r[0] for r in runtime.execute("SELECT account_id FROM sessions").fetchall()] == [ACCOUNT_B]  # only its own
        assert runtime.execute("SELECT count(*) FROM sessions WHERE token_hash = %s", (hash_a,)).fetchone() == (0,)
        assert runtime.execute("UPDATE sessions SET revoked_at = now() WHERE token_hash = %s", (hash_a,)).rowcount == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege):  # not even column-level rights over account_id / expiry
            runtime.execute("UPDATE sessions SET account_id = %s WHERE token_hash = %s", (ACCOUNT_B, digest_secret(secret_b)))
    assert revoke_session(runtime, ACCOUNT_B, secret_a) is False  # B cannot revoke A's token
    assert resolve_session(runtime, secret_a) == ACCOUNT_A and resolve_session(runtime, secret_b) == ACCOUNT_B

    assert revoke_all_sessions(runtime, ACCOUNT_A) == 1
    assert resolve_session(runtime, secret_a) is None          # revoked: immediately and permanently dead
    assert resolve_session(runtime, secret_b) == ACCOUNT_B     # the other account is untouched
    with owner_transaction(runtime, ACCOUNT_A):
        with pytest.raises(psycopg.errors.CheckViolation):     # revocation cannot be undone by the application role
            runtime.execute("UPDATE sessions SET revoked_at = NULL WHERE token_hash = %s", (hash_a,))
    assert resolve_session(runtime, secret_a) is None


def test_disabling_an_account_and_expiry_take_effect_on_the_next_lookup(runtime, pg_owner):
    make_account(pg_owner, ACCOUNT_A)
    secret, _ = create_session(runtime, ACCOUNT_A, remember=True)
    assert resolve_session(runtime, secret) == ACCOUNT_A
    pg_owner.execute("UPDATE accounts SET disabled_at = now() WHERE id = %s", (ACCOUNT_A,))
    assert resolve_session(runtime, secret) is None            # a disabled account's live sessions stop working at once
    pg_owner.execute("UPDATE accounts SET disabled_at = NULL WHERE id = %s", (ACCOUNT_A,))
    pg_owner.execute("UPDATE sessions SET expires_at = now() - interval '1 second', created_at = now() - interval '1 day'")
    assert resolve_session(runtime, secret) is None            # expiry is judged by the database clock
    with pytest.raises(PermissionError):                       # and a disabled account cannot mint new ones
        pg_owner.execute("UPDATE accounts SET disabled_at = now()")
        create_session(runtime, ACCOUNT_A)


def test_session_secrets_are_not_recoverable_from_the_database(runtime, pg_owner):
    make_account(pg_owner, ACCOUNT_A)
    secret, _ = create_session(runtime, ACCOUNT_A)
    dump = " ".join(str(v) for row in pg_owner.execute("SELECT * FROM sessions").fetchall() for v in row)
    assert secret not in dump


# ── privileges: the runtime role is exactly least-privilege ──────────────────────────────────────────────────────────
TABLE_PRIVILEGES = {
    "accounts": {"SELECT"},                      # created only by a reviewed bootstrap path, never by request code
    "sessions": {"SELECT", "INSERT"},            # + column-level UPDATE(revoked_at, last_seen_at), asserted below
    "sync_records": {"SELECT", "INSERT", "UPDATE"},  # no DELETE: removal is a tombstone
    "audit_log": {"SELECT", "INSERT"},           # append-only
    "service_nonces": set(),                     # reachable only through the SECURITY DEFINER function
    "schema_migrations": set(),                  # the runner's bookkeeping is invisible to the application
}


def test_runtime_role_privileges_are_exactly_the_intended_set(runtime):
    tables = {r[0] for r in runtime.execute(
        "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')").fetchall()}
    # A new table must be added here deliberately, with its privileges reviewed. It can never ship by accident.
    assert tables == set(TABLE_PRIVILEGES)
    for table, wanted in TABLE_PRIVILEGES.items():
        got = {p for p in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")
               if runtime.execute("SELECT has_table_privilege(current_user, %s, %s)", (f"public.{table}", p)).fetchone()[0]}
        assert got == wanted, f"{table}: runtime role has {sorted(got)}, intended {sorted(wanted)}"
    updatable = {c for (c,) in runtime.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sessions'").fetchall()
        if runtime.execute("SELECT has_column_privilege(current_user, 'public.sessions', %s, 'UPDATE')", (c,)).fetchone()[0]}
    assert updatable == {"revoked_at", "last_seen_at"}


def test_row_level_security_flags_are_pinned(pg_owner):
    """FORCE is deliberately NOT set on accounts/sessions: their only cross-scope reader is the SECURITY DEFINER lookup
    (`auth_resolve_session`), which runs as the table owner and would be filtered to nothing under FORCE. Their protection is
    that the application role is neither owner nor BYPASSRLS (enforced at connect time) and has no direct access path.
    Tenant data (sync_records, audit_log) is FORCEd: even an owner-level session is subject to its policies."""
    flags = {r[0]: (r[1], r[2]) for r in pg_owner.execute(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class "
        "WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1").fetchall()}
    assert flags == {
        "accounts": (True, False), "sessions": (True, False),
        "sync_records": (True, True), "audit_log": (True, True),
        "service_nonces": (False, False), "schema_migrations": (False, False),
    }
