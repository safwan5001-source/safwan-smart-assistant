"""BASHT B1/B2: photos on a turn, files out, «محادثة جديدة», search, and the history/run shapes (ids, media, reset rows, steps)."""
import base64
import io
import json
import time
from urllib.error import HTTPError

import pytest
from fastapi.testclient import TestClient

import app.service_auth as sa
from app import basht_chat as bc
from app.audit import audit_log
from app.main import app
from app.service_auth import MemoryNonceStore, sign

SECRET = "unit-test-secret-0123456789abcdef-0123456789abcdef"
TOKEN = "app-token-0123456789abcdef0123456789abcd"
URL = "https://engine.example"
RUN = "d65fc949-4113-4cbe-a1a1-29f47545d14c"
KEY = "agent:main:app:owner"
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x01" * 60).decode()
REF = "0123456789abcdef0123456789abcdef"


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
    audit_log.clear()


class _Res(io.BytesIO):
    def __init__(self, data: bytes, headers: dict | None = None):
        super().__init__(data)
        self.headers = headers or {"Content-Type": "application/json"}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _Headers(dict):
    def get(self, k, d=None):  # case-insensitive like http.client.HTTPMessage
        return next((v for kk, v in self.items() if kk.lower() == k.lower()), d)


@pytest.fixture
def engine(monkeypatch):
    calls, replies = [], {}

    def fake(req, timeout):
        calls.append({"url": req.full_url, "method": req.get_method(), "auth": req.get_header("Authorization"),
                      "body": json.loads(req.data) if req.data else None, "timeout": timeout})
        path = req.full_url.removeprefix(URL + "/app/v1")
        for prefix, r in replies.items():
            if path.startswith(prefix):
                if isinstance(r, Exception):
                    raise r
                if isinstance(r, tuple):
                    return _Res(r[0], _Headers(r[1]))
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


def _http_error(code: int, error: str):
    return HTTPError(URL, code, "x", {}, io.BytesIO(json.dumps({"ok": False, "error": error}).encode()))


def test_unsigned_calls_never_reach_the_engine(client, engine):
    calls, _ = engine
    for path in ("send-media", "media", "new", "search"):
        assert client.post(f"/internal/v1/basht/{path}", json={}).status_code == 401
    assert calls == []


def test_send_media_forwards_photos_on_the_turn_and_audits_sizes_only(client, engine):
    calls, replies = engine
    replies["/send"] = {"ok": True, "runId": RUN}
    r = call(client, "POST", "/internal/v1/basht/send-media", {"message": " صف الصورة ", "images": [{"mime": "image/png", "data": PNG}],
                                                                 "sessionKey": "agent:main:main"})
    assert r.status_code == 200 and r.json() == {"run_id": RUN}
    assert calls[0]["url"] == f"{URL}/app/v1/send" and calls[0]["auth"] == f"Bearer {TOKEN}"
    assert calls[0]["body"] == {"message": "صف الصورة", "images": [{"mime": "image/png", "data": PNG}]}
    entry = audit_log.recent(1)[0]
    assert entry["event"] == "basht.send" and entry["images"] == 1 and entry["chars"] == 9 and entry["image_bytes"] > 0
    assert PNG not in json.dumps(entry) and "صف" not in json.dumps(entry)


@pytest.mark.parametrize("images,code", [
    ([{"mime": "image/svg+xml", "data": PNG}], "unsupported_image"),
    ([{"mime": "image/png", "data": "not*base64"}], "bad_request"),
    ([{"mime": "image/png", "data": base64.b64encode(b"x" * (10 * 1024 * 1024 + 1)).decode()}], "image_too_large"),
    ([{"mime": "image/png", "data": base64.b64encode(b"x" * 4_920_000).decode()}] * 3, "images_too_large"),  # just over 14 MiB decoded, under the 19 MiB body
])
def test_send_media_refuses_bad_photos_before_the_engine(client, engine, images, code):
    calls, _ = engine
    r = call(client, "POST", "/internal/v1/basht/send-media", {"message": "x", "images": images})
    assert r.status_code == 400 and r.json()["detail"]["code"] == code
    assert calls == []


def test_send_media_limits_count_and_needs_a_photo(client, engine):
    calls, _ = engine
    assert call(client, "POST", "/internal/v1/basht/send-media", {"message": "x", "images": [{"mime": "image/png", "data": PNG}] * 9}).status_code == 422
    assert call(client, "POST", "/internal/v1/basht/send-media", {"message": "x", "images": []}).status_code == 422
    assert calls == []


