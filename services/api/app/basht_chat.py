"""BASHT Core Integration C2 + C4: the owner's conversations with BASHT and live chat, through the engine's app bridge.

    BFF (owner cookie) --HMAC--> /internal/v1/basht/* (this module) --HTTPS + BASHT_APP_TOKEN--> {BASHT_CORE_URL}/app/v1/*

- The engine side (openclaw-railway-template, src/app-bridge.js) holds the gateway token and fixes what is possible: reads of the
  owner's own conversations, and turns in the app's own session `app:owner`. This module only adds the app's own controls.
- BASHT_APP_TOKEN is a secret of THIS service only. It is never returned, logged or sent anywhere but the engine URL.
- Only fixed, shaped fields are passed back to the BFF; engine error text never is.
- Every send is audited (length only, never the text) and rate limited.
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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .audit import audit_log
from .basht_core import ENV_VAR as URL_VAR
from .service_auth import ServiceCall, require_service_call

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

class _NoRedirect(urllib_request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any):  # noqa: ANN401
        return None  # never follow: a redirect would carry BASHT_APP_TOKEN to another place; it surfaces as an HTTPError (502)


_opener = urllib_request.build_opener(urllib_request.ProxyHandler({}), _NoRedirect)


def urlopen(req: Request, timeout: float):
    """Single seam for tests (monkeypatched). Never follows redirects, never uses an environment proxy."""
    return _opener.open(req, timeout=timeout)


router = APIRouter(prefix="/internal/v1/basht", include_in_schema=False)

_lock = threading.Lock()
_sends: list[float] = []


class EngineError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status, self.code = status, code


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
    req = Request(f"{base}/app/v1{path}", data=data, method=method,
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


def _allow_send(now: float) -> bool:
    with _lock:
        _sends[:] = [t for t in _sends if now - t < 60]
        if len(_sends) >= SEND_PER_MINUTE:
            return False
        _sends.append(now)
        return True


def reset_limits() -> None:
    with _lock:
        _sends.clear()


def _run_view(j: dict) -> dict:
    from .basht_media import steps  # B1 tool progress (names only)
    status = j.get("status") if j.get("status") in ("running", "done", "error", "stopped") else "error"
    return {"run_id": _text(j.get("runId"), 64), "status": status, "text": _text(j.get("text")), "failed": status == "error",
            "first_token_ms": _int(j.get("firstTokenMs")), "total_ms": _int(j.get("totalMs")), "steps": steps(j.get("steps"))}


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
