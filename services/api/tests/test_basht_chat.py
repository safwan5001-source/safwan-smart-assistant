"""BASHT Core C2/C4: the API's signed bridge to the engine's /app/v1 (owner conversations + live chat)."""
import io
import json
import time
from urllib.error import HTTPError, URLError

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
    assert r.status_code == 200 and r.json()["messages"] == [{"role": "user", "text": "مرحبا", "at": 1, "id": None, "media": []}]  # B1/B2 fields
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
    assert r.json() == {"run_id": RUN, "status": "running", "text": "جارٍ", "failed": False, "first_token_ms": None, "total_ms": None, "steps": []}
    assert call(client, "POST", f"/internal/v1/basht/runs/{RUN}/stop", {}).status_code == 200
    assert call(client, "GET", "/internal/v1/basht/runs/not-a-uuid").status_code == 404


def test_failed_run_carries_a_short_error_code_only(client, engine):
    _, replies = engine
    replies[f"/runs/{RUN}"] = {"ok": True, "runId": RUN, "status": "error", "text": "x", "errorCode": "rate_limited"}
    assert call(client, "GET", f"/internal/v1/basht/runs/{RUN}").json()["error_code"] == "rate_limited"
    for bad in ("Rate Limited", "HTTP 429 usage_limit_reached", "x" * 80, 429, None):  # never engine text, never on a non-error run
        replies[f"/runs/{RUN}"] = {"ok": True, "runId": RUN, "status": "error", "text": "x", "errorCode": bad}
        assert "error_code" not in call(client, "GET", f"/internal/v1/basht/runs/{RUN}").json()
    replies[f"/runs/{RUN}"] = {"ok": True, "runId": RUN, "status": "done", "text": "x", "errorCode": "rate_limited"}
    assert "error_code" not in call(client, "GET", f"/internal/v1/basht/runs/{RUN}").json()


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


# ── Model control (M) ──────────────────────────────────────────────────────
def _err(code: int, body: dict) -> HTTPError:
    return HTTPError(URL, code, "x", {}, io.BytesIO(json.dumps(body).encode()))


MODEL_STATE = {"ok": True, "sessionKey": "agent:main:app:owner",
               "model": {"id": "anthropic/claude-sonnet-4-5", "provider": "anthropic", "model": "claude-sonnet-4-5", "source": "override"},
               "thinking": {"level": "low", "default": "medium", "effective": "low", "levels": ["off", "low", "medium", "high", "Bad Level!"]},
               "fast": {"supported": False, "enabled": False, "source": "default"},
               "usage": {"inputTokens": 1200, "outputTokens": 300, "contextTokens": 1500, "contextWindow": 200000},
               "lastReply": {"provider": "openai", "model": "gpt-5", "at": 9, "fallback": {"from": "anthropic/claude-sonnet-4-5", "to": "openai/gpt-5", "reason": "server_error"}},
               "fallback": {"from": "anthropic/claude-sonnet-4-5", "to": "openai/gpt-5", "reason": "server_error", "at": 8},
               "lastRun": {"runId": RUN, "status": "done", "startedAt": 1, "firstTokenMs": 812, "totalMs": 2400},
               "baseUrl": "http://10.0.0.1/secret"}


def test_models_are_shaped_with_only_engine_capabilities(client, engine):
    calls, replies = engine
    replies["/models"] = {"ok": True, "fetchedAt": 5, "models": [
        {"id": "anthropic/claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "provider": "anthropic", "available": True, "contextWindow": 200000,
         "reasoning": True, "thinkingLevels": ["off", "low", "<script>"], "supportsFastMode": False, "supportsTools": True,
         "input": ["text", "image", "telepathy"], "selectable": True, "apiKey": "sk-never", "baseUrl": "http://10.0.0.1"},
        {"id": "bad id with spaces", "name": "x"}, "junk"]}
    r = call(client, "GET", "/internal/v1/basht/models")
    assert r.status_code == 200
    body = r.json()
    assert [m["id"] for m in body["models"]] == ["anthropic/claude-sonnet-4-5"]
    m = body["models"][0]
    assert m["thinking_levels"] == ["off", "low"] and m["input"] == ["text", "image"] and m["fast_mode"] is False and m["tools"] is True
    assert "sk-never" not in r.text and "10.0.0.1" not in r.text and "apiKey" not in r.text
    assert calls[0]["url"] == URL + "/app/v1/models" and calls[0]["auth"] == f"Bearer {TOKEN}"