def test_send_media_passes_the_engines_refusal_codes_only(client, engine):
    _, replies = engine
    replies["/send"] = _http_error(400, "image_too_large")
    r = call(client, "POST", "/internal/v1/basht/send-media", {"message": "x", "images": [{"mime": "image/png", "data": PNG}]})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "image_too_large"
    replies["/send"] = _http_error(400, "internal secret text")
    r = call(client, "POST", "/internal/v1/basht/send-media", {"message": "x", "images": [{"mime": "image/png", "data": PNG}]})
    assert r.json()["detail"]["code"] == "bad_request"
    replies["/send"] = _http_error(409, "busy")
    assert call(client, "POST", "/internal/v1/basht/send-media", {"message": "x", "images": [{"mime": "image/png", "data": PNG}]}).status_code == 409


def test_photo_body_cap_is_only_raised_for_the_photo_route(client, engine):
    big = {"message": "x" * 10, "pad": "y" * (2 * 1024 * 1024)}
    assert call(client, "POST", "/internal/v1/basht/history", big).status_code == 413
    huge = {"message": "x", "images": [{"mime": "image/png", "data": "A" * (20 * 1024 * 1024)}]}
    assert call(client, "POST", "/internal/v1/basht/send-media", huge).status_code == 413


def test_media_streams_allowlisted_bytes_with_fixed_headers(client, engine):
    calls, replies = engine
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 10
    replies["/media"] = (png, {"Content-Type": "image/png", "Content-Disposition": "attachment; filename*=UTF-8''..%2Fchart%20one.png",
                               "Set-Cookie": "x=1"})
    r = call(client, "POST", "/internal/v1/basht/media", {"key": KEY, "msg": "msg-app-02", "ref": REF})
    assert r.status_code == 200 and r.content == png
    assert r.headers["content-type"] == "image/png" and r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-disposition"] == "attachment; filename*=UTF-8''_chart%20one.png"
    assert "set-cookie" not in r.headers
    assert calls[0]["url"] == f"{URL}/app/v1/media?key=agent%3Amain%3Aapp%3Aowner&msg=msg-app-02&ref={REF}"
    entry = audit_log.recent(1)[0]
    assert entry == {**entry, "event": "basht.media", "status": "ok", "type": "image/png", "bytes": len(png)} and "chart" not in json.dumps(entry)


def test_media_refuses_types_outside_the_allowlist_and_bad_ids(client, engine):
    calls, replies = engine
    replies["/media"] = (b"<html>", {"Content-Type": "text/html"})
    assert call(client, "POST", "/internal/v1/basht/media", {"key": KEY, "msg": "msg-app-02", "ref": REF}).status_code == 415
    for body in ({"key": KEY, "msg": "../../x", "ref": REF}, {"key": KEY, "msg": "msg-app-02", "ref": "Z" * 32}, {"key": "bad key", "msg": "msg-app-02", "ref": REF}):
        assert call(client, "POST", "/internal/v1/basht/media", body).status_code in (400, 422)
    assert len(calls) == 1
    replies["/media"] = _http_error(404, "not_found")
    assert call(client, "POST", "/internal/v1/basht/media", {"key": KEY, "msg": "msg-app-02", "ref": REF}).status_code == 404


def test_media_size_cap(client, engine, monkeypatch):
    _, replies = engine
    from app import basht_media as bm
    monkeypatch.setattr(bm, "MAX_MEDIA_BYTES", 8)
    replies["/media"] = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 10, {"Content-Type": "image/png"})
    assert call(client, "POST", "/internal/v1/basht/media", {"key": KEY, "msg": "msg-app-02", "ref": REF}).status_code == 502


def test_new_conversation_and_audit(client, engine):
    calls, replies = engine
    replies["/new"] = {"ok": True, "at": 1795771065897, "earlier": True, "entry": {"sessionFile": "/data/secret"}}
    r = call(client, "POST", "/internal/v1/basht/new", {"key": "agent:main:main"})
    assert r.status_code == 200 and r.json() == {"at": 1795771065897, "earlier": True}
    assert calls[0]["body"] == {} and calls[0]["timeout"] >= 30
    assert audit_log.recent(1)[0]["event"] == "basht.new"
    replies["/new"] = _http_error(409, "busy")
    assert call(client, "POST", "/internal/v1/basht/new").status_code == 409


