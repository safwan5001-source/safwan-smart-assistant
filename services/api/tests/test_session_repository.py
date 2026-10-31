from datetime import datetime, timedelta, timezone
from uuid import uuid4
from app.session_repository import lookup_authenticated_account, revoke_session
from app.session_secrets import issue_session_secret, digest_session_secret

NOW=datetime(2026,10,30,tzinfo=timezone.utc)

class Cursor:
    def __init__(self,row=None,rowcount=0): self.row=row; self.rowcount=rowcount
    def fetchone(self): return self.row

class FakeConnection:
    def __init__(self,row=None,rowcount=0): self.row=row; self.rowcount=rowcount; self.calls=[]
    def execute(self,sql,params):
        self.calls.append((sql,params))
        return Cursor(self.row,self.rowcount)

def test_valid_lookup_uses_hash_not_raw_secret():
    secret=issue_session_secret(); owner=uuid4()
    db=FakeConnection((owner,digest_session_secret(secret),NOW+timedelta(hours=1),None))
    assert lookup_authenticated_account(db,secret,NOW)==owner
    assert db.calls[0][1]==(digest_session_secret(secret),)
    assert secret not in str(db.calls)

def test_expired_and_revoked_denied():
    secret=issue_session_secret(); owner=uuid4(); digest=digest_session_secret(secret)
    for expiry,revoked in [(NOW,None),(NOW+timedelta(hours=1),NOW)]:
        db=FakeConnection((owner,digest,expiry,revoked))
        assert lookup_authenticated_account(db,secret,NOW) is None

def test_missing_or_short_secret_not_queried():
    db=FakeConnection()
    assert lookup_authenticated_account(db,"short",NOW) is None
    assert lookup_authenticated_account(db,None,NOW) is None
    assert not db.calls

def test_revocation_is_parameterized_and_idempotent():
    secret=issue_session_secret()
    db=FakeConnection(rowcount=1)
    assert revoke_session(db,secret)
    assert db.calls[0][1]==(digest_session_secret(secret),)
    db.rowcount=0
    assert not revoke_session(db,secret)