def test_model_state_reports_the_real_reply_model_fallback_and_latency(client, engine):
    _, replies = engine
    replies["/model"] = MODEL_STATE
    r = call(client, "GET", "/internal/v1/basht/model")
    assert r.status_code == 200
    j = r.json()
    assert j["model"] == {"id": "anthropic/claude-sonnet-4-5", "provider": "anthropic", "source": "override"}
    assert j["thinking"]["levels"] == ["off", "low", "medium", "high"]
    assert j["last_reply"]["model"] == "gpt-5" and j["last_reply"]["fallback"]["reason"] == "server_error"
    assert j["fallback"] == {"from": "anthropic/claude-sonnet-4-5", "to": "openai/gpt-5", "reason": "server_error", "at": 8}
    assert j["last_run"] == {"status": "done", "first_token_ms": 812, "total_ms": 2400}
    assert j["usage"]["context_window"] == 200000 and "10.0.0.1" not in r.text


def test_model_changes_pass_validated_values_and_are_audited(client, engine):
    from app.audit import audit_log
    calls, replies = engine
    replies["/model"] = {"ok": True, "model": {"id": "openai/gpt-5"}}
    replies["/thinking"] = {"ok": True}
    replies["/fast"] = {"ok": True}
    assert call(client, "POST", "/internal/v1/basht/model", {"model": "openai/gpt-5"}).json() == {"model": "openai/gpt-5"}
    assert call(client, "POST", "/internal/v1/basht/thinking", {"level": "high"}).json() == {"level": "high"}
    assert call(client, "POST", "/internal/v1/basht/thinking", {"level": "default"}).json() == {"level": None}
    assert call(client, "POST", "/internal/v1/basht/fast", {"mode": "on"}).json() == {"mode": "on"}
    assert [c["body"] for c in calls] == [{"model": "openai/gpt-5"}, {"level": "high"}, {"level": "default"}, {"mode": "on"}]
    # settings writes wait their turn on the engine (one at a time across devices): a longer timeout than reads
    assert {c["timeout"] for c in calls} == {bc.SETTINGS_TIMEOUT} and bc.SETTINGS_TIMEOUT > bc.READ_TIMEOUT
    events = [e for e in audit_log.recent(10) if e["event"] == "basht.model"]
    assert {e["setting"] for e in events} >= {"model", "thinking", "fast"}
    # malformed values never reach the engine
    n = len(calls)
    assert call(client, "POST", "/internal/v1/basht/model", {"model": "a b"}).status_code == 400
    assert call(client, "POST", "/internal/v1/basht/thinking", {"level": "High Level"}).status_code == 400
    assert call(client, "POST", "/internal/v1/basht/fast", {"mode": "turbo"}).status_code == 422
    assert len(calls) == n


@pytest.mark.parametrize("code", ["unknown_model", "model_unavailable", "model_not_selectable", "unsupported_level", "fast_mode_unsupported", "rejected"])
def test_engine_refusals_keep_their_specific_code(client, engine, code):
    _, replies = engine
    replies["/thinking"] = _err(400, {"ok": False, "error": code})
    r = call(client, "POST", "/internal/v1/basht/thinking", {"level": "high"})
    assert r.status_code == 400 and r.json()["detail"]["code"] == code


def test_unknown_refusal_text_is_never_relayed(client, engine):
    _, replies = engine
    replies["/model"] = _err(400, {"ok": False, "error": "<b>internal detail</b>"})
    r = call(client, "POST", "/internal/v1/basht/model", {"model": "openai/gpt-5"})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "bad_request" and "internal" not in r.text


@pytest.mark.parametrize("err", [_err(404, {"error": "not_found"}), _err(503, {"ok": False, "error": "not_available"})])
def test_an_engine_without_model_control_reads_as_unavailable_not_as_an_outage(client, engine, err):
    _, replies = engine
    replies["/models"] = err
    r = call(client, "GET", "/internal/v1/basht/models")
    assert r.status_code == 400 and r.json()["detail"]["code"] == "model_control_unavailable"


