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
