"""BASHT chat basics + media (B1/B2): photos on a BASHT turn, files out of BASHT's replies, «محادثة جديدة», conversation search.

    BFF (owner cookie) --HMAC--> /internal/v1/basht/{send-media,media,new,search} (this module) --BASHT_APP_TOKEN--> engine /app/v1/*

Same rules as app/basht_chat.py (it owns the engine connection, `_config` and the `urlopen` seam): fixed engine paths, fixed answer
fields, engine error text never passed on. Audits record sizes, counts and types only, never message text, image bytes, file names
or search terms.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import basht_chat as bc
from .audit import audit_log
from .basht_signing import engine_request
from .service_auth import ServiceCall, require_service_call, require_service_call_media

router = APIRouter(prefix="/internal/v1/basht", include_in_schema=False)

MAX_IMAGES = 8
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGES_TOTAL = 14 * 1024 * 1024
MAX_MEDIA_BYTES = 20 * 1024 * 1024
UPLOAD_TIMEOUT = 60.0
MEDIA_TIMEOUT = 45.0  # an artifact is read by the engine's CLI (~2 s), a file streams straight away
RESET_TIMEOUT = 60.0  # sessions.reset runs through the engine's CLI (several seconds)
SEARCH_TIMEOUT = 30.0
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"}
MEDIA_TYPES = {
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif", "application/pdf", "text/plain", "text/markdown",
    "text/csv", "application/json", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav",
    "video/mp4",
}
SEND_REFUSALS = {"too_many_images", "image_too_large", "images_too_large", "unsupported_image"}
_B64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")
_REF_RE = re.compile(r"^[0-9a-f]{32}$")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,100}$")
_TOOL_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


def _engine(method: str, path: str, body: dict | None = None, timeout: float = bc.READ_TIMEOUT, max_bytes: int = bc.MAX_BYTES,
            refusals: frozenset[str] | set[str] = frozenset()):
    """One engine call -> (bytes, content type, headers). Raises bc.EngineError with a fixed code (never engine text)."""
    cfg = bc._config()  # noqa: SLF001 - the same connection rules as the rest of the BASHT bridge
    if cfg is None:
        raise bc.EngineError(503, "basht_unconfigured")
    base, token = cfg
    data = json.dumps(body).encode() if body is not None else None
    req = engine_request(base, path, method=method, data=data,
                         headers={"Authorization": f"Bearer {token}", "Accept": "*/*", "User-Agent": "basht-app/1",
                                  **({"Content-Type": "application/json"} if data is not None else {})})
    try:
        with bc.urlopen(req, timeout=timeout) as res:  # noqa: S310 - https only, checked in _config
            raw = res.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raise bc.EngineError(502, "too_large")
            headers = getattr(res, "headers", None)
            ctype = (headers.get("Content-Type") if headers is not None else None) or "application/json"
            return raw, ctype.split(";")[0].strip().lower(), headers
    except HTTPError as e:
        code = {400: "bad_request", 404: "not_found", 409: "busy", 413: "too_large", 415: "unsupported", 429: "rate_limited"}.get(e.code, "basht_unavailable")
        if e.code in (400, 503):
            try:
                specific = json.loads(e.read(4096)).get("error")
            except Exception:  # noqa: BLE001 - an unreadable body keeps the plain code
                specific = None
            if specific in refusals:
                code = specific
            if e.code == 503 and specific == "not_available":
                raise bc.EngineError(400, "not_available") from None
        raise bc.EngineError(e.code if e.code in (400, 404, 409, 413, 415, 429) else 502, code) from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise bc.EngineError(502, "basht_unavailable") from None


def _ts(v: Any) -> int | None:
    """A millisecond timestamp (bc._int caps at 10**12, below today's epoch-ms values)."""
    return v if isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 10**14 else None


def _json(raw: bytes) -> dict[str, Any]:
    try:
        j = json.loads(raw)
    except ValueError:
        raise bc.EngineError(502, "basht_unavailable") from None
    return j if isinstance(j, dict) else {}


def _fail(e: bc.EngineError):
    raise HTTPException(status_code=e.status, detail={"code": e.code}) from None


# ── photos on a turn ──────────────────────────────────────────────────────────────────────────────────────────────────────────
class ImageIn(BaseModel):
    mime: str = Field(min_length=1, max_length=40)
    data: str = Field(min_length=4, max_length=14_000_000)


class SendMediaBody(BaseModel):
    message: str = Field("", max_length=bc.MAX_MESSAGE)
    images: list[ImageIn] = Field(min_length=1, max_length=MAX_IMAGES)


def _decoded_size(data: str) -> int:
    return len(data) * 3 // 4 - (2 if data.endswith("==") else 1 if data.endswith("=") else 0)


@router.post("/send-media")
def send_media(body: SendMediaBody, _: ServiceCall = Depends(require_service_call_media)):
    msg = body.message.strip()
    total = 0
    for img in body.images:
        if img.mime not in IMAGE_TYPES:
            raise HTTPException(status_code=400, detail={"code": "unsupported_image"})
        if len(img.data) % 4 or not _B64_RE.fullmatch(img.data):
            raise HTTPException(status_code=400, detail={"code": "bad_request"})
        size = _decoded_size(img.data)
        if size > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail={"code": "image_too_large"})
        total += size
    if total > MAX_IMAGES_TOTAL:
        raise HTTPException(status_code=400, detail={"code": "images_too_large"})
    try:
        base64.b64decode(body.images[0].data[:64], validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail={"code": "bad_request"}) from None
    fields = {"chars": len(msg), "images": len(body.images), "image_bytes": total}
    if not bc._allow_send(time.monotonic()):  # noqa: SLF001 - one send budget for text and photo turns
        audit_log.record("basht.send", status="rate_limited", **fields)
        raise HTTPException(status_code=429, detail={"code": "rate_limited"})
    try:
        raw, _, _ = _engine("POST", "/send", {"message": msg, "images": [{"mime": i.mime, "data": i.data} for i in body.images]},
                            timeout=UPLOAD_TIMEOUT, refusals=SEND_REFUSALS)
    except bc.EngineError as e:
        audit_log.record("basht.send", status=e.code, **fields)
        _fail(e)
    run_id = bc._text(_json(raw).get("runId"), 64)  # noqa: SLF001
    if not bc._RUN_RE.fullmatch(run_id):  # noqa: SLF001
        raise HTTPException(status_code=502, detail={"code": "basht_unavailable"})
    audit_log.record("basht.send", status="started", run_id=run_id, **fields)
    return {"run_id": run_id}


