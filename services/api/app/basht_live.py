"""BASHT B3 + B4: approvals and the live event feed, through the engine's app bridge (persistent gateway link, engine side).

    BFF (owner cookie) --HMAC--> /internal/v1/basht/approvals*  --BASHT_APP_TOKEN--> {BASHT_CORE_URL}/app/v1/approvals*
    notify loop (web server) --HMAC--> /internal/v1/basht/events --BASHT_APP_TOKEN--> {BASHT_CORE_URL}/app/v1/events

- Decisions are "allow-once" and "deny" only. "allow-always" (a standing grant) is refused here, in the BFF and in the engine.
- The app never decides on its own: a decision exists only because the owner pressed a button (BFF: owner session, same origin).
- Every decision is audited as `basht.approval` with the approval id, its kind and the decision. Never the command text.
- When the engine's link to its gateway is down, reads say so as data (`link.state`), and a decision is refused with `link_down`:
  never a guess, never a silent retry that could land later.
- Only fixed, trimmed fields leave this module; engine error text never does.
"""
from __future__ import annotations

import json
import re
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import basht_chat as bc
from .audit import audit_log
from .basht_signing import engine_request
from .service_auth import ServiceCall, require_service_call

router = APIRouter(prefix="/internal/v1/basht", include_in_schema=False)

DECISIONS = ("allow-once", "deny")
KINDS = ("exec", "plugin", "system-agent")
SESSIONS = ("app", "main", "whatsapp", "cron", "other", "unknown")
LINK_STATES = ("up", "connecting", "down", "off")
EVENT_TYPES = ("approval.requested", "approval.resolved", "chat.final", "chat.error", "cron.finished", "cron.failed", "gateway.up", "gateway.down")
APPROVAL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
DECIDE_PER_MINUTE = 30
LIVE_TIMEOUT = 15.0
EVENTS_TIMEOUT = 35.0
MAX_EVENTS = 200  # the bridge may long-poll up to 25 s
PAGE_BYTES = 256 * 1024  # serialized events per answer; the web reads the feed with a 512 KiB cap
ENGINE_REFUSALS = {"bad_id", "bad_decision", "rejected"}

_lock = threading.Lock()
_decides: list[float] = []


def reset_limits() -> None:
    with _lock:
        _decides.clear()


def _allow_decide(now: float) -> bool:
    with _lock:
        _decides[:] = [t for t in _decides if now - t < 60]
        if len(_decides) >= DECIDE_PER_MINUTE:
            return False
        _decides.append(now)
        return True


class LiveError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status, self.code = status, code


def _live(method: str, path: str, body: dict | None = None, timeout: float = LIVE_TIMEOUT) -> dict[str, Any]:
    """One bridge call. 503 link_down / not_available from the bridge become the domain code `link_down` (not an outage of the API)."""
    cfg = bc._config()
    if cfg is None:
        raise LiveError(503, "basht_unconfigured")
    base, token = cfg
    data = json.dumps(body).encode() if body is not None else None
    req = engine_request(base, path, method=method, data=data,
                         headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "basht-app/1",
                                  **({"Content-Type": "application/json"} if data is not None else {})})
    try:
        with bc.urlopen(req, timeout=timeout) as res:  # noqa: S310 - https only, checked in bc._config
            raw = res.read(bc.MAX_BYTES + 1)
            if len(raw) > bc.MAX_BYTES:
                raise LiveError(502, "basht_unavailable")
            return json.loads(raw)
    except HTTPError as e:
        try:
            code = json.loads(e.read(4096)).get("error")
        except Exception:  # noqa: BLE001 - an unreadable body is a plain outage
            code = None
        if e.code == 503 and code in ("link_down", "not_available"):
            raise LiveError(409, "link_down") from None
        if e.code == 400 and code in ENGINE_REFUSALS:
            raise LiveError(400, code) from None
        if e.code == 404:
            raise LiveError(404, "not_found") from None
        if e.code == 429:
            raise LiveError(429, "rate_limited") from None
        raise LiveError(502, "basht_unavailable") from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise LiveError(502, "basht_unavailable") from None


def _short(v: Any, cap: int = 200) -> str | None:
    return bc._short(v, cap)


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 10**16 else None


def _pick(v: Any, allowed: tuple[str, ...]) -> str | None:
    return v if isinstance(v, str) and v in allowed else None


