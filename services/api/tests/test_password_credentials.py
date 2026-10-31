from uuid import uuid4
import pytest
from app.password_credentials import hash_password, verify_password, lookup_password_account

class Result:
    def __init__(self,row): self.row=row
    def fetchone(self): return self.row

class FakeDB:
    def __init__(self,row=None): self.row=row; self.calls=[]
    def execute(self,sql,params):
        self.calls.append((sql,params))
        return Result(self.row)

def test_password_hash_is_salted_argon2id():
    a=hash_password("a sufficiently long secret")
    b=hash_password("a sufficiently long secret")
    assert a.startswith("$argon2id$")
    assert a != b
    assert "a sufficiently long secret" not in a
    assert verify_password("a sufficiently long secret",a)
    assert not verify_password("wrong password",a)

def test_reject_invalid_and_oversized_credentials():
    with pytest.raises(ValueError):
        hash_password("short")
    with pytest.raises(ValueError):
        hash_password("x"*1025)
    assert not verify_password("password",None)
    assert not verify_password("password","not-an-argon2-hash")
    assert not verify_password("x"*1025,hash_password("a sufficiently long secret"))

def test_account_lookup_requires_password_and_verified_active_account_sql():
    owner=uuid4()
    password="correct strong password"
    db=FakeDB((owner,hash_password(password)))
    assert lookup_password_account(db,"test@example.invalid",password)==owner
    sql,params=db.calls[0]
    assert "email_verified_at IS NOT NULL" in sql
    assert "deleted_at IS NULL" in sql
    assert params==("test@example.invalid",)
    assert password not in str(db.calls)
    assert lookup_password_account(FakeDB((owner,hash_password(password))),"test@example.invalid","wrong") is None
    assert lookup_password_account(FakeDB(),"absent@example.invalid",password) is None

def test_no_http_login_is_exposed():
    from fastapi.testclient import TestClient
    from app.main import app
    client=TestClient(app)
    assert client.post("/auth/login",json={"email":"test@example.invalid","password":"secret"}).status_code==404

def test_unknown_account_performs_dummy_argon2_verification(monkeypatch):
    from app import password_credentials as credentials
    seen = []
    original = credentials.verify_password
    def spy(password, encoded):
        seen.append(encoded)
        return original(password, encoded)
    monkeypatch.setattr(credentials, "verify_password", spy)
    assert lookup_password_account(FakeDB(), "absent@example.invalid", "wrong-password") is None
    assert len(seen) == 1
    assert seen[0].startswith("$argon2id$")

def test_unknown_account_dummy_hash_is_valid_argon2():
    from app.password_credentials import _DUMMY_HASH
    assert verify_password("incorrect", _DUMMY_HASH) is False
