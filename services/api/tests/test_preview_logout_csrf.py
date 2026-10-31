from fastapi.testclient import TestClient
from app.main import app
from app.preview_csrf import csrf_proof

def test_logout_unavailable_outside_preview(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setenv("SESSION_HTTP_PREVIEW_ENABLED", "1")
    assert TestClient(app).post("/auth/logout").status_code == 404

def test_logout_unavailable_when_flag_off(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.delenv("SESSION_HTTP_PREVIEW_ENABLED", raising=False)
    assert TestClient(app).post("/auth/logout").status_code == 404

def test_logout_requires_authenticated_cookie(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("SESSION_HTTP_PREVIEW_ENABLED", "1")
    assert TestClient(app).post("/auth/logout").status_code == 401

def test_logout_blocks_cross_site_and_invalid_csrf_before_db(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("SESSION_HTTP_PREVIEW_ENABLED", "1")
    monkeypatch.setenv("PUBLIC_ORIGIN", "https://assistant.example.test")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    secret="x"*48
    c=TestClient(app, cookies={"safwan_session": secret})
    assert c.post("/auth/logout", headers={"origin":"https://attacker.example.test","x-csrf-token":csrf_proof(secret)}).status_code == 403
    assert c.post("/auth/logout", headers={"origin":"https://assistant.example.test","x-csrf-token":"bad"}).status_code == 403
    assert c.post("/auth/logout", headers={"origin":"https://assistant.example.test","sec-fetch-site":"cross-site","x-csrf-token":csrf_proof(secret)}).status_code == 403
    assert c.post("/auth/logout", headers={"origin":"https://assistant.example.test","x-csrf-token":csrf_proof(secret)}).status_code == 503

def test_logout_not_advertised_in_openapi():
    assert "/auth/logout" not in TestClient(app).get("/openapi.json").json()["paths"]
