"""BASHT Core C2/C4: the API's signed bridge to the engine's /app/v1 (owner conversations + live chat)."""
import io
import json
import time
from urllib.error import HTTPError, URLError

import pytest
from fastapi.testclient import TestClient

import app.service_auth as sa
from app import basht_chat as bc
from app.main import app
from app.service_auth import MemoryNonceStore, sign

SECRET = "unit-test-secret-0123456789abcdef-0123456789abcdef"
TOKEN = "app-token-0123456789abcdef0123456789abcd"
URL = "https://engine.example"
RUN = "d65fc949-4113-4cbe-a1a1-29f47545d14c"


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_SECRET", SECRET)
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    monkeypatch.setenv("BASHT_CORE_URL", URL)
    monkeypatch.setenv("BASHT_APP_TOKEN", TOKEN)
    for var in ("SERVICE_AUTH_SECRET_PREVIOUS", "APP_DATABASE_URL", "DATABASE_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())
    bc.reset_limits()


class _Res(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def engine(monkeypatch):
    """Fake engine bridge: records every request; answers from `replies[path-prefix]`."""
    calls, replies = [], {}

    def fake(req, timeout):
        calls.append({"url": req.full_url, "method": req.get_method(), "auth": req.get_header("Authorization"),
                      "body": json.loads(req.data) if req.data else None, "timeout": timeout})
        path = req.full_url.removeprefix(URL + "/app/v1")
        for prefix, r in replies.items():
            if path.startswith(prefix):
                if isinstance(r, Exception):
                    raise r
                return _Res(json.dumps(r).encode())
        raise AssertionError(f"unexpected engine call {path}")

    monkeypatch.setattr(bc, "urlopen", fake)
    return calls, replies


def call(client, method, target, body=None):
    raw = json.dumps(body).encode() if body is not None else b""
    ts, nonce = int(time.time()), f"nonce{time.monotonic_ns():020d}"[-24:]
    h = {"x-svc-ts": str(ts), "x-svc-nonce": nonce, "x-svc-sig": sign(SECRET.encode(), method, target, ts, nonce, raw)}
    if body is not None:
        h["content-type"] = "application/json"
    return client.request(method, target, content=raw or None, headers=h)


@pytest.fixture
def client():
    return TestClient(app)


def test_unsigned_calls_are_refused_and_never_reach_the_engine(client, engine):
    calls, _ = engine
    assert client.get("/internal/v1/basht/sessions").status_code == 401
    assert client.post("/internal/v1/basht/send", json={"message": "x"}).status_code == 401
    assert calls == []


def test_sessions_are_shaped_and_the_token_only_goes_to_the_engine(client, engine):
    calls, replies = engine
    replies["/sessions"] = {"ok": True, "sessions": [
        {"key": "agent:main:app:owner", "label": "التطبيق", "channel": "app", "updatedAt": 5, "writable": True, "secret": "x"},
        {"key": "not a key", "label": "bad"}]}
    r = call(client, "GET", "/internal/v1/basht/sessions")
    assert r.status_code == 200
    assert r.json() == {"sessions": [{"key": "agent:main:app:owner", "label": "التطبيق", "channel": "app", "updated_at": 5, "writable": True}]}
    assert calls[0]["url"] == URL + "/app/v1/sessions" and calls[0]["auth"] == f"Bearer {TOKEN}"
    assert TOKEN not in r.text


def test_history_passes_the_key_encoded_and_rejects_malformed_keys(client, engine):
    calls, replies = engine
    replies["/history"] = {"ok": True, "messages": [{"role": "user", "text": "مرحبا", "at": 1}, {"role": "tool", "text": "x"}], "hasMore": False}
    r = call(client, "POST", "/internal/v1/basht/history", {"key": "agent:main:whatsapp:direct:+9665", "limit": 20})
    assert r.status_code == 200 and r.json()["messages"] == [{"role": "user", "text": "مرحبا", "at": 1}]
    assert calls[0]["url"] == URL + "/app/v1/history?key=agent%3Amain%3Awhatsapp%3Adirect%3A%2B9665&limit=20"
    assert call(client, "POST", "/internal/v1/basht/history", {"key": "../setup"}).status_code == 400


def test_send_starts_a_run_audits_length_only_and_maps_engine_errors(client, engine):
    from app.audit import audit_log
    audit_log.clear()
    calls, replies = engine
    replies["/send"] = {"ok": True, "runId": RUN}
    r = call(client, "POST", "/internal/v1/basht/send", {"message": "  جهّز تقرير اليوم  "})
    assert r.status_code == 200 and r.json() == {"run_id": RUN}
    assert calls[-1]["body"] == {"message": "جهّز تقرير اليوم"} and calls[-1]["method"] == "POST"
    entry = audit_log.recent(1)[0]
    assert entry["event"] == "basht.send" and entry["status"] == "started" and entry["chars"] == 16
    assert "تقرير" not in json.dumps(entry, ensure_ascii=False)
    replies["/send"] = HTTPError(URL, 409, "busy", {}, None)
    r = call(client, "POST", "/internal/v1/basht/send", {"message": "ثانية"})
    assert r.status_code == 409 and r.json()["detail"] == {"code": "busy"}
    replies["/send"] = URLError("down")
    assert call(client, "POST", "/internal/v1/basht/send", {"message": "ثالثة"}).status_code == 502


def test_send_is_rate_limited_and_bounded(client, engine):
    _, replies = engine
    replies["/send"] = {"ok": True, "runId": RUN}
    assert call(client, "POST", "/internal/v1/basht/send", {"message": "x" * 8001}).status_code == 422
    for _ in range(bc.SEND_PER_MINUTE):
        assert call(client, "POST", "/internal/v1/basht/send", {"message": "x"}).status_code == 200
    assert call(client, "POST", "/internal/v1/basht/send", {"message": "x"}).status_code == 429


def test_run_view_and_stop(client, engine):
    _, replies = engine
    replies[f"/runs/{RUN}/stop"] = {"ok": True}
    replies[f"/runs/{RUN}"] = {"ok": True, "runId": RUN, "status": "running", "text": "جارٍ", "error": None}
    r = call(client, "GET", f"/internal/v1/basht/runs/{RUN}")
    assert r.json() == {"run_id": RUN, "status": "running", "text": "جارٍ", "failed": False}
    assert call(client, "POST", f"/internal/v1/basht/runs/{RUN}/stop", {}).status_code == 200
    assert call(client, "GET", "/internal/v1/basht/runs/not-a-uuid").status_code == 404


def test_unconfigured_without_token_or_https(client, engine, monkeypatch):
    calls, _ = engine
    monkeypatch.setenv("BASHT_APP_TOKEN", "short")
    assert call(client, "GET", "/internal/v1/basht/sessions").status_code == 503
    monkeypatch.setenv("BASHT_APP_TOKEN", TOKEN)
    monkeypatch.setenv("BASHT_CORE_URL", "http://engine.example")
    assert call(client, "GET", "/internal/v1/basht/sessions").status_code == 503
    assert calls == []
    assert bc.configured({"BASHT_CORE_URL": URL, "BASHT_APP_TOKEN": TOKEN}) is True
    assert bc.configured({"BASHT_CORE_URL": URL}) is False


def test_a_redirect_is_never_followed_with_the_token(client, monkeypatch):
    """The real opener (not the test seam): a 302 from the engine becomes 502, and the Location is never requested."""
    import http.server
    import threading
    hits = []

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append((self.path, self.headers.get("Authorization")))
            self.send_response(302)
            self.send_header("Location", "/stolen")
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        from urllib.error import HTTPError as E
        req = bc.Request(f"http://127.0.0.1:{srv.server_address[1]}/app/v1/sessions", headers={"Authorization": f"Bearer {TOKEN}"})
        with pytest.raises(E) as exc:
            bc.urlopen(req, timeout=5)
        assert exc.value.code == 302
        assert [p for p, _ in hits] == ["/app/v1/sessions"], "the redirect target must never be requested"
    finally:
        srv.shutdown()
