"""HTTP integration of the preview login orchestration with a stubbed database.

Complements, but does not replace, PostgreSQL integration and concurrency tests.
"""
from contextlib import nullcontext
from uuid import uuid4
from fastapi.testclient import TestClient
import psycopg
from app.main import app
from app import preview_login_http as login

class FakeConnection:
    def __init__(self):
        self.committed = False
    def __enter__(self):
        return self
    def __exit__(self, error_type, error, traceback):
        self.committed = error_type is None
    def transaction(self):
        return nullcontext()

def configured(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("SESSION_HTTP_PREVIEW_ENABLED", "1")
    monkeypatch.setenv("PUBLIC_ORIGIN", "https://assistant.example.test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://preview-only")
    monkeypatch.setenv("LOGIN_THROTTLE_HMAC_KEY", "s" * 48)
    db = FakeConnection()
    monkeypatch.setattr(psycopg, "connect", lambda *args, **kwargs: db)
    return db

def send(payload):
    return TestClient(app, base_url="https://assistant.example.test").post(
        "/auth/login", headers={"origin":"https://assistant.example.test"},
        json=payload
    )

def test_success_sets_secure_httponly_cookie(monkeypatch):
    db = configured(monkeypatch)
    owner = uuid4()
    monkeypatch.setattr(login, "attempt_permitted", lambda *args: True)
    monkeypatch.setattr(login, "lookup_password_account", lambda *args: owner)
    monkeypatch.setattr(login, "reset_failures", lambda *args: None)
    monkeypatch.setattr(login, "create_session", lambda *args: "private-session-token")
    response = send({"email":"valid@example.test", "password":"long-password-value"})
    assert response.status_code == 200
    assert response.json() == {"status": "authenticated"}
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=lax" in cookie
    assert "private-session-token" not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert db.committed

def test_invalid_password_returns_generic_401_and_records_failure(monkeypatch):
    db = configured(monkeypatch)
    hits = []
    monkeypatch.setattr(login, "attempt_permitted", lambda *args: True)
    monkeypatch.setattr(login, "lookup_password_account", lambda *args: None)
    monkeypatch.setattr(login, "record_failed_attempt", lambda *args: hits.append(1))
    response = send({"email":"unknown@example.test", "password":"wrong-password"})
    assert response.status_code == 401
    assert "set-cookie" not in response.headers
    assert hits == [1] and db.committed

def test_throttled_request_returns_429_without_password_lookup(monkeypatch):
    configured(monkeypatch)
    monkeypatch.setattr(login, "attempt_permitted", lambda *args: False)
    def forbidden_lookup(*args):
        raise AssertionError("Credential lookup must not happen while locked")
    monkeypatch.setattr(login, "lookup_password_account", forbidden_lookup)
    response = send({"email":"locked@example.test", "password":"wrong-password"})
    assert response.status_code == 429
    assert "set-cookie" not in response.headers
