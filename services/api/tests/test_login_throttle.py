from datetime import datetime, timedelta, timezone
import pytest
from app.login_throttle import subject_digest, attempt_permitted, record_failed_attempt, reset_failures

NOW=datetime(2026,10,31,tzinfo=timezone.utc)
class Cursor:
    def __init__(self,row):self.row=row
    def fetchone(self):return self.row
class DB:
    def __init__(self,row=None):self.row=row;self.calls=[]
    def execute(self,sql,params):
        self.calls.append((sql,params))
        return Cursor(self.row)

def test_hmac_subject_uses_key_and_does_not_expose_email():
    a=subject_digest("user@example.invalid",b"x"*32)
    assert len(a)==32
    assert a!=subject_digest("user@example.invalid",b"y"*32)
    assert a!=subject_digest("other@example.invalid",b"x"*32)
    assert b"user@example.invalid" not in a
    with pytest.raises(ValueError):subject_digest("user@example.invalid",b"short")

def test_expired_lock_is_allowed_and_live_lock_denied():
    db=DB((5,NOW-timedelta(minutes=5),NOW+timedelta(minutes=1)))
    s=b"a"*32
    assert not attempt_permitted(db,s,NOW)
    db.row=(5,NOW-timedelta(minutes=20),NOW-timedelta(seconds=1))
    assert attempt_permitted(db,s,NOW)
    assert "FOR UPDATE" in db.calls[0][0]

def test_failure_and_reset_are_parameterized():
    db=DB()
    s=b"b"*32
    record_failed_attempt(db,s)
    assert db.calls[0][1]==(s,)
    assert "ON CONFLICT" in db.calls[0][0]
    assert "locked_until" in db.calls[0][0]
    reset_failures(db,s)
    assert db.calls[1][1]==(s,)

def test_login_route_stays_closed():
    from fastapi.testclient import TestClient
    from app.main import app
    assert TestClient(app).post("/auth/login",json={}).status_code==404
