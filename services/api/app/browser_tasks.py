"""Chat -> browser worker bridge: /internal/v1/browser/tasks* (read-only browsing of an allow-listed test site).

Authentication: the BFF's HMAC service signature (`require_service_call`), exactly like /internal/v1/ping. The worker's bearer token
(BROWSER_SERVICE_TOKEN) is a *separate* secret that lives only here and in the worker: the web tier never sees it and the browser never
sees either. A valid signature does not open /internal/browser/* and the browser token does not open this router.

Policy enforced here, independently of the worker (defence in depth - the worker re-checks everything):
  * off by default: BROWSER_CHAT_ENABLED must be truthy, otherwise 503 and the worker is never contacted;
  * the target URL must match a closed whitelist pattern (https, example.com, simple path, no port/credentials/query/fragment) - a regex
    over the raw string, not a URL parser, so there is no parser-differential to exploit;
  * the worker address must be the private Railway name (or loopback outside production, for tests); redirects are never followed;
  * everything coming back is re-validated field by field and bounded; unknown fields, raw errors and session identifiers are dropped.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import socket
import unicodedata
from typing import Any
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import browser_token
from .audit import audit_log
from .config import Settings, get_settings
from .service_auth import ServiceCall, require_service_call

log = logging.getLogger("safwan.browser_tasks")

RAILWAY_WORKER = "http://safwan-browser.railway.internal:8080"
_LOOPBACK_WORKER = re.compile(r"http://127\.0\.0\.1:[0-9]{2,5}")
_TRUTHY = {"1", "true", "yes", "on"}

ALLOWED_HOSTS = ("example.com",)  # widening this is a code change that needs a security review, not an environment variable
_URL_RE = re.compile(r"https://(?:%s)(?:/[A-Za-z0-9._~/-]{0,120})?" % "|".join(re.escape(h) for h in ALLOWED_HOSTS))
_RESULT_URL_RE = re.compile(r"https://(?:%s)/[\x21-\x7e]{0,300}" % "|".join(re.escape(h) for h in ALLOWED_HOSTS))
_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")

STEP_IDS = ("create_session", "connect", "navigate", "read", "screenshot", "release")
STEP_STATUSES = {"pending", "running", "done", "failed", "skipped"}
JOB_STATUSES = {"running", "cancelling", "succeeded", "failed", "cancelled"}
ERROR_CODES = {"timeout", "navigation_failed", "disallowed_final_url", "screenshot_too_large", "browser_execution_failed"}

MAX_JOB_JSON = 16_384
MAX_SCREENSHOT = 260_000


class NewTask(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=200)


class _NoRedirect(urllib_request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any):  # noqa: D401, ANN401
        return None  # the worker never redirects; if something does, treat it as an error rather than following it


# ProxyHandler({}): the worker is reached on the private network only - never through an environment proxy (HTTP_PROXY), which would see the bearer token.
_opener = urllib_request.build_opener(urllib_request.ProxyHandler({}), _NoRedirect)


def _open(request: urllib_request.Request, timeout: float):
    """Single seam for tests (monkeypatched). Never follows redirects."""
    return _opener.open(request, timeout=timeout)


def enabled() -> bool:
    return os.environ.get("BROWSER_CHAT_ENABLED", "").strip().lower() in _TRUTHY


def validate_url(value: str) -> str:
    if not _URL_RE.fullmatch(value) or ".." in value.split("/"):
        raise HTTPException(status_code=400, detail={"code": "url_not_allowed"})
    return value


def _worker_base(settings: Settings) -> str | None:
    url = os.environ.get("BROWSER_SERVICE_URL", "").rstrip("/")
    if url == RAILWAY_WORKER:
        return url
    if not settings.is_production and _LOOPBACK_WORKER.fullmatch(url):
        return url
    return None


def _clean_text(value: Any, limit: int) -> str:
    text = value if isinstance(value, str) else ""
    # Page text is untrusted: drop control/format characters (bidi overrides, zero-width) and collapse whitespace.
    text = "".join(ch for ch in text if unicodedata.category(ch) not in ("Cc", "Cf", "Cs", "Co") or ch in "\n\t ")
    return re.sub(r"\s+", " ", text).strip()[:limit]


def clean_job(raw: Any) -> dict[str, Any]:
    """Whitelist-rebuild of the worker's job view. Anything unexpected -> ValueError (becomes a generic 502)."""
    if not isinstance(raw, dict):
        raise ValueError("job")
    job_id, status, url = raw.get("id"), raw.get("status"), raw.get("url")
    if not (isinstance(job_id, str) and _ID_RE.fullmatch(job_id)) or status not in JOB_STATUSES:
        raise ValueError("id/status")
    if not (isinstance(url, str) and _URL_RE.fullmatch(url)):
        raise ValueError("url")
    steps_raw = raw.get("steps")
    if not (isinstance(steps_raw, list) and [s.get("id") if isinstance(s, dict) else None for s in steps_raw] == list(STEP_IDS)):
        raise ValueError("steps")
    steps = []
    for s in steps_raw:
        if s.get("status") not in STEP_STATUSES:
            raise ValueError("step status")
        steps.append({"id": s["id"], "status": s["status"]})
    out: dict[str, Any] = {"id": job_id, "status": status, "url": url, "steps": steps,
                           "sessionReleased": raw.get("sessionReleased") is True}
    for key in ("createdAt", "finishedAt"):
        v = raw.get(key)
        if isinstance(v, int) and not isinstance(v, bool) and 0 < v < 10**14:
            out[key] = v
    if raw.get("error") is not None:
        out["error"] = raw["error"] if raw["error"] in ERROR_CODES else "browser_execution_failed"
    res = raw.get("result")
    if res is not None:
        if not isinstance(res, dict) or not (isinstance(res.get("url"), str) and _RESULT_URL_RE.fullmatch(res["url"])):
            raise ValueError("result")
        out["result"] = {"title": _clean_text(res.get("title"), 200), "url": res["url"],
                         "excerpt": _clean_text(res.get("excerpt"), 4000), "hasScreenshot": res.get("hasScreenshot") is True}
    return out


