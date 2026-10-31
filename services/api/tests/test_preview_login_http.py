from fastapi.testclient import TestClient
from app.main import app

def test_login_disabled_in_production(monkeypatch):
    monkeypatch.setenv('VERCEL_ENV', 'production')
    monkeypatch.setenv('SESSION_HTTP_PREVIEW_ENABLED', '1')
    assert TestClient(app).post('/auth/login', json={}).status_code == 404

def test_login_disabled_by_default_in_preview(monkeypatch):
    monkeypatch.setenv('VERCEL_ENV', 'preview')
    monkeypatch.delenv('SESSION_HTTP_PREVIEW_ENABLED', raising=False)
    assert TestClient(app).post('/auth/login', json={}).status_code == 404

def test_login_not_advertised():
    assert '/auth/login' not in TestClient(app).get('/openapi.json').json()['paths']
