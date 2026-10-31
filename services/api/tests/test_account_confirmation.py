from uuid import uuid4
import pytest
from app.account_confirmation import confirm_account_email

class Result:
    def __init__(self, count): self.rowcount=count
class FakeConnection:
    def __init__(self, consumes=1, updates=1):
        self.calls=[]; self.counts=[consumes,updates]
    def execute(self,sql,params):
        self.calls.append((sql,params))
        return Result(self.counts.pop(0))

def test_confirm_consumes_then_verifies_same_account():
    db=FakeConnection(); owner=uuid4()
    assert confirm_account_email(db,owner,"x"*48)
    assert len(db.calls)==2
    assert db.calls[0][1][0]==owner
    assert db.calls[1][1]==(owner,)

def test_used_or_expired_token_never_verifies():
    db=FakeConnection(consumes=0)
    assert not confirm_account_email(db,uuid4(),"x"*48)
    assert len(db.calls)==1

def test_account_update_failure_requires_rollback():
    db=FakeConnection(updates=0)
    with pytest.raises(RuntimeError,match="roll back"):
        confirm_account_email(db,uuid4(),"x"*48)

def test_invalid_token_and_owner_never_write():
    db=FakeConnection()
    assert not confirm_account_email(db,uuid4(),"short")
    assert not confirm_account_email(db,"untrusted","x"*48)
    assert not db.calls