_UUID_IN_PATH = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def _fail(reason: str, method: str, path: str, status: int | None = None) -> HTTPException:
    """The single place a worker-bridge failure becomes a 502. The client still gets one generic code, but the *class* of failure is
    logged (fixed vocabulary, route shape only): never the exception text, URL, token, headers or page content.

      worker_unconfigured  token/URL unusable, nothing sent       -> 503 (not here)
      invalid_request      urllib refused to build the request    (nothing reached the network)
      dns_failed / connect_failed / timeout                       (internal-network failure)
      worker_unauthorized  worker answered 401/403                (BROWSER_SERVICE_TOKEN differs between the two services)
      worker_rejected      worker answered with another unexpected status
      oversized            worker body over the bound
      invalid_job_view     worker body failed clean_job           (Browserbase failures never land here: they arrive as a *valid* failed job)
    """
    op = f"{method} {_UUID_IN_PATH.sub(':id', path)}"
    log.error("browser worker call failed reason=%s op=%s status=%s", reason, op, status if status is not None else "-")
    return HTTPException(status_code=502, detail={"code": "browser_unavailable"})


def _network_reason(exc: BaseException) -> str:
    inner = exc.reason if isinstance(exc, URLError) else exc
    if isinstance(exc, TimeoutError) or isinstance(inner, TimeoutError):
        return "timeout"
    if isinstance(inner, socket.gaierror):
        return "dns_failed"
    if isinstance(exc, ValueError):  # includes UnicodeEncodeError from a header value
        return "invalid_request"
    return "connect_failed"