def test_history_and_runs_carry_the_answering_model_and_latency(client, engine):
    _, replies = engine
    replies["/history"] = {"ok": True, "messages": [
        {"role": "user", "text": "hi", "at": 1, "model": "should-not-appear"},
        {"role": "assistant", "text": "yo", "at": 2, "provider": "mock", "model": "echo2",
         "fallback": {"from": "mock/echo", "to": "mock/echo2", "reason": "server_error"}}]}
    j = call(client, "POST", "/internal/v1/basht/history", {"key": "agent:main:app:owner"}).json()
    assert "model" not in j["messages"][0]
    assert j["messages"][1]["model"] == "echo2" and j["messages"][1]["fallback"]["to"] == "mock/echo2"
    replies[f"/runs/{RUN}"] = {"ok": True, "runId": RUN, "status": "done", "text": "x", "firstTokenMs": 700, "totalMs": 1900}
    r = call(client, "GET", f"/internal/v1/basht/runs/{RUN}").json()
    assert r["first_token_ms"] == 700 and r["total_ms"] == 1900


def test_openclaws_switch_notice_is_folded_into_the_reply_it_preceded(client, engine):
    _, replies = engine
    replies["/history"] = {"ok": True, "messages": [
        {"role": "user", "text": "اختبار", "at": 1},
        {"role": "assistant", "text": "Model switched from mock/echo to mock/echo2 (server_error)", "at": 2, "provider": "openclaw",
         "model": "delivery-mirror", "fallback": {"from": "mock/echo", "to": "mock/echo2", "reason": "server_error"}},
        {"role": "assistant", "text": "الرد", "at": 3, "provider": "mock", "model": "echo2"},
        {"role": "assistant", "text": "رد لاحق", "at": 4, "provider": "mock", "model": "echo"}]}
    msgs = call(client, "POST", "/internal/v1/basht/history", {"key": "agent:main:app:owner"}).json()["messages"]
    assert [m["text"] for m in msgs] == ["اختبار", "الرد", "رد لاحق"]  # the English notice is never shown as a BASHT reply
    assert msgs[1]["model"] == "echo2" and msgs[1]["fallback"] == {"from": "mock/echo", "to": "mock/echo2", "reason": "server_error", "at": None}
    assert "fallback" not in msgs[2]  # only the reply that the switch happened for


def test_only_the_switch_notice_is_folded_other_openclaw_deliveries_stay(client, engine):
    _, replies = engine
    replies["/history"] = {"ok": True, "messages": [
        {"role": "assistant", "text": "تذكير: اجتماع الساعة 4", "at": 1, "provider": "openclaw", "model": "delivery-mirror"},
        {"role": "user", "text": "س", "at": 2},
        {"role": "assistant", "text": "Model switched …", "at": 3, "provider": "openclaw", "model": "delivery-mirror",
         "fallback": {"from": "mock/echo", "to": "mock/echo2", "reason": "server_error"}},
        {"role": "user", "text": "سؤال لاحق", "at": 4},  # the switched turn produced no text reply
        {"role": "assistant", "text": "رد من الأساسي", "at": 5, "provider": "mock", "model": "echo"}]}
    msgs = call(client, "POST", "/internal/v1/basht/history", {"key": "agent:main:main"}).json()["messages"]
    assert [m["text"] for m in msgs] == ["تذكير: اجتماع الساعة 4", "س", "سؤال لاحق", "رد من الأساسي"]  # a cron delivery is kept
    assert "fallback" not in msgs[-1]  # a switch never lands on a later turn's reply


def test_an_automatic_fallback_pin_is_reported_as_such(client, engine):
    _, replies = engine
    replies["/model"] = {**MODEL_STATE, "model": {**MODEL_STATE["model"], "source": "fallback"}}
    assert call(client, "GET", "/internal/v1/basht/model").json()["model"]["source"] == "fallback"
    replies["/model"] = {**MODEL_STATE, "model": {**MODEL_STATE["model"], "source": "<x>"}}
    assert call(client, "GET", "/internal/v1/basht/model").json()["model"]["source"] == "default"


# ── Voice V2/V3: BASHT's own voice and transcription from the engine's config ───────────────────────────────────────
AUDIO = b"OggS" + bytes(range(256)) * 8  # 2 KiB of "audio"
SPEECH = b"ID3" + bytes(range(256)) * 40


