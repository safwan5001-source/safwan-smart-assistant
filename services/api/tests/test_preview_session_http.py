"""Preview session read route remains closed unless explicitly enabled."""
from fastapi.testclient import TestClient
from app.main import app

def test_production_is_always_closed_even_with_feature_flag(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setenv("SESSION_HTTP_PREVIEW_ENABLED", "1")
    assert TestClient(app).get("/auth/me").status_code == 404

def test_preview_flag_defaults_closed(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.delenv("SESSION_HTTP_PREVIEW_ENABLED", raising=False)
    assert TestClient(app).get("/auth/me").status_code == 404

def test_preview_requires_cookie_and_configured_database(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("SESSION_HTTP_PREVIEW_ENABLED", "1")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert TestClient(app).get("/auth/me").status_code == 401
    response=TestClient(app, cookies={"safwan_session":"not-a-valid-token"}).get("/auth/me")
    assert response.status_code == 503
    assert "not-a-valid-token" not in response.text

def test_probe_not_advertised_in_openapi():
    assert "/auth/me" not in TestClient(app).get("/openapi.json").json()["paths"]
