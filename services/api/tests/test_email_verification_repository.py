from uuid import UUID, uuid4
from app.email_verification_repository import store_email_verification, consume_email_verification
import hashlib

class Result:
    def __init__(self,n): self.rowcount=n

class Database:
    def __init__(self,n=1): self.calls=[]; self.n=n
    def execute(self,sql,params):
        self.calls.append((sql,params))
        return Result(self.n)

def test_store_uses_hash_not_raw_token():
    owner=uuid4(); db=Database()
    token=store_email_verification(db,owner)
    assert db.calls[0][1][1]==owner
    assert db.calls[0][1][2]==hashlib.sha256(token.encode()).digest()
    assert token not in str(db.calls)

def test_consume_scoped_and_once_only():
    owner=uuid4(); db=Database()
    token="x"*48
    assert consume_email_verification(db,owner,token)
    assert db.calls[0][1]==(owner,hashlib.sha256(token.encode()).digest())
    assert "consumed_at IS NULL" in db.calls[0][0]
    db.n=0
    assert not consume_email_verification(db,owner,token)

def test_invalid_tokens_never_write():
    db=Database()
    assert not consume_email_verification(db,uuid4(),"bad")
    assert not consume_email_verification(db,UUID(int=0),"x"*48)
    assert not db.calls
