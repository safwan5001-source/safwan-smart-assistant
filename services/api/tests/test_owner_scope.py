from uuid import UUID, uuid4
import pytest
from app.owner_scope import owner_transaction, verified_account_id

class FakeTransaction:
    def __init__(self, connection): self.connection=connection
    def __enter__(self): self.connection.events.append("begin")
    def __exit__(self, typ, val, tb): self.connection.events.append("rollback" if typ else "commit")

class FakeConnection:
    def __init__(self): self.events=[]
    def transaction(self): return FakeTransaction(self)
    def execute(self, sql, params): self.events.append((sql,params))

def test_owner_context_is_transaction_local_and_parameterized():
    account=uuid4(); connection=FakeConnection()
    with owner_transaction(connection,account): connection.events.append("query")
    assert connection.events[0]=="begin"
    assert connection.events[1][1]==(str(account),)
    assert "set_config" in connection.events[1][0]
    assert connection.events[-1]=="commit"

def test_owner_context_rolls_back_on_failure():
    connection=FakeConnection()
    with pytest.raises(RuntimeError):
        with owner_transaction(connection,uuid4()): raise RuntimeError("fail")
    assert connection.events[-1]=="rollback"

def test_no_missing_or_zero_owner_scope():
    with pytest.raises(ValueError): verified_account_id(str(UUID(int=0)))
    with pytest.raises(ValueError):
        with owner_transaction(FakeConnection(),UUID(int=0)): pass
    with pytest.raises(ValueError):
        with owner_transaction(FakeConnection(),"untrusted"): pass
