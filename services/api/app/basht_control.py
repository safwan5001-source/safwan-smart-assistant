"""BASHT app control (B5 + B6 + B7): BASHT's scheduled tasks, usage, memory (read-only) and "what BASHT can do now".

    BFF (owner cookie) --HMAC--> /internal/v1/basht/{automations,usage,memory,capabilities} --BASHT_APP_TOKEN--> engine /app/v1/*

- The engine bridge (openclaw-railway-template src/app-control.js) builds params itself and returns fixed shapes; this module
  re-validates and trims them again (no paths, no account ids, no engine text) and adds the app's own audit.
- Writes are exactly two, both audited: run a scheduled task now, and enable/disable it. Creating or editing tasks stays in the
  chat with BASHT; deleting is not offered. Memory is read-only.
- An engine without these routes (older bridge: 404 on the list routes, or 503 not_available without its gateway seam) reads as
  400 `control_unavailable`, so the app hides the section instead of reporting an outage.
- The BFF never sends query strings (apps/web/server/backend.ts): parameterised reads are POST with a JSON body.
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StrictBool

from . import basht_chat as _chat
from .basht_signing import engine_request
from .audit import audit_log
from .service_auth import ServiceCall, require_service_call

router = APIRouter(prefix="/internal/v1/basht", include_in_schema=False)

READ_TIMEOUT = 15.0
SLOW_TIMEOUT = 40.0  # capabilities = up to five engine CLI calls (two at a time) on a cold cache; writes queue one at a time
CONTROL_CODES = {"system_job", "rejected", "busy", "not_found", "bad_request", "rate_limited"}
_JOB_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_REF_RE = re.compile(r"^[0-9a-f]{24}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_.+-]{1,64}$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_PATH_RE = re.compile(r"(?<![\w:/.~-])(?:~/|/)(?:[\w.@+-]+/)+[\w.@+-]*")
MEMORY_FILES = ("MEMORY.md", "USER.md")


class _Unavailable(Exception):
    """The engine has no app control (older bridge or no gateway seam)."""


def _call(method: str, path: str, body: dict | None = None, timeout: float = READ_TIMEOUT) -> dict[str, Any]:
    """Like basht_chat._call (same config, same no-redirect opener, same size cap), with this module's refusal codes."""
    cfg = _chat._config()
    if cfg is None:
        raise _chat.EngineError(503, "basht_unconfigured")
    base, token = cfg
    data = json.dumps(body).encode() if body is not None else None
    req = engine_request(base, path, method=method, data=data,
                         headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "basht-app/1",
                                  **({"Content-Type": "application/json"} if data is not None else {})})
    try:
        with _chat.urlopen(req, timeout=timeout) as res:  # noqa: S310 - https only, checked in _config
            raw = res.read(_chat.MAX_BYTES + 1)
            if len(raw) > _chat.MAX_BYTES:
                raise _chat.EngineError(502, "basht_unavailable")
            return json.loads(raw)
    except HTTPError as e:
        try:
            specific = json.loads(e.read(4096)).get("error")
        except Exception:  # noqa: BLE001 - an unreadable body is a plain status
            specific = None
        if e.code == 503 and specific == "not_available":
            raise _Unavailable() from None
        if e.code in (400, 404, 409, 429):
            code = specific if specific in CONTROL_CODES else {400: "bad_request", 404: "not_found", 409: "busy", 429: "rate_limited"}[e.code]
            raise _chat.EngineError(e.code, code) from None
        raise _chat.EngineError(502, "basht_unavailable") from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise _chat.EngineError(502, "basht_unavailable") from None


def _read(path: str, *, listing: bool = True, timeout: float = READ_TIMEOUT, method: str = "GET", body: dict | None = None) -> dict:
    """`listing`: a 404 means the engine has no such route (older bridge) -> control_unavailable."""
    try:
        return _call(method, path, body, timeout)
    except _Unavailable:
        raise HTTPException(status_code=400, detail={"code": "control_unavailable"}) from None
    except _chat.EngineError as e:
        if listing and e.code == "not_found":
            raise HTTPException(status_code=400, detail={"code": "control_unavailable"}) from None
        raise HTTPException(status_code=e.status, detail={"code": e.code}) from None


# ── small value guards (everything is re-shaped here; nothing from the engine is passed through as is) ──
def _s(v: Any, cap: int = 200, multiline: bool = False) -> str | None:
    if not isinstance(v, str):
        return None
    keep = "\n" if multiline else ""
    t = "".join(ch if (ch >= " " and ch != "\x7f") or ch in keep else " " for ch in v)
    t = _PATH_RE.sub("…", t).strip()
    if not multiline:
        t = re.sub(r"\s+", " ", t)
    return t[:cap] or None


