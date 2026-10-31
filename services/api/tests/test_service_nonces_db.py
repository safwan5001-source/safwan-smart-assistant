import hashlib
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest

from app.service_auth import PostgresNonceStore


def h(nonce: str) -> bytes:
    return hashlib.sha256(nonce.encode()).digest()


def test_first_claim_wins_and_replay_is_refused(pg_app):
    assert pg_app.execute("SELECT auth_claim_nonce(%s, 180)", (h("n1"),)).fetchone()[0] is True
    assert pg_app.execute("SELECT auth_claim_nonce(%s, 180)", (h("n1"),)).fetchone()[0] is False
    assert pg_app.execute("SELECT auth_claim_nonce(%s, 180)", (h("n2"),)).fetchone()[0] is True


def test_expired_nonce_is_reclaimable_and_cleanup_is_bounded(pg_app, pg_owner):
    pg_app.execute("SELECT auth_claim_nonce(%s, 180)", (h("old"),))
    pg_owner.execute("UPDATE service_nonces SET expires_at = now() - interval '1 second'")
    assert pg_app.execute("SELECT auth_claim_nonce(%s, 180)", (h("old"),)).fetchone()[0] is True
    pg_owner.execute("INSERT INTO service_nonces SELECT sha256(i::text::bytea), now() - interval '1 minute' FROM generate_series(1,250) i")
    pg_app.execute("SELECT auth_claim_nonce(%s, 180)", (h("fresh"),))
    left = pg_owner.execute("SELECT count(*) FROM service_nonces WHERE expires_at <= now()").fetchone()[0]
    assert 100 <= left <= 150  # at most 100 removed per call: housekeeping can never turn into a long lock


def test_invalid_arguments_are_rejected(pg_app):
    for args in ((b"short", 180), (h("x"), 0), (h("x"), 99999), (None, 180)):
        with pytest.raises(psycopg.Error):
            pg_app.execute("SELECT auth_claim_nonce(%s, %s)", args)


def test_application_role_has_no_direct_access_to_the_nonce_table(pg_app):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        pg_app.execute("SELECT * FROM service_nonces")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        pg_app.execute("DELETE FROM service_nonces")


def test_concurrent_claims_of_one_nonce_have_exactly_one_winner(pg_dsn, pg_owner):
    store = PostgresNonceStore(pg_dsn, production=False)  # superuser DSN here only to exercise the function end to end
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda _: store.claim("race-nonce-0123456789abcdef", 180), range(24)))
    assert results.count(True) == 1 and results.count(False) == 23
