"""Real PostgreSQL concurrency check, run only in the disposable CI database."""
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import psycopg
import pytest
from app.login_throttle import attempt_permitted, record_failed_attempt

@pytest.mark.skipif(not os.getenv("SAFWAN_CI_POSTGRES_DSN"), reason="Requires disposable CI PostgreSQL")
def test_same_subject_login_attempts_serialize():
    dsn = os.environ["SAFWAN_CI_POSTGRES_DSN"]
    subject = bytes.fromhex("ef" * 32)
    entered = threading.Event()
    completed = threading.Event()
    errors = []
    def first():
        try:
            with psycopg.connect(dsn) as conn:
                with conn.transaction():
                    assert attempt_permitted(conn, subject)
                    entered.set()
                    assert completed.wait(timeout=10) is False
                    record_failed_attempt(conn, subject)
        except Exception as error:
            errors.append(error)
    def second():
        try:
            assert entered.wait(timeout=10)
            with psycopg.connect(dsn) as conn:
                with conn.transaction():
                    attempt_permitted(conn, subject)
                    completed.set()
        except Exception as error:
            errors.append(error)
    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(first)
        two = pool.submit(second)
        one.result(timeout=20)
        two.result(timeout=20)
    assert not errors
    assert completed.is_set()
    with psycopg.connect(dsn) as conn:
        row=conn.execute("SELECT failure_count FROM login_attempt_buckets WHERE subject_key=%s",(subject,)).fetchone()
        assert row == (1,)


@pytest.mark.skipif(not os.getenv("SAFWAN_CI_POSTGRES_DSN"), reason="Requires disposable CI PostgreSQL")
def test_real_postgres_lock_expires_and_bucket_resets():
    """A timed-out lock must not permanently deny a legitimate account."""
    from os import urandom
    from app.login_throttle import reset_failures
    dsn = os.environ["SAFWAN_CI_POSTGRES_DSN"]
    subject = urandom(32)
    with psycopg.connect(dsn) as conn:
        with conn.transaction():
            for attempt in range(5):
                assert attempt_permitted(conn, subject)
                record_failed_attempt(conn, subject)
            assert not attempt_permitted(conn, subject)
    with psycopg.connect(dsn) as conn:
        with conn.transaction():
            conn.execute(
                """UPDATE login_attempt_buckets
                   SET window_started_at=now()-interval '31 minutes',
                       locked_until=now()-interval '1 minute'
                   WHERE subject_key=%s""",
                (subject,),
            )
            assert attempt_permitted(conn, subject)
            record_failed_attempt(conn, subject)
            row = conn.execute(
                "SELECT failure_count,locked_until FROM login_attempt_buckets WHERE subject_key=%s",
                (subject,),
            ).fetchone()
            assert row[0] == 1
            assert row[1] is None
            reset_failures(conn, subject)
            assert attempt_permitted(conn, subject)
            assert conn.execute(
                "SELECT count(*) FROM login_attempt_buckets WHERE subject_key=%s",
                (subject,),
            ).fetchone() == (0,)