def _call_worker(method: str, path: str, body: dict[str, Any] | None, *, timeout: float, max_bytes: int) -> tuple[int, bytes]:
    """Returns (status, body). Raises HTTPException(503) when unconfigured and (502) when the worker is unreachable/misbehaving."""
    settings = get_settings()
    base = _worker_base(settings)
    token = os.environ.get("BROWSER_SERVICE_TOKEN", "")
    if base is None or len(token) < browser_token.MIN_TOKEN_CHARS or not browser_token.header_safe(token) \
            or browser_token.collides_with_service_secret(token):
        log.error("browser worker not configured reason=worker_unconfigured url_ok=%s token_len_ok=%s token_header_safe=%s",
                  base is not None, len(token) >= browser_token.MIN_TOKEN_CHARS, browser_token.header_safe(token))
        raise HTTPException(status_code=503, detail={"code": "browser_unconfigured"})
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": "Bearer " + token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib_request.Request(base + path, data, headers, method=method)
    try:
        with _open(req, timeout) as resp:
            status, raw = resp.status, resp.read(max_bytes + 1)
    except HTTPError as exc:
        status, raw = exc.code, exc.read(max_bytes + 1) if exc.fp else b""
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        raise _fail(_network_reason(exc), method, path) from None
    if len(raw) > max_bytes:
        raise _fail("oversized", method, path, status)
    return status, raw


def _job_from(status: int, raw: bytes, ok: tuple[int, ...], method: str, path: str) -> dict[str, Any]:
    if status == 404:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    if status == 429:
        raise HTTPException(status_code=409, detail={"code": "busy"})
    if status == 400:
        raise HTTPException(status_code=400, detail={"code": "url_not_allowed"})
    if status not in ok:
        raise _fail("worker_unauthorized" if status in (401, 403) else "worker_rejected", method, path, status)
    try:
        return {"task": clean_job(json.loads(raw).get("job"))}
    except (ValueError, TypeError, AttributeError):
        raise _fail("invalid_job_view", method, path, status) from None


def _require_enabled() -> None:
    if not enabled():
        raise HTTPException(status_code=503, detail={"code": "browser_chat_disabled"})


def _task_id(value: str) -> str:
    if not _ID_RE.fullmatch(value):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    return value


router = APIRouter(prefix="/internal/v1/browser", include_in_schema=False)


@router.post("/tasks", status_code=202)
def create_task(payload: NewTask, _: ServiceCall = Depends(require_service_call)) -> dict[str, Any]:
    _require_enabled()
    url = validate_url(payload.url)
    status, raw = _call_worker("POST", "/v1/jobs", {"url": url}, timeout=10, max_bytes=MAX_JOB_JSON)
    result = _job_from(status, raw, (202,), "POST", "/v1/jobs")
    audit_log.record("browser.task.create", actor="bff", host=ALLOWED_HOSTS[0], task=result["task"]["id"], status="started")
    return result


@router.get("/tasks/{task_id}")
def get_task(task_id: str, _: ServiceCall = Depends(require_service_call)) -> dict[str, Any]:
    _require_enabled()
    path = f"/v1/jobs/{_task_id(task_id)}"
    status, raw = _call_worker("GET", path, None, timeout=5, max_bytes=MAX_JOB_JSON)
    return _job_from(status, raw, (200,), "GET", path)


@router.post("/tasks/{task_id}/cancel")
def cancel_task(task_id: str, _: ServiceCall = Depends(require_service_call)) -> dict[str, Any]:
    _require_enabled()
    path = f"/v1/jobs/{_task_id(task_id)}/cancel"
    status, raw = _call_worker("POST", path, None, timeout=10, max_bytes=MAX_JOB_JSON)
    result = _job_from(status, raw, (200,), "POST", path)
    audit_log.record("browser.task.cancel", actor="bff", task=result["task"]["id"], status=result["task"]["status"])
    return result


@router.get("/tasks/{task_id}/screenshot")
def task_screenshot(task_id: str, _: ServiceCall = Depends(require_service_call)) -> dict[str, Any]:
    _require_enabled()
    status, raw = _call_worker("GET", f"/v1/jobs/{_task_id(task_id)}/screenshot", None, timeout=10, max_bytes=MAX_SCREENSHOT)
    if status == 404:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    if status != 200 or not raw.startswith(b"\xff\xd8\xff"):  # a JPEG, nothing else (no HTML/SVG that could execute when displayed)
        raise _fail("worker_unauthorized" if status in (401, 403) else "worker_rejected" if status != 200 else "invalid_screenshot",
                    "GET", "/v1/jobs/:id/screenshot", status)
    return {"mimeType": "image/jpeg", "base64": base64.b64encode(raw).decode("ascii")}
