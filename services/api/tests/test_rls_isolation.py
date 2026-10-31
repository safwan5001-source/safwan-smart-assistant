"""Account isolation against a real PostgreSQL, acting as the restricted application role."""
import psycopg
import pytest

from app.db.scope import owner_transaction
from tests.pg_support import ACCOUNT_A, ACCOUNT_B, make_account

REC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
REC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


@pytest.fixture
def seeded(pg_owner):
    make_account(pg_owner, ACCOUNT_A, "A")
    make_account(pg_owner, ACCOUNT_B, "B")
    pg_owner.execute("INSERT INTO sync_records (account_id, kind, id, body) VALUES (%s,'task',%s,'{\"n\":\"a\"}')", (ACCOUNT_A, REC_A))
    pg_owner.execute("INSERT INTO sync_records (account_id, kind, id, body) VALUES (%s,'task',%s,'{\"n\":\"b\"}')", (ACCOUNT_B, REC_B))
    pg_owner.execute("INSERT INTO audit_log (account_id, event) VALUES (%s,'seed-a'),(%s,'seed-b')", (ACCOUNT_A, ACCOUNT_B))


def count(conn, table):
    return conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


def test_no_scope_means_no_rows(pg_app, seeded):
    for table in ("sync_records", "audit_log", "accounts", "sessions"):
        assert count(pg_app, table) == 0, table


def test_each_owner_sees_only_their_rows(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        assert count(pg_app, "sync_records") == 1
        assert pg_app.execute("SELECT account_id FROM sync_records").fetchone()[0] == ACCOUNT_A
        assert pg_app.execute("SELECT id FROM accounts").fetchall() == [(ACCOUNT_A,)]
        assert [r[0] for r in pg_app.execute("SELECT event FROM audit_log").fetchall()] == ["seed-a"]
    with owner_transaction(pg_app, ACCOUNT_B):
        assert [r[0] for r in pg_app.execute("SELECT event FROM audit_log").fetchall()] == ["seed-b"]


def test_scope_does_not_leak_after_the_transaction(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        assert count(pg_app, "sync_records") == 1
    assert count(pg_app, "sync_records") == 0


def test_scope_is_not_inherited_by_another_pooled_use_of_the_connection(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        pass
    with owner_transaction(pg_app, ACCOUNT_B):
        assert pg_app.execute("SELECT account_id FROM sync_records").fetchall() == [(ACCOUNT_B,)]


def test_cross_account_write_touches_nothing(pg_app, pg_owner, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        cur = pg_app.execute("UPDATE sync_records SET body = '{\"hacked\":true}' WHERE account_id = %s", (ACCOUNT_B,))
        assert cur.rowcount == 0
    assert pg_owner.execute("SELECT body FROM sync_records WHERE account_id = %s", (ACCOUNT_B,)).fetchone()[0] == {"n": "b"}


def test_insert_for_another_account_is_rejected_by_policy(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            pg_app.execute("INSERT INTO sync_records (account_id, kind, id) VALUES (%s,'task',gen_random_uuid())", (ACCOUNT_B,))


def test_cannot_move_a_row_to_another_account(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            pg_app.execute("UPDATE sync_records SET account_id = %s WHERE account_id = %s", (ACCOUNT_B, ACCOUNT_A))


def test_optimistic_concurrency_via_revision(pg_app, seeded):
    sql = "UPDATE sync_records SET body='{\"n\":\"new\"}', revision = revision + 1 WHERE account_id = %s AND id = %s AND revision = %s"
    with owner_transaction(pg_app, ACCOUNT_A):
        assert pg_app.execute(sql, (ACCOUNT_A, REC_A, 999)).rowcount == 0  # stale
        assert pg_app.execute(sql, (ACCOUNT_A, REC_A, 1)).rowcount == 1    # current
        assert pg_app.execute(sql, (ACCOUNT_A, REC_A, 1)).rowcount == 0    # replay of the same revision


def test_application_role_cannot_delete_or_truncate(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            pg_app.execute("DELETE FROM sync_records")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        pg_app.execute("TRUNCATE sync_records")


def test_audit_log_is_append_only_for_the_application(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        pg_app.execute("INSERT INTO audit_log (account_id, event) VALUES (%s, 'login')", (ACCOUNT_A,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            pg_app.execute("UPDATE audit_log SET event = 'edited'")
    with owner_transaction(pg_app, ACCOUNT_A):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            pg_app.execute("DELETE FROM audit_log")
    with owner_transaction(pg_app, ACCOUNT_A):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            pg_app.execute("INSERT INTO audit_log (account_id, event) VALUES (%s, 'forged')", (ACCOUNT_B,))


def test_application_role_cannot_create_or_edit_accounts(pg_app, seeded):
    with owner_transaction(pg_app, ACCOUNT_A):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            pg_app.execute("INSERT INTO accounts (display_name) VALUES ('x')")
    with owner_transaction(pg_app, ACCOUNT_A):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            pg_app.execute("UPDATE accounts SET disabled_at = NULL")


def test_malformed_scope_fails_closed_and_nil_uuid_matches_nothing(pg_app, seeded):
    pg_app.execute("SELECT set_config('app.account_id', 'not-a-uuid', false)")
    with pytest.raises(psycopg.errors.InvalidTextRepresentation):
        pg_app.execute("SELECT count(*) FROM sync_records").fetchone()
    pg_app.execute("SELECT set_config('app.account_id', '00000000-0000-0000-0000-000000000000', false)")
    assert count(pg_app, "sync_records") == 0
    pg_app.execute("SELECT set_config('app.account_id', '', false)")
    assert count(pg_app, "sync_records") == 0


def test_scope_helper_rejects_bad_ids():
    import uuid

    for bad in (None, "x", uuid.UUID(int=0)):
        with pytest.raises((ValueError, TypeError)):
            with owner_transaction(None, bad):  # type: ignore[arg-type]
                pass


def test_forced_rls_applies_to_the_table_owner_for_tenant_data(pg_dsn, seeded):
    """FORCE ROW LEVEL SECURITY: a non-superuser owner must also be filtered. Superusers always bypass, which is why
    the application must never connect as one (documented in docs/B1-SECURITY-REVIEW.md)."""
    assert psycopg.connect(pg_dsn, autocommit=True).execute(
        "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'sync_records'"
    ).fetchone() == (True,)