def test_search_shapes_results_and_never_audits_the_query(client, engine):
    calls, replies = engine
    replies["/search"] = {"ok": True, "results": [
        {"key": KEY, "label": "التطبيق", "messageId": "msg-app-01", "role": "assistant", "at": 1795771033423, "snippet": "التقرير جاهز", "extra": "x"},
        {"key": "bad key", "messageId": "msg-app-02", "role": "user", "snippet": "x"},
        {"key": KEY, "messageId": "msg-app-03", "role": "toolResult", "snippet": "tool"},
    ]}
    r = call(client, "POST", "/internal/v1/basht/search", {"q": "التقرير"})
    assert r.status_code == 200
    assert r.json() == {"results": [{"key": KEY, "label": "التطبيق", "message_id": "msg-app-01", "role": "assistant", "at": 1795771033423, "snippet": "التقرير جاهز"}]}
    assert calls[0]["url"].startswith(f"{URL}/app/v1/search?q=%D8")
    assert "التقرير" not in json.dumps(audit_log.recent(1)[0])
    assert call(client, "POST", "/internal/v1/basht/search", {"q": "x" * 201}).status_code == 422


def test_history_user_rows_carry_a_valid_run_id_and_nothing_else_of_the_kind(client, engine):
    _, replies = engine
    good = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    replies["/history"] = {"ok": True, "messages": [
        {"id": "msg-app-01", "role": "user", "text": "a", "at": 1, "runId": good},
        {"id": "msg-app-02", "role": "user", "text": "b", "at": 2, "runId": "not-a-run"},
        {"id": "msg-app-03", "role": "user", "text": "c", "at": 3, "runId": good.upper()},
        {"id": "msg-app-04", "role": "user", "text": "d", "at": 4, "runId": {"x": 1}},
        {"id": "msg-app-05", "role": "user", "text": "e", "at": 5},
        {"id": "msg-app-06", "role": "assistant", "text": "f", "at": 6, "runId": good},
    ], "hasMore": False}
    rows = call(client, "POST", "/internal/v1/basht/history", {"key": KEY}).json()["messages"]
    assert [r.get("runId") for r in rows] == [good, None, None, None, None, None]  # owner rows only; malformed values are dropped
    assert all("runId" not in r for r in rows[1:])  # absent, not null


def test_history_rows_carry_ids_media_and_reset_boundaries(client, engine):
    calls, replies = engine
    replies["/history"] = {"ok": True, "messages": [
        {"role": "system", "kind": "reset", "text": "", "at": 1, "id": "reset-row-1", "media": []},
        {"role": "assistant", "text": "النتيجة", "at": 2, "id": "msg-app-02", "provider": "mock", "model": "echo", "media": [
            {"ref": REF, "kind": "image", "name": "chart.png", "mime": "image/png", "size": 10, "available": True, "path": "/data/x.png"},
            {"ref": "bad", "kind": "image"},
            {"ref": REF, "kind": "file", "name": "x.exe", "mime": "application/x-msdownload", "available": False},
            {"kind": "link", "name": "a.png", "url": "https://example.com/a.png"},
            {"kind": "link", "url": "http://insecure.example/a"},
        ]},
    ], "hasMore": False, "earlier": "reset-row-1", "nextOffset": None}
    r = call(client, "POST", "/internal/v1/basht/history", {"key": KEY})
    j = r.json()
    assert j["earlier"] == "reset-row-1"
    assert j["messages"][0] == {"role": "system", "kind": "reset", "text": "", "at": 1, "id": "reset-row-1", "media": []}
    media = j["messages"][1]["media"]
    assert media == [{"ref": REF, "kind": "image", "name": "chart.png", "mime": "image/png", "size": 10, "available": True},
                     {"ref": REF, "kind": "file", "name": "x.exe", "mime": None, "size": None, "available": False},
                     {"kind": "link", "name": "a.png", "url": "https://example.com/a.png"}]
    assert "/data/" not in r.text
    # cursors: forwarded as ids only, with a longer timeout (anchored reads use the engine's CLI)
    call(client, "POST", "/internal/v1/basht/history", {"key": KEY, "before": "msg-app-02.reset-row-1"})
    assert calls[-1]["url"].endswith("&before=msg-app-02.reset-row-1") and calls[-1]["timeout"] >= 30
    call(client, "POST", "/internal/v1/basht/history", {"key": KEY, "around": "msg-app-02"})
    assert calls[-1]["url"].endswith("&around=msg-app-02")
    assert call(client, "POST", "/internal/v1/basht/history", {"key": KEY, "before": "../x&key=agent:main:main"}).status_code == 422


def test_run_view_carries_tool_names_only(client, engine):
    _, replies = engine
    replies[f"/runs/{RUN}"] = {"ok": True, "runId": RUN, "status": "running", "text": "", "steps": [
        {"tool": "web_search", "done": True, "args": {"q": "secret"}}, {"tool": "rm -rf /"}, {"tool": "exec"}]}
    r = call(client, "GET", f"/internal/v1/basht/runs/{RUN}")
    assert r.json()["steps"] == [{"tool": "web_search", "done": True}, {"tool": "exec", "done": False}]
