"""BASHT voice: failure reasons carried (allowlisted) from the engine to the BFF, and GET /internal/v1/basht/voice-status."""
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
AUDIO = b"OggS" + bytes(range(256)) * 8
SPEECH = b"ID3" + bytes(range(256)) * 40


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_SECRET", SECRET)
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    monkeypatch.setenv("BASHT_CORE_URL", URL)
    monkeypatch.setenv("BASHT_APP_TOKEN", TOKEN)
    for var in ("SERVICE_AUTH_SECRET_PREVIOUS", "APP_DATABASE_URL", "DATABASE_URL", "BASHT_BRIDGE_SIGNING_SECRET"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())
    bc.reset_limits()
    audit_log.clear()


@pytest.fixture
def client():
    return TestClient(app)


class _Res(io.BytesIO):
    def __init__(self, data: bytes, ctype: str = "application/json"):
        super().__init__(data)
        self.headers = {"Content-Type": ctype}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def engine(monkeypatch):
    calls, replies = [], {}

    def fake(req, timeout):
        path = req.full_url.removeprefix(URL + "/app/v1")
        calls.append({"path": path, "method": req.get_method(), "timeout": timeout})
        r = replies[path]
        if isinstance(r, Exception):
            raise r
        if isinstance(r, tuple):
            return _Res(*r)
        return _Res(json.dumps(r).encode())

    monkeypatch.setattr(bc, "urlopen", fake)
    return calls, replies


def call(client, method, target, body=None):
    raw = json.dumps(body).encode() if body is not None else b""
    ts, nonce = int(time.time()), f"nonce{time.monotonic_ns():020d}"[-24:]
    h = {"x-svc-ts": str(ts), "x-svc-nonce": nonce, "x-svc-sig": sign(SECRET.encode(), method, target, ts, nonce, raw)}
    if body is not None:
        h["content-type"] = "application/json"
    return client.request(method, target, content=raw or None, headers=h)


def raw_call(client, target, data, ctype):
    ts, nonce = int(time.time()), f"nonce{time.monotonic_ns():020d}"[-24:]
    return client.post(target, content=data, headers={"x-svc-ts": str(ts), "x-svc-nonce": nonce,
                                                      "x-svc-sig": sign(SECRET.encode(), "POST", target, ts, nonce, data), "content-type": ctype})


def _err(code, **body):
    return HTTPError(URL, code, "x", {}, io.BytesIO(json.dumps({"ok": False, **body}).encode()))


# ── reasons ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("reason", list(bc.VOICE_REASONS))
def test_speak_carries_each_allowlisted_reason_with_unchanged_code_and_status(client, engine, reason):
    _, replies = engine
    replies["/speak"] = _err(503, error="voice_unavailable", reason=reason)
    r = call(client, "POST", "/internal/v1/basht/speak", {"text": "مرحبا"})
    assert r.status_code == 400 and r.json()["detail"] == {"code": "voice_unavailable", "reason": reason}
    assert audit_log.recent(1)[0]["reason"] == reason
    replies["/speak"] = _err(502, error="engine_unavailable", reason=reason)
    r = call(client, "POST", "/internal/v1/basht/speak", {"text": "مرحبا"})
    assert r.status_code == 502 and r.json()["detail"] == {"code": "basht_unavailable", "reason": reason}


@pytest.mark.parametrize("reason", ["/etc/passwd", "provider said: key sk-abc is invalid", "", None, 7, ["timeout"], {"a": 1}, "TIMEOUT", "timeout "])
def test_reasons_outside_the_allowlist_are_dropped(client, engine, reason):
    _, replies = engine
    replies["/speak"] = _err(503, error="voice_unavailable", reason=reason)
    r = call(client, "POST", "/internal/v1/basht/speak", {"text": "x"})
    assert r.status_code == 400 and r.json()["detail"] == {"code": "voice_unavailable"}
    assert "reason" not in audit_log.recent(1)[0]


def test_old_engines_and_other_codes_keep_their_generic_answers(client, engine):
    _, replies = engine
    for reply, status, code in [
        (HTTPError(URL, 404, "x", {}, io.BytesIO(b"<html>")), 400, "voice_unavailable"),
        (_err(429, error="rate_limited"), 429, "rate_limited"),
        (_err(502, error="engine_unavailable"), 502, "basht_unavailable"),
        (HTTPError(URL, 401, "x", {}, io.BytesIO(b"")), 502, "basht_unavailable"),
        (URLError("down"), 502, "basht_unavailable"),
    ]:
        replies["/speak"] = reply
        r = call(client, "POST", "/internal/v1/basht/speak", {"text": "x"})
        assert (r.status_code, r.json()["detail"]) == (status, {"code": code}), reply


def test_a_reason_never_carries_free_text_and_transcribe_gets_it_too(client, engine):
    _, replies = engine
    replies["/transcribe"] = _err(503, error="voice_unavailable", reason="unconfigured", message="provider key sk-secret rejected")
    r = raw_call(client, "/internal/v1/basht/transcribe", AUDIO, "audio/ogg")
    assert r.status_code == 400 and r.json()["detail"] == {"code": "voice_unavailable", "reason": "unconfigured"} and "sk-secret" not in r.text