def _i(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 10**15 else None


def _n(v: Any) -> int | float | None:
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) < 10**15 else None


def _one(v: Any, allowed: tuple[str, ...]) -> str | None:
    return v if v in allowed else None


def _b(v: Any) -> bool:
    return v is True


def _list(v: Any) -> list:
    return v if isinstance(v, list) else []


def _d(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


RUN_STATUS = ("ok", "error", "skipped")
DELIVERY = ("delivered", "not-delivered", "unknown", "not-requested")


def _schedule(v: Any) -> dict:
    s = _d(v)
    if s.get("kind") == "cron":
        return {"kind": "cron", "expr": _s(s.get("expr"), 100), "tz": _s(s.get("tz"), 64)}
    if s.get("kind") == "every":
        return {"kind": "every", "every_ms": _i(s.get("everyMs"))}
    if s.get("kind") == "at":
        return {"kind": "at", "at": _s(s.get("at"), 64)}
    return {"kind": "other"}


def _job(j: Any) -> dict | None:
    j = _d(j)
    if not isinstance(j.get("id"), str) or not _JOB_RE.fullmatch(j["id"]):
        return None
    last = _d(j.get("last")) if isinstance(j.get("last"), dict) else None
    return {
        "id": j["id"], "name": _s(j.get("name"), 120) or j["id"], "enabled": _b(j.get("enabled")), "system": _b(j.get("system")),
        "kind": _one(j.get("kind"), ("agent", "event", "command", "other")) or "other", "prompt": _s(j.get("prompt"), 300),
        "schedule": _schedule(j.get("schedule")), "next_run_at": _i(j.get("nextRunAt")), "running": _b(j.get("running")),
        "last": {"at": _i(last.get("at")), "status": _one(last.get("status"), RUN_STATUS), "duration_ms": _i(last.get("durationMs")),
                 "delivery": _one(last.get("delivery"), DELIVERY), "error": _s(last.get("error"), 200)} if last else None,
        "consecutive_errors": _i(j.get("consecutiveErrors")) or 0, "auto_disabled": _b(j.get("autoDisabled")),
    }


def _run(r: Any) -> dict | None:
    r = _d(r)
    if _i(r.get("at")) is None:
        return None
    return {"at": r["at"], "status": _one(r.get("status"), RUN_STATUS), "completion": _one(r.get("completion"), ("succeeded", "failed", "unknown")),
            "duration_ms": _i(r.get("durationMs")), "quiet": _b(r.get("quiet")), "summary": _s(r.get("summary"), 500, multiline=True),
            "error": _s(r.get("error"), 200), "delivery": _one(r.get("delivery"), DELIVERY)}


def _job_id(job_id: str) -> str:
    if not _JOB_RE.fullmatch(job_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    return job_id


# ── B5: scheduled tasks ──
@router.get("/automations")
def automations(_: ServiceCall = Depends(require_service_call)):
    j = _read("/automations")
    jobs = [x for x in (_job(r) for r in _list(j.get("jobs"))) if x]
    return {"jobs": jobs[:200], "truncated": _b(j.get("truncated")), "fetched_at": _i(j.get("fetchedAt"))}


@router.get("/automations/{job_id}/runs")
def automation_runs(job_id: str, _: ServiceCall = Depends(require_service_call)):
    jid = _job_id(job_id)
    j = _read(f"/automations/{quote(jid, safe='')}/runs?limit=10", listing=False)
    return {"id": jid, "runs": [x for x in (_run(r) for r in _list(j.get("runs"))) if x][:20], "has_more": _b(j.get("hasMore"))}


def _write(action: str, jid: str, path: str, body: dict, extra: dict) -> dict:
    try:
        j = _call("POST", path, body, SLOW_TIMEOUT)
    except _Unavailable:
        audit_log.record("basht.automation", action=action, job_id=jid, status="control_unavailable", **extra)
        raise HTTPException(status_code=400, detail={"code": "control_unavailable"}) from None
    except _chat.EngineError as e:
        audit_log.record("basht.automation", action=action, job_id=jid, status=e.code, **extra)
        raise HTTPException(status_code=e.status, detail={"code": e.code}) from None
    audit_log.record("basht.automation", action=action, job_id=jid, status="ok", **extra)
    return j


@router.post("/automations/{job_id}/run")
def automation_run(job_id: str, _: ServiceCall = Depends(require_service_call)):
    jid = _job_id(job_id)
    j = _write("run", jid, f"/automations/{quote(jid, safe='')}/run", {}, {})
    return {"id": jid, "enqueued": _b(j.get("enqueued"))}


class EnabledBody(BaseModel):
    enabled: StrictBool  # "no"/1 are refused, never coerced into a switch


@router.post("/automations/{job_id}/enabled")
def automation_enabled(job_id: str, body: EnabledBody, _: ServiceCall = Depends(require_service_call)):
    jid = _job_id(job_id)
    j = _write("enable" if body.enabled else "disable", jid, f"/automations/{quote(jid, safe='')}/enabled", {"enabled": body.enabled}, {})
    return {"id": jid, "enabled": j.get("enabled") if isinstance(j.get("enabled"), bool) else None}


# ── B5: usage ──
def _cost(d: dict) -> dict:
    return {"tokens": _i(d.get("tokens")) or 0, "cost": _n(d.get("cost")), "cost_partial": _b(d.get("costPartial"))}


def _day(d: Any) -> dict | None:
    d = _d(d)
    return {"date": d["date"], **_cost(d)} if isinstance(d.get("date"), str) and _DATE_RE.fullmatch(d["date"]) else None


@router.get("/usage")
def usage(_: ServiceCall = Depends(require_service_call)):
    j = _read("/usage")
    a, t = (j.get("app") if isinstance(j.get("app"), dict) else None), (j.get("all") if isinstance(j.get("all"), dict) else None)
    return {
        "app": {**_cost(a), "input": _i(a.get("input")) or 0, "output": _i(a.get("output")) or 0, "today": _day(a.get("today"))} if a else None,
        "all": {**_cost(t), "days": _i(t.get("days")), "today": _day(t.get("today")),
                "daily": [x for x in (_day(d) for d in _list(t.get("daily"))) if x][-31:]} if t else None,
        "missing_cost_models": [m for m in _list(j.get("missingCostModels")) if isinstance(m, str) and _MODEL_RE.fullmatch(m)][:5],
    }


# ── B6: memory (read-only) ──
@router.get("/memory/status")
def memory_status(_: ServiceCall = Depends(require_service_call)):
    j = _read("/memory/status")
    return {
        "state": _one(j.get("state"), ("ok", "stale", "degraded", "disabled", "unavailable", "unknown")) or "unknown",
        "reason": _s(j.get("reason"), 30), "search_mode": _one(j.get("searchMode"), ("fts-only", "hybrid", "vector")),
        "files": _i(j.get("files")), "chunks": _i(j.get("chunks")), "last_indexed_at": _i(j.get("lastIndexedAt")),
        "bootstrap": [{"name": f["name"], "exists": _b(f.get("exists")), "size": _i(f.get("size")), "updated_at": _i(f.get("updatedAt"))}
                      for f in _list(j.get("bootstrap")) if isinstance(f, dict) and f.get("name") in MEMORY_FILES],
    }


class SearchBody(BaseModel):
    q: str = Field(min_length=1, max_length=200)
    page: int = Field(0, ge=0, le=2)


def _file(v: Any) -> str | None:
    n = _s(v, 120)
    return n if n and "/" not in n and "\\" not in n and n not in (".", "..") else None


@router.post("/memory/search")
def memory_search(body: SearchBody, _: ServiceCall = Depends(require_service_call)):
    q = body.q.strip()
    if not q:
        raise HTTPException(status_code=422, detail={"code": "bad_request"})
    j = _read(f"/memory/search?q={quote(q, safe='')}&page={body.page}", listing=False)
    hits = []
    for h in _list(j.get("results")):
        h = _d(h)
        f, snippet = _file(h.get("file")), _s(h.get("snippet"), 500, multiline=True)
        if not f or not snippet:
            continue
        ref = h.get("ref") if isinstance(h.get("ref"), str) and _REF_RE.fullmatch(h["ref"]) else None
        date = h.get("date") if isinstance(h.get("date"), str) and _DATE_RE.fullmatch(h["date"]) else None
        hits.append({"file": f, "snippet": snippet, "ref": ref, "date": date})
    audit_log.record("basht.memory", action="search", chars=len(q), results=len(hits))  # never the query text
    return {"results": hits[:10], "more": _b(j.get("more")), "stale": _b(j.get("stale")), "page": body.page}


def _text(j: dict) -> dict:
    return {"text": j.get("text")[:20_000] if isinstance(j.get("text"), str) else "", "part": _i(j.get("part")) or 0,
            "parts": max(1, min(10, _i(j.get("parts")) or 1)), "chars": _i(j.get("chars")) or 0, "truncated": _b(j.get("truncated"))}


class ItemBody(BaseModel):
    ref: str = Field(min_length=24, max_length=24, pattern=r"^[0-9a-f]{24}$")
    part: int = Field(0, ge=0, le=9)


@router.post("/memory/item")
def memory_item(body: ItemBody, _: ServiceCall = Depends(require_service_call)):
    j = _read(f"/memory/item?ref={body.ref}&part={body.part}", listing=False)
    audit_log.record("basht.memory", action="view")
    return {"file": _file(j.get("file")), **_text(j)}


class FileBody(BaseModel):
    name: str = Field(pattern=r"^(MEMORY|USER)\.md$")
    part: int = Field(0, ge=0, le=9)


@router.post("/memory/file")
def memory_file(body: FileBody, _: ServiceCall = Depends(require_service_call)):
    j = _read(f"/memory/file?name={body.name}&part={body.part}", listing=False)
    audit_log.record("basht.memory", action="view", file=body.name)
    return {"name": body.name, "exists": _b(j.get("exists")), "updated_at": _i(j.get("updatedAt")), **_text(j)}


# ── B7: what BASHT can do now (read-only) ──
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,80}$", re.I)


def _skill(s: Any, with_missing: bool) -> dict | None:
    s = _d(s)
    name = _s(s.get("name"), 80)
    if not name:
        return None
    out = {"name": name, "emoji": _s(s.get("emoji"), 8), "description": _s(s.get("description"), 160)}
    if with_missing:
        m = _d(s.get("missing"))
        out["missing"] = {"bins": [x for x in _list(m.get("bins")) if isinstance(x, str) and _NAME_RE.fullmatch(x)][:4],
                          "env": [x for x in _list(m.get("env")) if isinstance(x, str) and _NAME_RE.fullmatch(x)][:4],
                          "config": _i(m.get("config")) or 0, "os": _b(m.get("os"))}
    return out


def _named(rows: Any, cap: int) -> list[dict]:
    out = []
    for p in _list(rows):
        p = _d(p)
        if isinstance(p.get("id"), str) and _ID_RE.fullmatch(p["id"]):
            out.append({"id": p["id"], "name": _s(p.get("name"), 60) or p["id"]})
    return out[:cap]


@router.get("/capabilities")
def capabilities(_: ServiceCall = Depends(require_service_call)):
    j = _read("/capabilities", timeout=SLOW_TIMEOUT)
    sk, tl, pl = (j.get(k) if isinstance(j.get(k), dict) else None for k in ("skills", "tools", "plugins"))
    channels = None
    if isinstance(j.get("channels"), list):
        channels = [{"id": c["id"], "label": _s(c.get("label"), 40) or c["id"], "accounts": _i(c.get("accounts")) or 0,
                     "configured": _b(c.get("configured")), "linked": _b(c.get("linked")), "connected": _b(c.get("connected")),
                     "last_connected_at": _i(c.get("lastConnectedAt")),
                     "issue": _one(c.get("issue"), ("intent", "permissions", "config", "auth", "runtime"))}
                    for c in j["channels"] if isinstance(c, dict) and isinstance(c.get("id"), str) and _ID_RE.fullmatch(c["id"])][:20]
    tools = None
    if tl:
        groups = []
        for g in _list(tl.get("groups"))[:40]:
            g = _d(g)
            if not isinstance(g.get("id"), str) or not _ID_RE.fullmatch(g["id"]):
                continue
            ts = [{"id": t["id"], "label": _s(t.get("label"), 60) or t["id"]} for t in _list(g.get("tools"))
                  if isinstance(t, dict) and isinstance(t.get("id"), str) and _ID_RE.fullmatch(t["id"])][:80]
            groups.append({"id": g["id"], "label": _s(g.get("label"), 60), "plugin": _b(g.get("plugin")), "tools": ts})
        tools = {"profile": _s(tl.get("profile"), 30), "count": sum(len(g["tools"]) for g in groups), "groups": groups}
    return {
        "channels": channels,
        "skills": {"ready": [x for x in (_skill(s, False) for s in _list(sk.get("ready"))) if x][:150],
                   "missing": [x for x in (_skill(s, True) for s in _list(sk.get("missing"))) if x][:150],
                   "unavailable": [{"name": x["name"], "emoji": x["emoji"], "state": _one(_d(s).get("state"), ("disabled", "blocked", "platform")) or "disabled"}
                                   for s in _list(sk.get("unavailable")) if (x := _skill(s, False))][:150],
                   "total": _i(sk.get("total")) or 0} if sk else None,
        "tools": tools,
        "plugins": {"enabled": _named(pl.get("enabled"), 150), "needs_setup": _named(pl.get("needsSetup"), 50),
                    "failed": _named(pl.get("failed"), 50), "total": _i(pl.get("total")) or 0} if pl else None,
        "fetched_at": _i(j.get("fetchedAt")),
    }
