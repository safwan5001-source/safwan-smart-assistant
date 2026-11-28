"""BASHT Core Integration C2 + C4: the owner's conversations with BASHT and live chat, through the engine's app bridge.

    BFF (owner cookie) --HMAC--> /internal/v1/basht/* (this module) --HTTPS + BASHT_APP_TOKEN--> {BASHT_CORE_URL}/app/v1/*

- The engine side (openclaw-railway-template, src/app-bridge.js) holds the gateway token and fixes what is possible: reads of the
  owner's own conversations, and turns in the app's own session `app:owner`. This module only adds the app's own controls.
- BASHT_APP_TOKEN is a secret of THIS service only. It is never returned, logged or sent anywhere but the engine URL.
- Only fixed, shaped fields are passed back to the BFF; engine error text never is.
- Every send is audited (length only, never the text) and rate limited.
- Voice (V2/V3): /speak returns the reply spoken in BASHT's own voice (the engine's agent `tts` config: voice, model, instructions);
  /transcribe takes a raw voice note and returns the engine's transcript (its own audio config, as for WhatsApp). The app holds no
  voice-provider key and cannot choose a voice. Audio is never stored here; audits carry sizes and durations only, never content.
  A failed voice call may carry an allowlisted `reason` (VOICE_REASONS); GET /voice-status reports whether BASHT can speak (cached).
- Every engine call is signed by app/basht_signing.py when BASHT_BRIDGE_SIGNING_SECRET is set (optional, see that module).
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib import request as urllib_request
from urllib.request import Request

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi import Request as HttpRequest
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from .audit import audit_log
from .basht_core import ENV_VAR as URL_VAR
from .basht_signing import engine_request, ensure_signed
from .service_auth import MAX_AUDIO_BODY_BYTES, ServiceCall, require_service_call, require_service_call_audio

TOKEN_VAR = "BASHT_APP_TOKEN"
MIN_TOKEN = 32
MAX_MESSAGE = 8000
SEND_PER_MINUTE = 20
READ_TIMEOUT = 10.0
SETTINGS_TIMEOUT = 40.0  # model/thinking/fast writes are queued one at a time on the engine (two devices) and spawn its CLI
MAX_BYTES = 2 * 1024 * 1024
_KEY_RE = re.compile(r"^agent:[a-z0-9_-]{1,64}:[^\s]{1,200}$", re.I)
MODEL_REFUSALS = {"unknown_model", "model_unavailable", "model_not_selectable", "unsupported_level", "fast_mode_unsupported", "rejected"}
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$")
_LEVEL_RE = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
_RUN_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# ── voice ──
MAX_SPEAK = 1500               # the app splits longer replies on sentence boundaries; the engine enforces the same cap
MAX_SPEECH_BYTES = 4 * 1024 * 1024
MAX_AUDIO = MAX_AUDIO_BODY_BYTES  # 10 MiB voice note (the app also stops recording at 3 minutes)
MIN_AUDIO = 1024
SPEAK_PER_MINUTE = 30
TRANSCRIBE_PER_MINUTE = 20
SPEAK_TIMEOUT = 70.0           # the engine allows the provider 60 s
TRANSCRIBE_TIMEOUT = 100.0     # the engine's CLI is killed at 90 s
AUDIO_TYPES = {"audio/ogg", "audio/webm", "audio/mp4", "audio/x-m4a", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/wave"}
SPEECH_TYPES = {"audio/mpeg", "audio/ogg", "audio/wav"}

class _NoRedirect(urllib_request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any):  # noqa: ANN401
        return None  # never follow: a redirect would carry BASHT_APP_TOKEN to another place; it surfaces as an HTTPError (502)


_opener = urllib_request.build_opener(urllib_request.ProxyHandler({}), _NoRedirect)


def urlopen(req: Request, timeout: float):
    """Single seam for tests (monkeypatched). Never follows redirects, never uses an environment proxy."""
    return _opener.open(ensure_signed(req), timeout=timeout)  # ensure_signed: a request to the bridge can never leave unsigned by mistake


router = APIRouter(prefix="/internal/v1/basht", include_in_schema=False)

_lock = threading.Lock()
_sends: list[float] = []
_speaks: list[float] = []
_transcribes: list[float] = []
_status_cache: dict[str, tuple[float, Any, bool, float]] = {}  # engine /status, raw: (expires, json, failed, read-at) — one read serves voice-status AND engine-status


class EngineError(Exception):
    def __init__(self, status: int, code: str, reason: str | None = None):
        super().__init__(code)
        self.status, self.code, self.reason = status, code, reason

    @property
    def detail(self) -> dict[str, str]:
        """The error body the BFF sees: always `code`, plus an allowlisted `reason` when the engine gave one (voice only)."""
        return {"code": self.code, **({"reason": self.reason} if self.reason else {})}


def _config(env=os.environ) -> tuple[str, str] | None:
    base = (env.get(URL_VAR) or "").strip().rstrip("/")
    token = (env.get(TOKEN_VAR) or "").strip()
    u = urlparse(base)
    if not base or u.scheme != "https" or not u.netloc or u.username or u.password or len(token) < MIN_TOKEN:
        return None
    return base, token


def configured(env=os.environ) -> bool:
    return _config(env) is not None


def _call(method: str, path: str, body: dict | None = None, env=os.environ, timeout: float = READ_TIMEOUT) -> dict[str, Any]:
    cfg = _config(env)
    if cfg is None:
        raise EngineError(503, "basht_unconfigured")
    base, token = cfg
    data = json.dumps(body).encode() if body is not None else None
    req = engine_request(base, path, method=method, data=data, env=env,
                         headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "basht-app/1",
                                  **({"Content-Type": "application/json"} if data is not None else {})})
    try:
        with urlopen(req, timeout=timeout) as res:  # noqa: S310 - https only, checked in _config
            raw = res.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise EngineError(502, "basht_unavailable")
            return json.loads(raw)
    except HTTPError as e:
        code = {400: "bad_request", 404: "not_found", 409: "busy", 429: "rate_limited"}.get(e.code, "basht_unavailable")
        if e.code == 400:  # model control: the bridge's own refusal code, from a fixed list (never its text)
            try:
                specific = json.loads(e.read(4096)).get("error")
            except Exception:  # noqa: BLE001 - any unreadable body is a plain bad_request
                specific = None
            if specific in MODEL_REFUSALS:
                code = specific
        if e.code == 503:
            try:
                if json.loads(e.read(4096)).get("error") == "not_available":
                    raise EngineError(400, "model_control_unavailable") from None
            except EngineError:
                raise
            except Exception:  # noqa: BLE001
                pass
        raise EngineError(e.code if e.code in (400, 404, 409, 429) else 502, code) from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise EngineError(502, "basht_unavailable") from None


def _guard(fn):
    try:
        return fn()
    except EngineError as e:
        raise HTTPException(status_code=e.status, detail={"code": e.code}) from None


def _text(v: Any, cap: int = 64_000) -> str:
    return v[:cap] if isinstance(v, str) else ""


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 10**12 else None


def _num(v: Any) -> int | float | None:
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) < 10**15 else None


def _short(v: Any, cap: int = 200) -> str | None:
    if not isinstance(v, str):
        return None
    t = "".join(ch for ch in v if ch >= " " and ch != "\x7f").strip()
    return t[:cap] or None


def _levels(v: Any) -> list[str]:
    return [x for x in (v if isinstance(v, list) else []) if isinstance(x, str) and _LEVEL_RE.fullmatch(x)][:20]


def _fallback(v: Any) -> dict | None:
    if not isinstance(v, dict) or not (_short(v.get("from")) or _short(v.get("to"))):
        return None
    return {"from": _short(v.get("from")), "to": _short(v.get("to")), "reason": _short(v.get("reason"), 60), "at": _int(v.get("at"))}


def _is_switch_notice(m: dict) -> bool:
    """OpenClaw's model-switch notice: a transcript-only "delivery-mirror" message that the bridge marked with a fallback.
    Other delivery-mirror messages (scheduled deliveries, sub-agent results, plugin notices…) are real content and stay."""
    return m.get("provider") == "openclaw" and m.get("model") == "delivery-mirror" and isinstance(m.get("fallback"), dict)


def _reply_meta(m: dict) -> dict:
    """Which model actually wrote this reply (and a fallback record when OpenClaw switched models for it)."""
    out: dict[str, Any] = {"provider": _short(m.get("provider"), 100), "model": _short(m.get("model"))}
    fb = _fallback(m.get("fallback"))
    if fb:
        out["fallback"] = fb
    return out


def _model_row(r: Any) -> dict | None:
    if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not _MODEL_RE.fullmatch(r["id"]):
        return None
    return {
        "id": r["id"], "name": _short(r.get("name")) or r["id"], "provider": _short(r.get("provider"), 100),
        "provider_name": _short(r.get("providerName"), 100), "available": r.get("available") is True,
        "unavailable_reason": _short(r.get("unavailableReason")), "unavailable_until": _int(r.get("unavailableUntil")),
        "context_window": _int(r.get("contextWindow")), "reasoning": r.get("reasoning") is True,
        "thinking_levels": _levels(r.get("thinkingLevels")), "thinking_default": _short(r.get("thinkingDefault"), 40),
        "fast_mode": r.get("supportsFastMode") is True, "tools": r.get("supportsTools") if isinstance(r.get("supportsTools"), bool) else None,
        "input": [x for x in (r.get("input") if isinstance(r.get("input"), list) else []) if x in ("text", "image", "audio", "video", "document")],
        "recommended": r.get("recommended") is True, "selectable": r.get("selectable") is True,
    }


def _allow(bucket: list[float], limit: int, now: float) -> bool:
    with _lock:
        bucket[:] = [t for t in bucket if now - t < 60]
        if len(bucket) >= limit:
            return False
        bucket.append(now)
        return True


def _allow_send(now: float) -> bool:
    return _allow(_sends, SEND_PER_MINUTE, now)


def reset_limits() -> None:
    with _lock:
        _sends.clear()
        _speaks.clear()
        _transcribes.clear()
        _status_cache.clear()


def _run_view(j: dict) -> dict:
    from .basht_media import steps  # B1 tool progress (names only)
    status = j.get("status") if j.get("status") in ("running", "done", "error", "stopped") else "error"
    out = {"run_id": _text(j.get("runId"), 64), "status": status, "text": _text(j.get("text")), "failed": status == "error",
           "first_token_ms": _int(j.get("firstTokenMs")), "total_ms": _int(j.get("totalMs")), "steps": steps(j.get("steps"))}
    code = j.get("errorCode")  # additive: why a run failed ("rate_limited" …); a short lowercase token only, never engine text
    if status == "error" and isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,31}", code):
        out["error_code"] = code
    return out


@router.get("/sessions")
def sessions(_: ServiceCall = Depends(require_service_call)):
    j = _guard(lambda: _call("GET", "/sessions"))
    rows = j.get("sessions") if isinstance(j.get("sessions"), list) else []
    out = [{"key": _text(r.get("key"), 260), "label": _text(r.get("label"), 80), "channel": _text(r.get("channel"), 32),
            "updated_at": r.get("updatedAt") if isinstance(r.get("updatedAt"), int) else 0, "writable": r.get("writable") is True}
           for r in rows if isinstance(r, dict) and _KEY_RE.fullmatch(str(r.get("key", "")))]
    return {"sessions": out[:100]}


class HistoryBody(BaseModel):
    key: str = Field(min_length=1, max_length=260)
    limit: int = Field(50, ge=1, le=200)
    offset: int | None = Field(None, ge=0)
    # B1: earlier rows (also across «محادثة جديدة») by cursor, or a window around one message (a search hit). Ids only.
    before: str | None = Field(None, pattern=r"^[A-Za-z0-9_-]{6,100}(?:\.[A-Za-z0-9_-]{6,100})?$")
    around: str | None = Field(None, pattern=r"^[A-Za-z0-9_-]{6,100}$")


@router.post("/history")
def history(body: HistoryBody, _: ServiceCall = Depends(require_service_call)):
    """POST with a JSON body: the BFF only ever calls fixed /internal/v1/* paths (no query strings, see apps/web/server/backend.ts)."""
    if not _KEY_RE.fullmatch(body.key):
        raise HTTPException(status_code=400, detail={"code": "bad_request"})
    from .basht_media import cursor, row_extras
    q = f"/history?key={quote(body.key, safe='')}&limit={body.limit}" + (f"&offset={body.offset}" if body.offset is not None else "")
    if body.before or body.around:
        q += f"&before={body.before}" if body.before else f"&around={body.around}"
    # an anchored read runs through the engine's CLI (a few seconds)
    j = _guard(lambda: _call("GET", q, timeout=30.0 if body.before or body.around else READ_TIMEOUT))
    msgs = j.get("messages") if isinstance(j.get("messages"), list) else []
    out: list[dict] = []
    pending_fallback: dict | None = None
    for m in msgs:
        if isinstance(m, dict) and m.get("kind") == "reset":  # «محادثة جديدة»: a boundary, shown as a divider
            out.append({"role": "system", "kind": "reset", "text": "", "at": m.get("at") if isinstance(m.get("at"), int) else 0, **row_extras(m)})
            pending_fallback = None
            continue
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        if m.get("role") == "assistant" and _is_switch_notice(m):
            # OpenClaw records a model fallback as its own notice ("Model switched from … to …"). It is not BASHT's reply:
            # its record goes onto the reply that follows, and the notice itself is not shown as a message.
            pending_fallback = _fallback(m.get("fallback")) or pending_fallback
            continue
        if m.get("role") == "user":
            pending_fallback = None  # a switch belongs to the reply of ITS turn, never to a later one
        row = {"role": m.get("role"), "text": _text(m.get("text")), "at": m.get("at") if isinstance(m.get("at"), int) else 0, **row_extras(m)}
        if m.get("role") == "assistant":
            row.update(_reply_meta(m))
            if pending_fallback and "fallback" not in row:
                row["fallback"] = pending_fallback
            pending_fallback = None
        out.append(row)
    nxt = j.get("nextOffset")
    return {"key": body.key, "messages": out, "next_offset": nxt if isinstance(nxt, int) else None, "has_more": j.get("hasMore") is True,
            "earlier": cursor(j.get("earlier"))}


class SendBody(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_MESSAGE)


@router.post("/send")
def send(body: SendBody, _: ServiceCall = Depends(require_service_call)):
    msg = body.message.strip()
    if not msg:
        raise HTTPException(status_code=422, detail={"code": "empty_message"})
    if not _allow_send(time.monotonic()):
        audit_log.record("basht.send", status="rate_limited", chars=len(msg))
        raise HTTPException(status_code=429, detail={"code": "rate_limited"})
    try:
        j = _call("POST", "/send", {"message": msg})
    except EngineError as e:
        audit_log.record("basht.send", status=e.code, chars=len(msg))
        raise HTTPException(status_code=e.status, detail={"code": e.code}) from None
    run_id = _text(j.get("runId"), 64)
    if not _RUN_RE.fullmatch(run_id):
        raise HTTPException(status_code=502, detail={"code": "basht_unavailable"})
    audit_log.record("basht.send", status="started", chars=len(msg), run_id=run_id)
    return {"run_id": run_id}


@router.get("/runs/{run_id}")
def run(run_id: str, _: ServiceCall = Depends(require_service_call)):
    if not _RUN_RE.fullmatch(run_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    return _run_view(_guard(lambda: _call("GET", f"/runs/{run_id}")))


@router.post("/runs/{run_id}/stop")
def stop(run_id: str, _: ServiceCall = Depends(require_service_call)):
    if not _RUN_RE.fullmatch(run_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    _guard(lambda: _call("POST", f"/runs/{run_id}/stop", {}))
    audit_log.record("basht.stop", run_id=run_id)
    return {"ok": True}


# ── Model control (M): the app session's model, thinking level and fast mode, exactly as the engine offers them ──
# An engine without these routes (older bridge: 404) or without its gateway seam (503 not_available) reads as a domain answer,
# 400 model_control_unavailable, so the app hides the controls instead of reporting an outage.
def _model_guard(fn):
    try:
        return fn()
    except EngineError as e:
        code = "model_control_unavailable" if e.code in ("not_found", "model_control_unavailable") else e.code
        raise HTTPException(status_code=400 if code == "model_control_unavailable" else e.status, detail={"code": code}) from None


@router.get("/models")
def models(_: ServiceCall = Depends(require_service_call)):
    j = _model_guard(lambda: _call("GET", "/models"))
    rows = [m for m in (_model_row(r) for r in (j.get("models") if isinstance(j.get("models"), list) else [])) if m]
    return {"models": rows[:200], "fetched_at": _int(j.get("fetchedAt"))}


@router.get("/model")
def model(_: ServiceCall = Depends(require_service_call)):
    j = _model_guard(lambda: _call("GET", "/model"))
    m = j.get("model") if isinstance(j.get("model"), dict) else {}
    t = j.get("thinking") if isinstance(j.get("thinking"), dict) else {}
    f = j.get("fast") if isinstance(j.get("fast"), dict) else {}
    u = j.get("usage") if isinstance(j.get("usage"), dict) else {}
    r = j.get("lastReply") if isinstance(j.get("lastReply"), dict) else None
    run_ = j.get("lastRun") if isinstance(j.get("lastRun"), dict) else None
    mid = m.get("id") if isinstance(m.get("id"), str) and _MODEL_RE.fullmatch(m["id"]) else None
    return {
        "model": {"id": mid, "provider": _short(m.get("provider"), 100), "source": m.get("source") if m.get("source") in ("override", "fallback") else "default"},
        "thinking": {"level": _short(t.get("level"), 40), "default": _short(t.get("default"), 40), "effective": _short(t.get("effective"), 40),
                     "levels": _levels(t.get("levels"))},
        "fast": {"supported": f.get("supported") if isinstance(f.get("supported"), bool) else None,
                 "enabled": f.get("enabled") if isinstance(f.get("enabled"), bool) else None},
        "usage": {"input_tokens": _num(u.get("inputTokens")), "output_tokens": _num(u.get("outputTokens")),
                  "context_tokens": _num(u.get("contextTokens")), "context_window": _num(u.get("contextWindow"))},
        "last_reply": {**_reply_meta(r), "at": _int(r.get("at"))} if r else None,
        "fallback": _fallback(j.get("fallback")),
        "last_run": {"status": _short(run_.get("status"), 20), "first_token_ms": _int(run_.get("firstTokenMs")),
                     "total_ms": _int(run_.get("totalMs"))} if run_ else None,
    }


class ModelBody(BaseModel):
    model: str = Field(min_length=1, max_length=200)


class ThinkingBody(BaseModel):
    level: str = Field(min_length=1, max_length=40)


class FastBody(BaseModel):
    mode: str = Field(pattern=r"^(on|off|default)$")


def _set(kind: str, path: str, body: dict, value: str) -> dict:
    try:
        j = _call("POST", path, body, timeout=SETTINGS_TIMEOUT)
    except EngineError as e:
        code = "model_control_unavailable" if e.code in ("not_found", "model_control_unavailable") else e.code
        audit_log.record("basht.model", setting=kind, value=value, status=code)
        raise HTTPException(status_code=400 if code in MODEL_REFUSALS or code == "model_control_unavailable" else e.status, detail={"code": code}) from None
    audit_log.record("basht.model", setting=kind, value=value, status="ok")
    return j


@router.post("/model")
def set_model(body: ModelBody, _: ServiceCall = Depends(require_service_call)):
    want = body.model.strip()
    if want != "default" and not _MODEL_RE.fullmatch(want):
        raise HTTPException(status_code=400, detail={"code": "bad_request"})
    j = _set("model", "/model", {"model": want}, want)
    m = j.get("model") if isinstance(j.get("model"), dict) else {}
    return {"model": m.get("id") if isinstance(m.get("id"), str) and _MODEL_RE.fullmatch(m["id"]) else None}


@router.post("/thinking")
def set_thinking(body: ThinkingBody, _: ServiceCall = Depends(require_service_call)):
    level = body.level.strip()
    if not _LEVEL_RE.fullmatch(level):
        raise HTTPException(status_code=400, detail={"code": "bad_request"})
    _set("thinking", "/thinking", {"level": level}, level)
    return {"level": None if level == "default" else level}


@router.post("/fast")
def set_fast(body: FastBody, _: ServiceCall = Depends(require_service_call)):
    _set("fast", "/fast", {"mode": body.mode}, body.mode)
    return {"mode": body.mode}


# ── Voice (V2 speak · V3 voice notes): BASHT's own voice and transcription, both configured in the engine ──
# "Voice is not set up / not allowed on the engine" (bridge 503 voice_unavailable, or an older bridge: 404) is a domain answer,
# 400 voice_unavailable, like model_control_unavailable: the app explains it and falls back to browser dictation.
# Why the engine's voice failed, from a fixed list (anything else is dropped; engine text is never passed on). Additive to the codes.
VOICE_REASONS = ("identity_mismatch", "tool_denied", "unconfigured", "provider_error", "link_down", "timeout", "bad_audio", "engine_error",
                 "in_flight", "per_minute", "text_rejected", "tool_path_only", "tool_path_unavailable", "no_tts_config", "config_unreadable")
# must equal tests/fixtures/voice-contract.json (shared with the engine; tests compare)
_VOICE_ERRORS = {400: (400, "bad_request"), 413: (413, "too_large"), 415: (415, "unsupported_audio"), 422: (422, "no_speech"),
                 429: (429, "rate_limited")}


def _voice_call(path: str, data: bytes, content_type: str, *, timeout: float, max_bytes: int, env=os.environ) -> tuple[bytes, str]:
    """One POST to the engine's voice routes with a raw body. Returns (body, content type). Never follows redirects or proxies."""
    cfg = _config(env)
    if cfg is None:
        raise EngineError(503, "basht_unconfigured")
    base, token = cfg
    req = engine_request(base, path, method="POST", data=data, env=env,
                         headers={"Authorization": f"Bearer {token}", "Accept": "audio/*, application/json", "User-Agent": "basht-app/1",
                                  "Content-Type": content_type})
    try:
        with urlopen(req, timeout=timeout) as res:  # noqa: S310 - https only, checked in _config
            raw = res.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raise EngineError(502, "basht_unavailable")
            return raw, (res.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    except HTTPError as e:
        code = reason = None
        try:
            j = json.loads(e.read(4096))
            if isinstance(j, dict):
                code = j.get("error")
                reason = j.get("reason") if isinstance(j.get("reason"), str) and j.get("reason") in VOICE_REASONS else None
        except Exception:  # noqa: BLE001 - an unreadable body keeps the status mapping
            pass
        if (e.code >= 500 and code == "voice_unavailable") or e.code == 404:  # 404: an older engine without the voice routes
            raise EngineError(400, "voice_unavailable", reason) from None
        status, mapped = _VOICE_ERRORS.get(e.code, (502, "basht_unavailable"))
        raise EngineError(status, mapped, reason) from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise EngineError(502, "basht_unavailable") from None


# ── Voice status: can BASHT speak right now? (engine GET /app/v1/status -> voice.speak) ──
VOICE_SPEAK_STATES = ("ready", "degraded", "unconfigured", "mismatch", "unknown")
VOICE_FEATURES = ("voice.speak.v2", "voice.transcribe.v1", "voice.status.v1", "signing.v1")  # fixed allowlist: nothing else is passed on
VOICE_STATUS_TTL = 30.0        # one engine read per 30 s however often the app asks
VOICE_STATUS_FAIL_TTL = 5.0    # a failed read is remembered briefly (no hammering), not for 30 s
VOICE_STATUS_TIMEOUT = 5.0


def _voice_status_view(j: Any) -> dict[str, Any]:
    """The engine's status -> the one fixed shape. An older engine (no `voice` field) or anything unexpected reads as exactly `{speak: "unknown"}`."""
    voice = j.get("voice") if isinstance(j, dict) and isinstance(j.get("voice"), dict) else None
    speak = voice.get("speak") if voice else None
    if speak not in VOICE_SPEAK_STATES:
        return {"speak": "unknown"}
    out: dict[str, Any] = {"speak": speak}
    if voice.get("reason") in VOICE_REASONS:
        out["reason"] = voice["reason"]
    feats = j.get("features") if isinstance(j.get("features"), list) else []
    out["features"] = [f for f in VOICE_FEATURES if f in feats]
    return out


def _engine_status_raw() -> tuple[Any, bool, bool, int]:
    """The engine's GET /status as the engine sent it, read at most once per 30 s (a failed read: 5 s).
    -> (json | None, failed, fresh, age_ms): `age_ms` is how long ago the engine really answered (0 for a fresh read), so a cached
    answer is never presented as newer than it is."""
    cfg = _config()
    key = cfg[0] if cfg else ""
    now = time.monotonic()
    with _lock:
        hit = _status_cache.get(key)
        if hit and now < hit[0]:
            return hit[1], hit[2], False, max(0, int((now - hit[3]) * 1000))
    failed = False
    raw: Any = None
    try:
        raw = _call("GET", "/status", timeout=VOICE_STATUS_TIMEOUT)
    except Exception:  # noqa: BLE001 - the status read must never break the app
        failed = True
    with _lock:
        _status_cache[key] = (now + (VOICE_STATUS_FAIL_TTL if failed else VOICE_STATUS_TTL), raw, failed, now)
    # exactly ONE audit line per real engine read, whichever route triggered it (never per cached answer, never none)
    view = {"speak": "unknown"} if failed else _voice_status_view(raw)
    audit_log.record("basht.voice_status", status="unavailable" if failed else view["speak"], **({"reason": view["reason"]} if "reason" in view else {}))
    return raw, failed, True, 0


@router.get("/voice-status")
def voice_status(_: ServiceCall = Depends(require_service_call)):
    """Never an error to the UI: any failure, an unconfigured or an older engine answers 200 `{speak: "unknown"}`."""
    raw, failed, _fresh, _age = _engine_status_raw()
    return {"speak": "unknown"} if failed else _voice_status_view(raw)


# ── Engine status: version, build, capabilities, limits, link (the same cached engine read) ──
ENGINE_FEATURES = VOICE_FEATURES + ("history.images.v1", "media.inline.v1", "media.guard.v1", "runs.runId.v1", "errorCode.rate_limited.v1")  # allow-list
ATTACHMENT_KEYS = ("maxImages", "maxImageBytes", "maxTotalImageBytes", "maxFileBytes", "maxInlineBytes")
LINK_STATES = ("off", "connecting", "up", "down")
SIGNING_MODES = ("off", "optional", "required")
_VERSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,31}")
_COMMIT_RE = re.compile(r"[0-9a-f]{7,12}")
MAX_COUNT = 1_000_000
MAX_ATTACH_BYTES = 1024 * 1024 * 1024
MAX_ATTACH_COUNT = 1000
MAX_AGE_MS = 10 * 60 * 1000


def _bounded(v: Any, cap: int) -> int | None:
    """A non-negative int within `cap`; a bool, a float, a string, a negative or a huge number is dropped (None)."""
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= cap else None


def _engine_status_view(j: Any) -> dict[str, Any]:
    """The engine's status -> the one fixed, validated shape the BFF may pass on. Every field is checked on its own; whatever is missing,
    mistyped, out of range or not on an allow-list is DROPPED (never repaired). No path, hostname, id, log line or error text can pass:
    only fixed tokens, short ids and counts. A non-object answer is `{"ok": False}`."""
    if not isinstance(j, dict) or j.get("ok") is False:
        return {"ok": False}
    out: dict[str, Any] = {"ok": True}
    eng = j.get("engine")
    if isinstance(eng, dict) and isinstance(eng.get("version"), str) and _VERSION_RE.fullmatch(eng["version"]):
        out["engine"] = {"version": eng["version"]}
    wr = j.get("wrapper")
    out["wrapper"] = {"commit": wr["commit"] if isinstance(wr, dict) and isinstance(wr.get("commit"), str) and _COMMIT_RE.fullmatch(wr["commit"]) else None}
    feats = j.get("features")
    if isinstance(feats, list):
        have = {f for f in feats[:64] if isinstance(f, str) and len(f) <= 40}
        out["features"] = [f for f in ENGINE_FEATURES if f in have]
    att = j.get("attachments")
    if isinstance(att, dict):
        out["attachments"] = {k: v for k in ATTACHMENT_KEYS
                              if (v := _bounded(att.get(k), MAX_ATTACH_COUNT if k == "maxImages" else MAX_ATTACH_BYTES)) is not None}
    link = j.get("link")
    if isinstance(link, dict):
        lk: dict[str, Any] = {}
        if link.get("state") in LINK_STATES:
            lk["state"] = link["state"]
        if (n := _bounded(link.get("pendingApprovals"), MAX_COUNT)) is not None:
            lk["pendingApprovals"] = n
        out["link"] = lk
    voice = j.get("voice")
    if isinstance(voice, dict) and voice.get("speak") in VOICE_SPEAK_STATES:
        vv: dict[str, Any] = {"speak": voice["speak"]}
        if voice.get("reason") in VOICE_REASONS:
            vv["reason"] = voice["reason"]
        out["voice"] = vv
    runs = j.get("runs")
    if isinstance(runs, dict):
        out["runs"] = {"active": _bounded(runs.get("active"), MAX_COUNT), "total": _bounded(runs.get("total"), MAX_COUNT),
                       "approvalsPending": _bounded(runs.get("approvalsPending"), MAX_COUNT), "complete": runs.get("complete") is True}
    sg = j.get("signing")
    if isinstance(sg, dict):
        sv: dict[str, Any] = {}
        if sg.get("mode") in SIGNING_MODES:
            sv["mode"] = sg["mode"]
        if isinstance(sg.get("active"), bool):
            sv["active"] = sg["active"]
        out["signing"] = sv
    return out


@router.get("/engine-status")
def engine_status(_: ServiceCall = Depends(require_service_call)):
    """Never an error to the UI: an unconfigured, unreachable or older engine answers 200 `{"ok": false}` (= no answer, nothing guessed)."""
    raw, failed, _fresh, age_ms = _engine_status_raw()
    view = {"ok": False} if failed else _engine_status_view(raw)
    if view.get("ok"):
        view["ageMs"] = min(age_ms, MAX_AGE_MS)  # how old this answer is (0 = read just now): the app orders evidence by it, never by the fetch time
    return view


def utf16_len(text: str) -> int:
    """Length in UTF-16 code units, the unit the engine (JavaScript) and the BFF count: an emoji is 2, not 1."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


class SpeakBody(BaseModel):
    text: str = Field(min_length=1)

    @field_validator("text")
    @classmethod
    def _within_cap(cls, v: str) -> str:
        if utf16_len(v) > MAX_SPEAK:
            raise ValueError("text too long")
        return v


@router.post("/speak")
def speak(body: SpeakBody, _: ServiceCall = Depends(require_service_call)):
    """The text spoken in BASHT's own voice, as audio bytes (one chunk of a reply; the app chunks long replies)."""
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail={"code": "empty_message"})
    if not _allow(_speaks, SPEAK_PER_MINUTE, time.monotonic()):
        audit_log.record("basht.speak", status="rate_limited", chars=len(text))
        raise HTTPException(status_code=429, detail={"code": "rate_limited"})
    started = time.monotonic()
    try:
        raw, ctype = _voice_call("/speak", json.dumps({"text": text}).encode(), "application/json",
                                 timeout=SPEAK_TIMEOUT, max_bytes=MAX_SPEECH_BYTES)
    except EngineError as e:
        audit_log.record("basht.speak", status=e.code, chars=len(text), **({"reason": e.reason} if e.reason else {}))
        raise HTTPException(status_code=e.status, detail=e.detail) from None
    if ctype not in SPEECH_TYPES or not raw:
        audit_log.record("basht.speak", status="basht_unavailable", chars=len(text))
        raise HTTPException(status_code=502, detail={"code": "basht_unavailable"})
    audit_log.record("basht.speak", status="ok", chars=len(text), bytes=len(raw), ms=int((time.monotonic() - started) * 1000))
    return Response(content=raw, media_type=ctype, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/transcribe")
async def transcribe(request: HttpRequest, _: ServiceCall = Depends(require_service_call_audio)):
    """A voice note (raw audio body, signed) -> the engine's transcript. The audio is passed through and never kept."""
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype not in AUDIO_TYPES:
        raise HTTPException(status_code=415, detail={"code": "unsupported_audio"})
    audio = await request.body()  # already read (and size-capped) by the signature check
    if len(audio) > MAX_AUDIO:
        raise HTTPException(status_code=413, detail={"code": "too_large"})
    if len(audio) < MIN_AUDIO:
        raise HTTPException(status_code=422, detail={"code": "no_speech"})
    if not _allow(_transcribes, TRANSCRIBE_PER_MINUTE, time.monotonic()):
        audit_log.record("basht.transcribe", status="rate_limited", bytes=len(audio))
        raise HTTPException(status_code=429, detail={"code": "rate_limited"})
    started = time.monotonic()
    try:
        raw, _ctype = await run_in_threadpool(_voice_call, "/transcribe", audio, ctype, timeout=TRANSCRIBE_TIMEOUT, max_bytes=64 * 1024)
        j = json.loads(raw)
    except EngineError as e:
        audit_log.record("basht.transcribe", status=e.code, bytes=len(audio), ms=int((time.monotonic() - started) * 1000),
                         **({"reason": e.reason} if e.reason else {}))
        raise HTTPException(status_code=e.status, detail=e.detail) from None
    except ValueError:
        audit_log.record("basht.transcribe", status="basht_unavailable", bytes=len(audio))
        raise HTTPException(status_code=502, detail={"code": "basht_unavailable"}) from None
    text = _text(j.get("text") if isinstance(j, dict) else None, MAX_MESSAGE).strip()
    ms = int((time.monotonic() - started) * 1000)
    if not text:
        audit_log.record("basht.transcribe", status="no_speech", bytes=len(audio), ms=ms)
        raise HTTPException(status_code=422, detail={"code": "no_speech"})
    audit_log.record("basht.transcribe", status="ok", bytes=len(audio), chars=len(text), ms=ms)
    return {"text": text}