def test_speak_success_is_unchanged(client, engine):
    _, replies = engine
    replies["/speak"] = (SPEECH, "audio/mpeg")
    r = call(client, "POST", "/internal/v1/basht/speak", {"text": "x"})
    assert r.status_code == 200 and r.content == SPEECH


# ── voice-status ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
STATUS = {"ok": True, "link": {"state": "up"}, "runs": {"active": 2},
          "voice": {"speak": "ready", "tts": {"provider": "elevenlabs", "voiceId": "SECRET-VOICE-ID"}},
          "features": ["voice.speak.v2", "signing.v1", "internal.debug", "../../x", 5]}


def test_voice_status_needs_a_signed_service_call(client, engine):
    calls, _ = engine
    assert client.get("/internal/v1/basht/voice-status").status_code == 401
    assert calls == []


def test_voice_status_has_a_fixed_shape_and_filters_everything_else(client, engine):
    calls, replies = engine
    replies["/status"] = STATUS
    r = call(client, "GET", "/internal/v1/basht/voice-status")
    assert r.status_code == 200 and r.json() == {"speak": "ready", "features": ["voice.speak.v2", "signing.v1"]}
    assert "SECRET-VOICE-ID" not in r.text and "runs" not in r.text
    assert calls == [{"path": "/status", "method": "GET", "timeout": bc.VOICE_STATUS_TIMEOUT}]
    e = audit_log.recent(1)[0]
    assert e["event"] == "basht.voice_status" and e["status"] == "ready" and "SECRET" not in json.dumps(e)


@pytest.mark.parametrize("state", ["ready", "degraded", "unconfigured", "mismatch", "unknown"])
def test_voice_status_states_and_allowlisted_reason(client, engine, state):
    _, replies = engine
    replies["/status"] = {"voice": {"speak": state, "reason": "identity_mismatch"}, "features": []}
    assert call(client, "GET", "/internal/v1/basht/voice-status").json() == {"speak": state, "reason": "identity_mismatch", "features": []}


def test_voice_status_drops_a_free_text_reason_and_an_unknown_state(client, engine):
    _, replies = engine
    replies["/status"] = {"voice": {"speak": "degraded", "reason": "ElevenLabs 401 for key sk-x"}}
    assert call(client, "GET", "/internal/v1/basht/voice-status").json() == {"speak": "degraded", "features": []}
    bc.reset_limits()
    replies["/status"] = {"voice": {"speak": "on fire"}, "features": ["voice.speak.v2"]}
    assert call(client, "GET", "/internal/v1/basht/voice-status").json() == {"speak": "unknown"}


@pytest.mark.parametrize("reply", [
    {"ok": True, "link": {"state": "up"}},                  # an older engine without the voice field
    {"voice": "ready"}, {"voice": None}, ["x"],
    _err(500, error="boom"), _err(404, error="not_found"), _err(401), _err(503, error="not_available"),
    URLError("down"), TimeoutError(), (b"not json", "application/json"),
])
def test_voice_status_is_unknown_with_http_200_on_any_failure(client, engine, reply):
    _, replies = engine
    replies["/status"] = reply
    r = call(client, "GET", "/internal/v1/basht/voice-status")
    assert r.status_code == 200 and r.json() == {"speak": "unknown"}


def test_voice_status_unconfigured_engine_is_unknown_not_an_error(client, monkeypatch):
    monkeypatch.delenv("BASHT_CORE_URL")
    r = call(client, "GET", "/internal/v1/basht/voice-status")
    assert r.status_code == 200 and r.json()["speak"] == "unknown"


def test_voice_status_is_cached_for_30_seconds_failures_only_briefly(client, engine, monkeypatch):
    calls, replies = engine
    t = [1000.0]
    monkeypatch.setattr(bc.time, "monotonic", lambda: t[0])
    replies["/status"] = {"voice": {"speak": "ready"}, "features": ["signing.v1"]}
    assert call(client, "GET", "/internal/v1/basht/voice-status").json()["speak"] == "ready"
    replies["/status"] = {"voice": {"speak": "degraded"}}
    t[0] += 29
    assert call(client, "GET", "/internal/v1/basht/voice-status").json()["speak"] == "ready" and len(calls) == 1
    t[0] += 2
    assert call(client, "GET", "/internal/v1/basht/voice-status").json()["speak"] == "degraded" and len(calls) == 2
    replies["/status"] = URLError("down")
    t[0] += 31
    assert call(client, "GET", "/internal/v1/basht/voice-status").json()["speak"] == "unknown" and len(calls) == 3
    replies["/status"] = {"voice": {"speak": "ready"}}
    t[0] += 1
    assert call(client, "GET", "/internal/v1/basht/voice-status").json()["speak"] == "unknown" and len(calls) == 3
    t[0] += 5
    assert call(client, "GET", "/internal/v1/basht/voice-status").json()["speak"] == "ready" and len(calls) == 4