def _link(v: Any) -> dict:
    v = v if isinstance(v, dict) else {}
    return {"state": _pick(v.get("state"), LINK_STATES) or "down", "since": _int(v.get("since")), "last_up_at": _int(v.get("lastUpAt")),
            "last_error": _short(v.get("lastError"), 40)}


def _approval(a: Any) -> dict | None:
    if not isinstance(a, dict) or not isinstance(a.get("id"), str) or not APPROVAL_ID.fullmatch(a["id"]):
        return None
    kind = _pick(a.get("kind"), KINDS)
    if not kind:
        return None
    decisions = [d for d in (a.get("decisions") if isinstance(a.get("decisions"), list) else []) if d in DECISIONS]
    return {"id": a["id"], "kind": kind, "summary": _short(a.get("summary"), 300), "title": _short(a.get("title"), 120),
            "host": _short(a.get("host"), 20), "agent_id": _short(a.get("agentId"), 64), "session": _pick(a.get("session"), SESSIONS) or "unknown",
            "is_app": a.get("isApp") is True, "warning": _short(a.get("warning"), 200),
            "created_at": _int(a.get("createdAt")), "expires_at": _int(a.get("expiresAt")), "decisions": decisions}


def _decided(a: Any) -> dict | None:
    if not isinstance(a, dict) or not isinstance(a.get("id"), str) or not APPROVAL_ID.fullmatch(a["id"]):
        return None
    return {"id": a["id"], "kind": _pick(a.get("kind"), KINDS), "summary": _short(a.get("summary"), 300),
            "status": _short(a.get("status"), 20), "decision": _pick(a.get("decision"), ("allow-once", "allow-always", "deny")),
            "reason": _short(a.get("reason"), 40), "session": _pick(a.get("session"), SESSIONS) or "unknown",
            "by": _pick(a.get("by"), ("app", "system", "other")),
            "created_at": _int(a.get("createdAt")), "resolved_at": _int(a.get("resolvedAt")), "expires_at": _int(a.get("expiresAt"))}


def _event(e: Any) -> dict | None:
    """One ring record in a fixed shape (defence in depth: the bridge already trims, this re-checks every field)."""
    if not isinstance(e, dict) or _int(e.get("id")) is None:
        return None
    t = _pick(e.get("type"), EVENT_TYPES)
    if not t:
        return None
    out: dict[str, Any] = {"id": e["id"], "type": t, "at": _int(e.get("at"))}
    if t == "approval.requested":
        a = _approval(e.get("approval"))
        if not a:
            return None
        out["approval"] = a
    elif t == "approval.resolved":
        if not isinstance(e.get("approvalId"), str) or not APPROVAL_ID.fullmatch(e["approvalId"]):
            return None
        out.update(approval_id=e["approvalId"], kind=_pick(e.get("kind"), KINDS), decision=_pick(e.get("decision"), ("allow-once", "allow-always", "deny")),
                   session=_pick(e.get("session"), SESSIONS) or "unknown")
    elif t in ("chat.final", "chat.error"):
        out.update(session="app", seen=e.get("seen") is True)
    elif t in ("cron.finished", "cron.failed"):
        out.update(job_id=_short(e.get("jobId"), 100), name=_short(e.get("name"), 80), status=_short(e.get("status"), 20))
    elif t == "gateway.up":
        out["down_for_ms"] = _int(e.get("downForMs"))
    return out


@router.get("/approvals")
def approvals(_: ServiceCall = Depends(require_service_call)):
    """Pending approvals. A link that is down is a state the app shows, not an error: `available: false`."""
    try:
        j = _live("GET", "/approvals")
    except LiveError as e:
        if e.code == "link_down":
            return {"available": False, "approvals": [], "link": {"state": "down", "since": None, "last_up_at": None, "last_error": None}}
        raise HTTPException(status_code=e.status, detail={"code": e.code}) from None
    rows = [a for a in (_approval(x) for x in (j.get("approvals") if isinstance(j.get("approvals"), list) else [])) if a]
    return {"available": True, "approvals": rows[:100], "partial": j.get("partial") is True, "link": _link(j.get("link"))}


class HistoryBody(BaseModel):
    limit: int = Field(20, ge=1, le=50)


@router.post("/approvals/history")
def approvals_history(body: HistoryBody, _: ServiceCall = Depends(require_service_call)):
    try:
        j = _live("GET", f"/approvals/history?limit={body.limit}")
    except LiveError as e:
        if e.code == "link_down":
            return {"available": False, "items": []}
        raise HTTPException(status_code=e.status, detail={"code": e.code}) from None
    rows = [a for a in (_decided(x) for x in (j.get("items") if isinstance(j.get("items"), list) else [])) if a]
    return {"available": True, "items": rows[: body.limit]}