class _Bin(io.BytesIO):
    def __init__(self, data: bytes, ctype: str):
        super().__init__(data)
        self.headers = {"Content-Type": ctype}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def voice(monkeypatch):
    """Fake engine voice routes: records raw requests; answers from `replies[path]` (bytes+type, a dict, or an exception)."""
    calls, replies = [], {}

    def fake(req, timeout):
        calls.append({"url": req.full_url, "method": req.get_method(), "auth": req.get_header("Authorization"),
                      "type": req.get_header("Content-type"), "data": req.data, "timeout": timeout})
        r = replies[req.full_url.removeprefix(URL + "/app/v1")]
        if isinstance(r, Exception):
            raise r
        if isinstance(r, dict):
            return _Bin(json.dumps(r).encode(), "application/json; charset=utf-8")
        return _Bin(*r)

    monkeypatch.setattr(bc, "urlopen", fake)
    return calls, replies


def raw_call(client, target, data: bytes, ctype: str, *, signed_body: bytes | None = None):
    ts, nonce = int(time.time()), f"nonce{time.monotonic_ns():020d}"[-24:]
    sig = sign(SECRET.encode(), "POST", target, ts, nonce, data if signed_body is None else signed_body)
    return client.post(target, content=data, headers={"x-svc-ts": str(ts), "x-svc-nonce": nonce, "x-svc-sig": sig, "content-type": ctype})


def _engine_error(code: int, error: str | None = None):
    body = json.dumps({"ok": False, "error": error}).encode() if error else b"<html>"
    return HTTPError(URL, code, "x", {}, io.BytesIO(body))


def test_speak_returns_bashts_audio_and_sends_only_the_text(client, voice):
    calls, replies = voice
    replies["/speak"] = (SPEECH, "audio/mpeg")
    audit_log.clear()
    r = call(client, "POST", "/internal/v1/basht/speak", {"text": "  مرحبا يا **صفوان**  "})
    assert r.status_code == 200
    assert r.content == SPEECH
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.headers["cache-control"] == "no-store"
    assert calls[0]["url"] == URL + "/app/v1/speak" and calls[0]["method"] == "POST"
    assert calls[0]["auth"] == f"Bearer {TOKEN}" and calls[0]["type"] == "application/json"
    assert json.loads(calls[0]["data"]) == {"text": "مرحبا يا **صفوان**"}, "no voice, provider or session from the app"
    entry = audit_log.recent(1)[0]
    assert entry["event"] == "basht.speak" and entry["status"] == "ok" and entry["chars"] == len("مرحبا يا **صفوان**") and entry["bytes"] == len(SPEECH)
    assert "صفوان" not in json.dumps(entry, ensure_ascii=False), "never the content"


def test_speak_validates_text_before_the_engine(client, voice):
    calls, _ = voice
    for body in [{}, {"text": ""}, {"text": "   "}, {"text": "ا" * 1501}, {"text": 5}]:
        assert call(client, "POST", "/internal/v1/basht/speak", body).status_code == 422, body
    assert calls == []


@pytest.mark.parametrize("reply,status,code", [
    (_engine_error(503, "voice_unavailable"), 400, "voice_unavailable"),   # engine voice not configured / tool not allowed
    (_engine_error(404, "not_found"), 400, "voice_unavailable"),           # an older engine bridge without voice
    (_engine_error(502, "engine_unavailable"), 502, "basht_unavailable"),
    (_engine_error(429, "rate_limited"), 429, "rate_limited"),
    (_engine_error(401), 502, "basht_unavailable"),
    (URLError("down"), 502, "basht_unavailable"),
    ((b"x" * (bc.MAX_SPEECH_BYTES + 1), "audio/mpeg"), 502, "basht_unavailable"),
    ((b"<html>not audio</html>", "text/html"), 502, "basht_unavailable"),
    ((b"", "audio/mpeg"), 502, "basht_unavailable"),
])
def test_speak_error_mapping(client, voice, reply, status, code):
    _, replies = voice
    replies["/speak"] = reply
    r = call(client, "POST", "/internal/v1/basht/speak", {"text": "مرحبا"})
    assert (r.status_code, r.json()["detail"]["code"]) == (status, code)


def test_speak_is_rate_limited_and_needs_configuration(client, voice, monkeypatch):
    _, replies = voice
    replies["/speak"] = (SPEECH, "audio/mpeg")
    for _ in range(bc.SPEAK_PER_MINUTE):
        assert call(client, "POST", "/internal/v1/basht/speak", {"text": "x"}).status_code == 200
    assert call(client, "POST", "/internal/v1/basht/speak", {"text": "x"}).status_code == 429
    bc.reset_limits()
    monkeypatch.delenv("BASHT_APP_TOKEN")
    r = call(client, "POST", "/internal/v1/basht/speak", {"text": "x"})
    assert (r.status_code, r.json()["detail"]["code"]) == (503, "basht_unconfigured")


