import psycopg
import pytest

from app.auth import create_session, resolve_session, revoke_all_sessions, revoke_session
from app.auth.sessions import digest_secret, issue_secret
from app.db.scope import owner_transaction
from tests.pg_support import ACCOUNT_A, ACCOUNT_B, make_account


@pytest.fixture
def accounts(pg_owner):
    make_account(pg_owner, ACCOUNT_A, "A")
    make_account(pg_owner, ACCOUNT_B, "B")


def test_create_resolve_revoke_lifecycle(pg_app, accounts):
    secret, expires = create_session(pg_app, ACCOUNT_A)
    assert resolve_session(pg_app, secret) == ACCOUNT_A
    assert revoke_session(pg_app, ACCOUNT_A, secret) is True
    assert resolve_session(pg_app, secret) is None
    assert revoke_session(pg_app, ACCOUNT_A, secret) is False  # already revoked


def test_secret_is_never_stored_only_its_hash(pg_app, pg_owner, accounts):
    secret, _ = create_session(pg_app, ACCOUNT_A)
    rows = pg_owner.execute("SELECT * FROM sessions").fetchall()
    assert len(rows) == 1 and secret not in repr(rows) and secret.encode() not in bytes(rows[0][2])
    assert bytes(rows[0][2]) == digest_secret(secret)


def test_default_and_remember_lifetimes(pg_app, pg_owner, accounts):
    create_session(pg_app, ACCOUNT_A)
    create_session(pg_app, ACCOUNT_A, remember=True)
    days = [r[0] for r in pg_owner.execute(
        "SELECT round((extract(epoch FROM expires_at - created_at) / 86400)::numeric, 1) FROM sessions ORDER BY remember").fetchall()]
    assert [float(d) for d in days] == [7.0, 30.0]


def test_expired_session_is_rejected_by_the_database_clock(pg_app, pg_owner, accounts):
    secret, _ = create_session(pg_app, ACCOUNT_A)
    pg_owner.execute("UPDATE sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'")
    assert resolve_session(pg_app, secret) is None


def test_sessions_of_other_accounts_are_independent(pg_app, accounts):
    sa, _ = create_session(pg_app, ACCOUNT_A)
    sb, _ = create_session(pg_app, ACCOUNT_B)
    assert resolve_session(pg_app, sa) == ACCOUNT_A and resolve_session(pg_app, sb) == ACCOUNT_B
    assert revoke_session(pg_app, ACCOUNT_B, sa) is False  # B cannot revoke A's token
    assert resolve_session(pg_app, sa) == ACCOUNT_A
    revoke_session(pg_app, ACCOUNT_A, sa)
    assert resolve_session(pg_app, sb) == ACCOUNT_B  # revoking A did not touch B


def test_revoke_all_only_affects_one_account(pg_app, accounts):
    a1, _ = create_session(pg_app, ACCOUNT_A)
    a2, _ = create_session(pg_app, ACCOUNT_A, remember=True)
    b1, _ = create_session(pg_app, ACCOUNT_B)
    assert revoke_all_sessions(pg_app, ACCOUNT_A) == 2
    assert resolve_session(pg_app, a1) is None and resolve_session(pg_app, a2) is None
    assert resolve_session(pg_app, b1) == ACCOUNT_B


def test_disabled_account_cannot_create_or_resolve(pg_app, pg_owner, accounts):
    secret, _ = create_session(pg_app, ACCOUNT_A)
    pg_owner.execute("UPDATE accounts SET disabled_at = now() WHERE id = %s", (ACCOUNT_A,))
    assert resolve_session(pg_app, secret) is None
    with pytest.raises(PermissionError):
        create_session(pg_app, ACCOUNT_A)


def test_unknown_and_unprovisioned_accounts_cannot_get_sessions(pg_app, accounts):
    import uuid

    with pytest.raises(PermissionError):
        create_session(pg_app, uuid.uuid4())


def test_malformed_secrets_never_reach_the_database():
    class Boom:
        def execute(self, *a, **k):
            raise AssertionError("database must not be queried for a malformed secret")

    for bad in (None, "", "short", "x" * 42, "x" * 44, "!" * 43, "a b" * 15, "é" * 43):
        assert resolve_session(Boom(), bad) is None  # type: ignore[arg-type]
        assert revoke_session(Boom(), ACCOUNT_A, bad) is False  # type: ignore[arg-type]


def test_unknown_but_well_formed_secret_resolves_to_nothing(pg_app, accounts):
    assert resolve_session(pg_app, issue_secret()) is None


def test_application_role_cannot_read_sessions_directly(pg_app, accounts):
    create_session(pg_app, ACCOUNT_A)
    assert pg_app.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0  # no scope -> no rows
    with owner_transaction(pg_app, ACCOUNT_B):
        assert pg_app.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0  # other account -> no rows


def test_session_rows_are_immutable_except_revocation_and_last_seen(pg_app, accounts):
    create_session(pg_app, ACCOUNT_A)
    with owner_transaction(pg_app, ACCOUNT_A):
        for col in ("expires_at = now() + interval '1 day'", "account_id = gen_random_uuid()", "token_hash = repeat('a',32)::bytea"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with pg_app.transaction():
                    pg_app.execute(f"UPDATE sessions SET {col}")


def test_lifetime_over_31_days_is_rejected_by_constraint(pg_owner, accounts):
    with pytest.raises(psycopg.errors.CheckViolation):
        pg_owner.execute(
            "INSERT INTO sessions (account_id, token_hash, expires_at) VALUES (%s, decode(repeat('ab',32),'hex'), now() + interval '40 days')",
            (ACCOUNT_A,),
        )


def test_a_scoped_caller_cannot_mint_a_session_for_another_account(pg_app, pg_owner, accounts):
    with owner_transaction(pg_app, ACCOUNT_A):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            pg_app.execute(
                "INSERT INTO sessions (account_id, token_hash, expires_at) VALUES (%s, decode(repeat('cd',32),'hex'), now() + interval '1 day')",
                (ACCOUNT_B,),
            )
    assert pg_owner.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0
