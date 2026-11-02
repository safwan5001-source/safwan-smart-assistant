import os
from fastapi.testclient import TestClient
from app.main import app


def test_browser_smoke_protected(monkeypatch):
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "a" * 40)
    c = TestClient(app)
    assert c.post("/internal/browser/smoke", json={}).status_code == 401
    assert c.post("/internal/browser/smoke", headers={"Authorization": "Bearer wrong"}, json={}).status_code == 401
    assert c.post("/internal/browser/smoke", headers={"Authorization": "Bearer " + "a" * 40}, json={"url": "https://localhost"}).status_code == 400
    assert c.post("/internal/browser/smoke", headers={"Authorization": "Bearer " + "a" * 40}, json={}).status_code == 503
