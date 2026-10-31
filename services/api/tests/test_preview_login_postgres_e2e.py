"""Real PostgreSQL HTTP login flow in disposable CI database only."""
import os
from uuid import uuid4
import psycopg
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.password_credentials import hash_password

@pytest.mark.skipif(not os.getenv("SAFWAN_CI_POSTGRES_DSN"), reason="Disposable CI PostgreSQL required")
def test_login_issues_persisted_session_and_rejects_wrong_password(monkeypatch):
    dsn=os.environ["SAFWAN_CI_POSTGRES_DSN"]
    owner=uuid4()
    password="test-only-long-password-123!"
    email=f"session-{owner.hex}@gmail.com"
    with psycopg.connect(dsn) as conn:
        conn.execute("INSERT INTO accounts (id,email_normalized,display_name,email_verified_at) VALUES (%s,%s,%s,now())",(owner,email,"CI Login"))
        conn.execute("INSERT INTO account_password_credentials (account_id,password_hash) VALUES (%s,%s)",(owner,hash_password(password)))
    monkeypatch.setenv("VERCEL_ENV","preview")
    monkeypatch.setenv("SESSION_HTTP_PREVIEW_ENABLED","1")
    monkeypatch.setenv("PREVIEW_NETWORK_PEER_VERIFIED","1")
    monkeypatch.setenv("PUBLIC_ORIGIN","https://assistant.example.test")
    monkeypatch.setenv("DATABASE_URL",dsn)
    monkeypatch.setenv("LOGIN_THROTTLE_HMAC_KEY","ci-only-ephemeral-key-with-sufficient-length-0001")
    client=TestClient(app,base_url="https://assistant.example.test",client=("192.0.2.42",54321))
    headers={"origin":"https://assistant.example.test"}
    bad=client.post("/auth/login",headers=headers,json={"email":email,"password":"wrong-password"})
    assert bad.status_code==401
    assert "set-cookie" not in bad.headers
    good=client.post("/auth/login",headers=headers,json={"email":email,"password":password})
    assert good.status_code==200
    assert "httponly" in good.headers["set-cookie"].lower()
    assert "secure" in good.headers["set-cookie"].lower()
    with psycopg.connect(dsn) as conn:
        assert conn.execute("SELECT count(*) FROM sessions WHERE account_id=%s AND revoked_at IS NULL",(owner,)).fetchone()==(1,)
    me=client.get("/auth/me")
    assert me.status_code==200
    assert me.json()["account_id"]==str(owner)
    csrf=me.json()["csrf_token"]
    logout=client.post("/auth/logout",headers={"origin":"https://assistant.example.test","x-csrf-token":csrf})
    assert logout.status_code==200
    assert client.get("/auth/me").status_code==401
    with psycopg.connect(dsn) as conn:
        assert conn.execute("SELECT count(*) FROM sessions WHERE account_id=%s AND revoked_at IS NOT NULL",(owner,)).fetchone()==(1,)


@pytest.mark.skipif(not os.getenv("SAFWAN_CI_POSTGRES_DSN"), reason="Disposable CI PostgreSQL required")
def test_locked_account_does_not_block_another_account_on_same_peer(monkeypatch):
    dsn = os.environ["SAFWAN_CI_POSTGRES_DSN"]
    suffix = uuid4().hex
    password = "correct-ci-password-for-shared-peer"
    first = uuid4()
    second = uuid4()
    first_email = f"locked-{suffix}@gmail.com"
    second_email = f"safe-{suffix}@gmail.com"
    with psycopg.connect(dsn) as conn:
        for owner, email in ((first, first_email), (second, second_email)):
            conn.execute(
                "INSERT INTO accounts (id,email_normalized,display_name,email_verified_at) VALUES (%s,%s,%s,now())",
                (owner, email, "CI Shared Peer"),
            )
            conn.execute(
                "INSERT INTO account_password_credentials (account_id,password_hash) VALUES (%s,%s)",
                (owner, hash_password(password)),
            )
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("SESSION_HTTP_PREVIEW_ENABLED", "1")
    monkeypatch.setenv("PREVIEW_NETWORK_PEER_VERIFIED", "1")
    monkeypatch.setenv("PUBLIC_ORIGIN", "https://assistant.example.test")
    monkeypatch.setenv("DATABASE_URL", dsn)
    monkeypatch.setenv("LOGIN_THROTTLE_HMAC_KEY", "isolated-shared-peer-ci-hmac-key-000000000000")
    client = TestClient(app, base_url="https://assistant.example.test", client=("192.0.2.42", 54321))
    headers = {"origin": "https://assistant.example.test"}
    for _ in range(5):
        result = client.post("/auth/login", headers=headers, json={"email": first_email, "password": "incorrect"})
        assert result.status_code == 401
    assert client.post("/auth/login", headers=headers, json={"email": first_email, "password": password}).status_code == 429
    other = client.post("/auth/login", headers=headers, json={"email": second_email, "password": password})
    assert other.status_code == 200
    assert "httponly" in other.headers["set-cookie"].lower()