class DecideBody(BaseModel):
    id: str = Field(min_length=8, max_length=128)
    decision: str = Field(min_length=1, max_length=20)


@router.post("/approvals/decide")
def decide(body: DecideBody, _: ServiceCall = Depends(require_service_call)):
    """The owner's answer to one approval. 400 with a code for every refusal (the BFF maps it); audited either way."""
    if not APPROVAL_ID.fullmatch(body.id):
        raise HTTPException(status_code=400, detail={"code": "bad_id"})
    if body.decision not in DECISIONS:
        audit_log.record("basht.approval", approval_id=body.id, decision="refused", status="bad_decision")
        raise HTTPException(status_code=400, detail={"code": "bad_decision"})
    if not _allow_decide(time.monotonic()):
        audit_log.record("basht.approval", approval_id=body.id, decision=body.decision, status="rate_limited")
        raise HTTPException(status_code=429, detail={"code": "rate_limited"})
    try:
        j = _live("POST", f"/approvals/{body.id}", {"decision": body.decision})
    except LiveError as e:
        audit_log.record("basht.approval", approval_id=body.id, decision=body.decision, status=e.code)
        status = 400 if e.code in ("link_down", "not_found", *ENGINE_REFUSALS) else e.status
        raise HTTPException(status_code=status, detail={"code": e.code}) from None
    a = _decided(j.get("approval")) or {}
    applied = j.get("applied") is True
    audit_log.record("basht.approval", approval_id=body.id, kind=a.get("kind"), decision=body.decision,
                     status="applied" if applied else "already_answered", recorded=a.get("decision"))
    return {"applied": applied, "approval": a or None}


class EventsBody(BaseModel):
    after: int = Field(0, ge=0, lt=10**16)
    wait: int = Field(0, ge=0, le=25)


@router.post("/events")
def events(body: EventsBody, _: ServiceCall = Depends(require_service_call)):
    """The live feed for the notify loop (B4). An engine that is unreachable answers 502, which the loop reads as "offline"."""
    try:
        j = _live("GET", f"/events?after={body.after}" + (f"&wait={body.wait}" if body.wait else ""), timeout=EVENTS_TIMEOUT)
    except LiveError as e:
        # an engine that is not configured here, an older bridge without the link or without this route at all (404, e.g.
        # after an engine-only rollback), or the link switched off: nothing to report (200, so the notify loop never mistakes
        # "not set up" for "BASHT is offline")
        if e.code in ("link_down", "basht_unconfigured", "not_found"):
            return {"available": False, "configured": e.code != "basht_unconfigured", "events": [], "epoch": None, "latest": None,
                    "truncated": False, "link": _link({"state": "off"})}
        raise HTTPException(status_code=e.status, detail={"code": e.code}) from None
    # at most MAX_EVENTS records per answer; `next_after` is how far this answer reached (records dropped as malformed included),
    # `more` says the caller must ask again from there. The caller pages; nothing is skipped by jumping to `latest`.
    # Also bounded in BYTES (PAGE_BYTES, well under the web's 512 KiB response ceiling): a page of long approval summaries must
    # never be refused by the caller's transport cap — the rest comes on the next page (`more`).
    raw = (j.get("events") if isinstance(j.get("events"), list) else [])[:MAX_EVENTS]
    rows: list[dict] = []
    ids: list[int] = []
    used = 0
    for e in raw:
        x = _event(e)
        size = len(json.dumps(x, ensure_ascii=False).encode()) + 1 if x else 0
        if x and rows and used + size > PAGE_BYTES:
            break
        used += size
        if x:
            rows.append(x)
        if isinstance(e, dict) and _int(e.get("id")) is not None:
            ids.append(e["id"])
    next_after = max([body.after, *ids])
    latest = _int(j.get("latest"))
    epoch = j.get("epoch") if isinstance(j.get("epoch"), str) and re.fullmatch(r"[0-9a-f]{6,32}", j["epoch"]) else None
    return {"available": True, "events": rows, "epoch": epoch, "latest": latest, "next_after": next_after,
            "more": latest is not None and next_after < latest, "truncated": j.get("truncated") is True, "link": _link(j.get("link"))}
