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

def test_origin_and_body_validation_before_database(monkeypatch):
    monkeypatch.setenv('VERCEL_ENV', 'preview')
    monkeypatch.setenv('SESSION_HTTP_PREVIEW_ENABLED', '1')
    monkeypatch.setenv('PUBLIC_ORIGIN', 'https://assistant.example.test')
    monkeypatch.setenv('DATABASE_URL', 'postgresql://unreachable.invalid/db')
    monkeypatch.setenv('LOGIN_THROTTLE_HMAC_KEY', 'a' * 48)
    client = TestClient(app)
    assert client.post('/auth/login', json={'email':'test@example.test','password':'pass'}).status_code == 403
    assert client.post('/auth/login', headers={'origin':'https://assistant.example.test'}, json={}).status_code == 422
    assert client.post('/auth/login', headers={'origin':'https://assistant.example.test'}, json={'email':'invalid','password':'pass'}).status_code == 422