# ── files out ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
class MediaBody(BaseModel):
    key: str = Field(min_length=1, max_length=260)
    msg: str = Field(min_length=6, max_length=100)
    ref: str = Field(min_length=32, max_length=32)


_FILENAME_RE = re.compile(r"filename\*=UTF-8''([^;\s]+)", re.I)


def _filename(headers) -> str:
    """The engine's file name (basename only, never a path), cleaned; a generic name otherwise."""
    from urllib.parse import unquote
    m = _FILENAME_RE.search((headers.get("Content-Disposition") if headers is not None else "") or "")
    name = unquote(m.group(1)) if m else ""
    name = "".join(ch for ch in name.replace("/", "_").replace("\\", "_") if ch >= " " and ch != "\x7f").strip(". ")
    return name[:120] or "file"


@router.post("/media")
def media(body: MediaBody, _: ServiceCall = Depends(require_service_call)):
    if not bc._KEY_RE.fullmatch(body.key) or not _ID_RE.fullmatch(body.msg) or not _REF_RE.fullmatch(body.ref):  # noqa: SLF001
        raise HTTPException(status_code=400, detail={"code": "bad_request"})
    q = f"/media?key={quote(body.key, safe='')}&msg={quote(body.msg, safe='')}&ref={body.ref}"
    try:
        raw, ctype, headers = _engine("GET", q, timeout=MEDIA_TIMEOUT, max_bytes=MAX_MEDIA_BYTES)
    except bc.EngineError as e:
        audit_log.record("basht.media", status=e.code)
        _fail(e)
    if ctype not in MEDIA_TYPES:
        audit_log.record("basht.media", status="unsupported")
        raise HTTPException(status_code=415, detail={"code": "unsupported"})
    audit_log.record("basht.media", status="ok", type=ctype, bytes=len(raw))
    name = _filename(headers)
    return Response(content=raw, media_type=ctype, headers={
        "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name, safe='')}",
    })


