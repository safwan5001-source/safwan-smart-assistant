from uuid import UUID, uuid4
import pytest
from app.session_issuer import create_session
from app.session_secrets import digest_session_secret

class DB:
    def __init__(self): self.calls=[]
    def execute(self,sql,params): self.calls.append((sql,params))

def test_session_insert_hash_only():
    db=DB(); owner=uuid4()
    token=create_session(db, owner)
    sql,params=db.calls[0]
    assert "INSERT INTO sessions" in sql
    assert params[1]==owner
    assert params[2]==digest_session_secret(token)
    assert token not in str(db.calls)

def test_missing_owner_is_rejected():
    db=DB()
    with pytest.raises(ValueError):
        create_session(db,UUID(int=0))
    assert not db.calls

def test_invalid_ttl_never_writes():
    db=DB()
    with pytest.raises(ValueError):
        create_session(db,uuid4(),ttl_seconds=9999999)
    assert not db.calls
