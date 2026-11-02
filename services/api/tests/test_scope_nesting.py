"""Regression: nested owner_transaction must restore the outer account scope (no cross-account leakage).

PostgreSQL keeps `set_config(..., true)` values after a SAVEPOINT is released. A nested owner_transaction therefore used to leave
the INNER account active for the rest of the OUTER block: statements the caller believed were scoped to account B ran as account A.
These tests run as the restricted application role against a real PostgreSQL.
"""
from uuid import UUID

import psycopg
import pytest

from app.db.scope import owner_transaction
from tests.pg_support import ACCOUNT_A, ACCOUNT_B, make_account

ACCOUNT_C = UUID("33333333-3333-4333-8333-333333333333")
NIL = UUID(int=0)
REC = {ACCOUNT_A: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ACCOUNT_B: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ACCOUNT_C: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}


@pytest.fixture
def seeded(pg_owner):
    for acct, name in ((ACCOUNT_A, "A"), (ACCOUNT_B, "B"), (ACCOUNT_C, "C")):
        make_account(pg_owner, acct, name)
        pg_owner.execute("INSERT INTO sync_records (account_id, kind, id, body) VALUES (%s,'task',%s,%s)", (acct, REC[acct], f'{{"owner":"{name}"}}'))


def scope(conn):
    return conn.execute("SELECT app_account_id()").fetchone()[0]


def visible(conn):
    return sorted(r[0] for r in conn.execute("SELECT account_id FROM sync_records").fetchall())


def test_outer_scope_is_restored_after_a_nested_block(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_B):
        with owner_transaction(pg_app, ACCOUNT_A):
            assert scope(pg_app) == ACCOUNT_A and visible(pg_app) == [ACCOUNT_A]
        assert scope(pg_app) == ACCOUNT_B, "inner account leaked into the outer block"
        assert visible(pg_app) == [ACCOUNT_B]


def test_each_level_of_a_three_deep_nesting_is_restored(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        with owner_transaction(pg_app, ACCOUNT_B):
            with owner_transaction(pg_app, ACCOUNT_C):
                assert scope(pg_app) == ACCOUNT_C
            assert scope(pg_app) == ACCOUNT_B
        assert scope(pg_app) == ACCOUNT_A
        assert visible(pg_app) == [ACCOUNT_A]


def test_scope_is_restored_when_the_nested_block_raises_and_the_caller_continues(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_B):
        with pytest.raises(psycopg.errors.DivisionByZero):
            with owner_transaction(pg_app, ACCOUNT_A):
                assert scope(pg_app) == ACCOUNT_A
                pg_app.execute("SELECT 1/0")
        assert scope(pg_app) == ACCOUNT_B
        assert visible(pg_app) == [ACCOUNT_B]  # and the connection is still usable


def test_scope_does_not_outlive_the_outermost_transaction(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_B):
        with owner_transaction(pg_app, ACCOUNT_A):
            pass
    assert visible(pg_app) == []  # no scope at all outside any scoped block
    with owner_transaction(pg_app, ACCOUNT_C):
        assert visible(pg_app) == [ACCOUNT_C]


def test_no_cross_account_write_after_a_nested_block(pg_app, seeded):
    """The harmful case: after the inner block the caller writes as B; it must not be able to write as A."""
    with owner_transaction(pg_app, ACCOUNT_B):
        with owner_transaction(pg_app, ACCOUNT_A):
            pass
        pg_app.execute("INSERT INTO sync_records (account_id, kind, id) VALUES (%s,'task','dddddddd-dddd-4ddd-8ddd-dddddddddddd')", (ACCOUNT_B,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with pg_app.transaction():
                pg_app.execute("INSERT INTO sync_records (account_id, kind, id) VALUES (%s,'task','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')", (ACCOUNT_A,))
        assert pg_app.execute("UPDATE sync_records SET body='{}' WHERE account_id = %s", (ACCOUNT_A,)).rowcount == 0


def test_statement_timeout_is_restored_too(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A, statement_timeout_ms=7000):
        assert pg_app.execute("SHOW statement_timeout").fetchone()[0] == "7s"
        with owner_transaction(pg_app, ACCOUNT_B, statement_timeout_ms=1000):
            assert pg_app.execute("SHOW statement_timeout").fetchone()[0] == "1s"
        assert pg_app.execute("SHOW statement_timeout").fetchone()[0] == "7s"


def test_an_invalid_nested_scope_is_refused_and_leaves_the_outer_scope_intact(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_B):
        with pytest.raises(ValueError):
            with owner_transaction(pg_app, NIL):
                pytest.fail("must not run")
        with pytest.raises(ValueError):
            with owner_transaction(pg_app, ACCOUNT_A, statement_timeout_ms=5):
                pytest.fail("must not run")
        assert scope(pg_app) == ACCOUNT_B


def test_sequential_blocks_after_a_nested_one_are_independent(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        with owner_transaction(pg_app, ACCOUNT_B):
            pass
    with owner_transaction(pg_app, ACCOUNT_B):
        assert visible(pg_app) == [ACCOUNT_B]
    with owner_transaction(pg_app, ACCOUNT_A):
        assert visible(pg_app) == [ACCOUNT_A]


def test_worker_style_loop_inside_one_outer_transaction_never_mixes_accounts(pg_app, seeded):
    """A worker that processes several accounts' jobs inside one outer transaction: every row it reads belongs to the active account."""
    with owner_transaction(pg_app, ACCOUNT_C):
        for acct in (ACCOUNT_A, ACCOUNT_B, ACCOUNT_A, ACCOUNT_B):
            with owner_transaction(pg_app, acct):
                assert visible(pg_app) == [acct]
            assert visible(pg_app) == [ACCOUNT_C]
