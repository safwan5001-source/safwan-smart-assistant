from fastapi.testclient import TestClient
from app.main import app


def test_browser_read_requires_token_and_allowlisted_url(monkeypatch):
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "x" * 40)
    monkeypatch.delenv("BROWSER_SERVICE_URL", raising=False)
    client = TestClient(app)
    endpoint = "/internal/browser/read"
    assert client.post(endpoint, json={}).status_code == 401
    assert client.post(endpoint, json={}, headers={"Authorization": "Bearer wrong"}).status_code == 401
    auth = {"Authorization": "Bearer " + "x" * 40}
    for url in ("https://evil.test", "https://example.com/?x=1", "http://example.com", "https://example.com.evil.test"):
        assert client.post(endpoint, json={"url": url}, headers=auth).status_code == 400
    assert client.post(endpoint, json={}, headers=auth).status_code == 503


def test_browser_read_returns_bounded_private_result(monkeypatch):
    import json
    import io
    from app import main

    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "x" * 40)
    monkeypatch.setenv("BROWSER_SERVICE_URL", "http://safwan-browser.railway.internal:8080")
    data = {"ok": True, "title": "Example Domain", "url": "https://example.com/",
            "excerpt": "Example", "screenshot": {"mimeType": "image/jpeg", "base64": "abcd"}}
    class FakeResponse(io.BytesIO):
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.close()
    monkeypatch.setattr(main.urllib_request, "urlopen",
                        lambda request, timeout: FakeResponse(json.dumps(data).encode()))
    response = TestClient(app).post("/internal/browser/read", json={},
                                    headers={"Authorization": "Bearer " + "x" * 40})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "title": "Example Domain", "url": "https://example.com/",
                               "excerpt": "Example", "screenshot": {"mimeType": "image/jpeg", "base64": "abcd"}}