# ── «محادثة جديدة» and search ───────────────────────────────────────────────────────────────────────────────────────────────
@router.post("/new")
def new_conversation(_: ServiceCall = Depends(require_service_call)):
    try:
        raw, _, _ = _engine("POST", "/new", {}, timeout=RESET_TIMEOUT, refusals={"rejected"})
    except bc.EngineError as e:
        audit_log.record("basht.new", status=e.code)
        _fail(e)
    j = _json(raw)
    audit_log.record("basht.new", status="ok")
    return {"at": _ts(j.get("at")), "earlier": j.get("earlier") is True}


class SearchBody(BaseModel):
    q: str = Field(min_length=1, max_length=200)


@router.post("/search")
def search(body: SearchBody, _: ServiceCall = Depends(require_service_call)):
    q = "".join(ch if ch >= " " and ch != "\x7f" else " " for ch in body.q).strip()
    if not q:
        raise HTTPException(status_code=400, detail={"code": "bad_request"})
    try:
        raw, _, _ = _engine("GET", f"/search?q={quote(q, safe='')}", timeout=SEARCH_TIMEOUT)
    except bc.EngineError as e:
        audit_log.record("basht.search", status=e.code, chars=len(q))
        _fail(e)
    rows = _json(raw).get("results")
    out = []
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict) or not bc._KEY_RE.fullmatch(str(r.get("key", ""))) or not _ID_RE.fullmatch(str(r.get("messageId", ""))):  # noqa: SLF001
            continue
        if r.get("role") not in ("user", "assistant"):
            continue
        out.append({"key": r["key"], "label": bc._text(r.get("label"), 80), "message_id": r["messageId"], "role": r["role"],  # noqa: SLF001
                    "at": _ts(r.get("at")) or 0, "snippet": bc._short(r.get("snippet"), 300) or ""})  # noqa: SLF001
    audit_log.record("basht.search", status="ok", chars=len(q), results=len(out))
    return {"results": out[:25]}


# ── shapes shared with basht_chat.history / run (rows carry id, kind, media; runs carry tool steps) ─────────────────────────────
def media_rows(v: Any) -> list[dict]:
    out: list[dict] = []
    for m in v if isinstance(v, list) else []:
        if not isinstance(m, dict):
            continue
        if m.get("kind") == "link" and isinstance(m.get("url"), str) and m["url"].startswith("https://") and len(m["url"]) <= 2048:
            out.append({"kind": "link", "name": bc._short(m.get("name"), 120) or "link", "url": m["url"]})  # noqa: SLF001
            continue
        if m.get("kind") not in ("image", "file") or not _REF_RE.fullmatch(str(m.get("ref", ""))):
            continue
        mime = m.get("mime") if m.get("mime") in MEDIA_TYPES else None
        out.append({"ref": m["ref"], "kind": m["kind"] if (m["kind"] == "file" or mime) else "file", "name": bc._short(m.get("name"), 120) or "file",  # noqa: SLF001
                    "mime": mime, "size": bc._int(m.get("size")), "available": m.get("available") is not False})  # noqa: SLF001
    return out[:12]


def row_extras(m: dict) -> dict:
    """id (for jumps / media / paging) and media of one history row."""
    rid = m.get("id") if isinstance(m.get("id"), str) and _ID_RE.fullmatch(m["id"]) else None
    return {"id": rid, "media": media_rows(m.get("media"))}


def steps(v: Any) -> list[dict]:
    return [{"tool": s["tool"], "done": s.get("done") is True} for s in (v if isinstance(v, list) else [])
            if isinstance(s, dict) and isinstance(s.get("tool"), str) and _TOOL_RE.fullmatch(s["tool"])][:8]


def cursor(v: Any) -> str | None:
    return v if isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_-]{6,100}(?:\.[A-Za-z0-9_-]{6,100})?", v) else None