def test_transcribe_passes_the_raw_signed_audio_and_returns_the_transcript(client, voice):
    calls, replies = voice
    replies["/transcribe"] = {"ok": True, "text": "  نص الملاحظة  "}
    audit_log.clear()
    r = raw_call(client, "/internal/v1/basht/transcribe", AUDIO, "audio/webm;codecs=opus")
    assert r.status_code == 200 and r.json() == {"text": "نص الملاحظة"}
    assert calls[0]["url"] == URL + "/app/v1/transcribe" and calls[0]["data"] == AUDIO
    assert calls[0]["type"] == "audio/webm" and calls[0]["auth"] == f"Bearer {TOKEN}"
    assert calls[0]["timeout"] >= 90
    entry = audit_log.recent(1)[0]
    assert entry["event"] == "basht.transcribe" and entry["status"] == "ok" and entry["bytes"] == len(AUDIO) and entry["chars"] == 11
    assert "ms" in entry and "الملاحظة" not in json.dumps(entry, ensure_ascii=False)


def test_transcribe_refuses_unsigned_tampered_wrong_type_tiny_and_oversized_audio(client, voice):
    calls, replies = voice
    replies["/transcribe"] = {"ok": True, "text": "x"}
    target = "/internal/v1/basht/transcribe"
    assert client.post(target, content=AUDIO, headers={"content-type": "audio/ogg"}).status_code == 401
    assert raw_call(client, target, AUDIO, "audio/ogg", signed_body=AUDIO[:-1] + b"!").status_code == 401
    for ctype in ["application/json", "text/plain", "application/octet-stream", "video/webm", "audio/aac"]:
        r = raw_call(client, target, AUDIO, ctype)
        assert (r.status_code, r.json()["detail"]["code"]) == (415, "unsupported_audio"), ctype
    r = raw_call(client, target, b"x" * 1023, "audio/ogg")
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "no_speech")
    assert raw_call(client, target, b"x" * (10 * 1024 * 1024 + 1), "audio/ogg").status_code == 413
    assert calls == []
    # a 2 MiB voice note is fine here, while every other signed route keeps its 1 MiB ceiling
    assert raw_call(client, target, b"x" * (2 * 1024 * 1024), "audio/mp4").status_code == 200
    big = json.dumps({"message": "x" * (2 * 1024 * 1024)}).encode()
    assert raw_call(client, "/internal/v1/basht/send", big, "application/json").status_code == 413


@pytest.mark.parametrize("reply,status,code", [
    ({"ok": True, "text": "   "}, 422, "no_speech"),
    ({"ok": True}, 422, "no_speech"),
    (_engine_error(422, "no_speech"), 422, "no_speech"),
    (_engine_error(503, "voice_unavailable"), 400, "voice_unavailable"),
    (_engine_error(404, "not_found"), 400, "voice_unavailable"),
    (_engine_error(413, "too_large"), 413, "too_large"),
    (_engine_error(415, "unsupported_audio"), 415, "unsupported_audio"),
    (_engine_error(429, "rate_limited"), 429, "rate_limited"),
    (_engine_error(502, "engine_unavailable"), 502, "basht_unavailable"),
    (TimeoutError(), 502, "basht_unavailable"),
    ((b"not json", "text/plain"), 502, "basht_unavailable"),
])
def test_transcribe_error_mapping(client, voice, reply, status, code):
    _, replies = voice
    replies["/transcribe"] = reply
    r = raw_call(client, "/internal/v1/basht/transcribe", AUDIO, "audio/ogg")
    assert (r.status_code, r.json()["detail"]["code"]) == (status, code)


def test_transcribe_caps_the_transcript_and_is_rate_limited(client, voice):
    _, replies = voice
    replies["/transcribe"] = {"ok": True, "text": "ب" * 9000}
    assert len(raw_call(client, "/internal/v1/basht/transcribe", AUDIO, "audio/ogg").json()["text"]) == bc.MAX_MESSAGE
    for _ in range(bc.TRANSCRIBE_PER_MINUTE - 1):
        assert raw_call(client, "/internal/v1/basht/transcribe", AUDIO, "audio/ogg").status_code == 200
    assert raw_call(client, "/internal/v1/basht/transcribe", AUDIO, "audio/ogg").status_code == 429
