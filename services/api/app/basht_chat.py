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
from urllib.request import Request, urlopen

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
MAX_BYTES = 2 * 1024 * 1024
_KEY_RE = re.compile(r"^agent:[a-z0-9_-]{1,64}:[^\s]{1,200}$", re.I)
_RUN_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

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


def _call(method: str, path: str, body: dict | None = None, env=os.environ) -> dict[str, Any]:
    cfg = _config(env)
    if cfg is None:
        raise EngineError(503, "basht_unconfigured")
    base, token = cfg
    data = json.dumps(body).encode() if body is not None else None
    req = Request(f"{base}/app/v1{path}", data=data, method=method,
                  headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "basht-app/1",
                           **({"Content-Type": "application/json"} if data is not None else {})})
    try:
        with urlopen(req, timeout=READ_TIMEOUT) as res:  # noqa: S310 - https only, checked in _config
            raw = res.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise EngineError(502, "basht_unavailable")
            return json.loads(raw)
    except HTTPError as e:
        code = {400: "bad_request", 404: "not_found", 409: "busy", 429: "rate_limited"}.get(e.code, "basht_unavailable")
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
    status = j.get("status") if j.get("status") in ("running", "done", "error", "stopped") else "error"
    return {"run_id": _text(j.get("runId"), 64), "status": status, "text": _text(j.get("text")), "failed": status == "error"}


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


@router.post("/history")
def history(body: HistoryBody, _: ServiceCall = Depends(require_service_call)):
    """POST with a JSON body: the BFF only ever calls fixed /internal/v1/* paths (no query strings, see apps/web/server/backend.ts)."""
    if not _KEY_RE.fullmatch(body.key):
        raise HTTPException(status_code=400, detail={"code": "bad_request"})
    q = f"/history?key={quote(body.key, safe='')}&limit={body.limit}" + (f"&offset={body.offset}" if body.offset is not None else "")
    j = _guard(lambda: _call("GET", q))
    msgs = j.get("messages") if isinstance(j.get("messages"), list) else []
    out = [{"role": m.get("role"), "text": _text(m.get("text")), "at": m.get("at") if isinstance(m.get("at"), int) else 0}
           for m in msgs if isinstance(m, dict) and m.get("role") in ("user", "assistant")]
    nxt = j.get("nextOffset")
    return {"key": body.key, "messages": out, "next_offset": nxt if isinstance(nxt, int) else None, "has_more": j.get("hasMore") is True}


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
