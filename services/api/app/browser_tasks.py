"""Chat -> browser worker bridge: /internal/v1/browser/tasks* (read-only browsing of an allow-listed test site, and - CHAT-BROWSER-2 -
interactive sessions: navigate / click / type inside an owner-configured *lab scope*, with a per-step user approval for anything that
could change data).

Authentication: the BFF's HMAC service signature (`require_service_call`), exactly like /internal/v1/ping. The worker's bearer token
(BROWSER_SERVICE_TOKEN) is a *separate* secret that lives only here and in the worker: the web tier never sees it and the browser never
sees either. A valid signature does not open /internal/browser/* and the browser token does not open this router.

Policy enforced here, independently of the worker (defence in depth - the worker re-checks everything):
  * off by default: BROWSER_CHAT_ENABLED must be truthy, otherwise 503 and the worker is never contacted;
  * the target URL must match a closed whitelist pattern (https, example.com, simple path, no port/credentials/query/fragment) - a regex
    over the raw string, not a URL parser, so there is no parser-differential to exploit;
  * the worker address must be the private Railway name (or loopback outside production, for tests); redirects are never followed;
  * everything coming back is re-validated field by field and bounded; unknown fields, raw errors and session identifiers are dropped;
  * interactive control exists only when BROWSER_INTERACTIVE_SCOPES lists at least one valid `host/prefix/` scope (empty = OFF), and every
    action is rebuilt from a closed schema (structured locators, no selectors, no scripts). Typed text is forwarded and NEVER logged,
    audited or echoed back. Approval/reject calls carry no payload: they refer to the one pending step the worker shows.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import socket
import unicodedata
from typing import Any, Literal
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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

# Interactive "lab" scopes: `host/prefix/` entries (owner-configured, EMPTY = interactive control is OFF). Same grammar as the worker's
# parseScopes; an invalid entry disables the whole feature here (fail closed) rather than being skipped.
_SCOPE_RE = re.compile(r"((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])(/(?:[A-Za-z0-9._~-]{1,40}/){1,6})")
_INTERNAL_TLD = re.compile(r".*\.(internal|local|localhost|localdomain|lan|home|corp|intranet)")


def interactive_scopes() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for raw in os.environ.get("BROWSER_INTERACTIVE_SCOPES", "").split(","):
        raw = raw.strip()
        if not raw:
            continue
        m = _SCOPE_RE.fullmatch(raw)
        if not m or _INTERNAL_TLD.fullmatch(m.group(1)) or ".." in raw or len(raw) > 120:
            log.error("BROWSER_INTERACTIVE_SCOPES has an invalid entry: interactive control stays OFF")
            return []
        out.append((m.group(1), m.group(2)))
    return out


def _session_url_re() -> re.Pattern[str]:
    """Start page / navigation target of an interactive session: a look-only host page, or a page INSIDE a lab scope."""
    alts = [_URL_RE.pattern] + [r"https://%s%s[A-Za-z0-9._~/-]{0,100}" % (re.escape(h), re.escape(p)) for h, p in interactive_scopes()]
    return re.compile("|".join(f"(?:{a})" for a in alts))


def _session_result_re() -> re.Pattern[str]:
    alts = [_RESULT_URL_RE.pattern] + [r"https://%s%s[\x21-\x7e]{0,250}" % (re.escape(h), re.escape(p)) for h, p in interactive_scopes()]
    return re.compile("|".join(f"(?:{a})" for a in alts))
_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")

STEP_IDS = ("create_session", "connect", "navigate", "read", "screenshot", "release")
INTERACTIVE_STEP_IDS = ("create_session", "connect", "navigate", "interact", "release")
TOOLS = ("navigate", "click", "type", "observe")
ROLES = ("button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "switch", "tab")
ACTION_STATUSES = {"queued", "running", "awaiting_approval", "done", "failed", "denied", "rejected", "cancelled"}
ACTION_ERRORS = {
    "element_not_found", "element_ambiguous", "element_hidden", "element_disabled", "not_in_lab", "sensitive_field", "sensitive_action",
    "sensitive_value", "file_upload_blocked", "download_blocked", "leaves_scope", "not_editable", "element_changed", "approval_rejected",
    "approval_timeout", "action_timeout", "action_failed", "navigation_failed",
}
END_REASONS = {"finished", "idle", "limit"}
# Errors the worker may answer an action call with -> what the caller learns (all other worker answers are a generic failure).
ACTION_CONFLICTS = {"action_in_progress", "limit_reached", "not_ready", "session_ended", "not_interactive", "no_pending_approval"}
MAX_ACTIONS = 20
STEP_STATUSES = {"pending", "running", "done", "failed", "skipped"}
JOB_STATUSES = {"running", "cancelling", "succeeded", "failed", "cancelled"}
ERROR_CODES = {"timeout", "navigation_failed", "disallowed_final_url", "screenshot_too_large", "browser_execution_failed"}

MAX_JOB_JSON = 16_384
MAX_SCREENSHOT = 260_000


class NewTask(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=200)
    mode: Literal["read", "interactive"] = "read"


# Control, bidi and zero-width characters: never forwarded to the worker (mirror of the worker's own check; each layer validates alone).
_UNSAFE = re.compile("[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]")


class Locator(BaseModel):
    """A structured Playwright locator. There is no free-form selector: no css/xpath/`>>` chains/`internal:` engines can be expressed."""
    model_config = ConfigDict(extra="forbid")
    by: Literal["role", "label", "placeholder", "text"]
    role: Literal["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "switch", "tab"] | None = None
    value: str = Field(min_length=1, max_length=80)
    exact: bool = False

    @field_validator("value")
    @classmethod
    def _value(cls, v: str) -> str:
        if _UNSAFE.search(v) or not v.strip():
            raise ValueError("value")
        return v.strip()

    @model_validator(mode="after")
    def _role(self) -> "Locator":
        if (self.by == "role") != (self.role is not None):
            raise ValueError("role")
        return self


class NewAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool: Literal["navigate", "click", "type", "observe"]
    url: str | None = Field(default=None, max_length=200)
    target: Locator | None = None
    text: str | None = Field(default=None, max_length=200)

    @field_validator("text")
    @classmethod
    def _text(cls, v: str | None) -> str | None:
        if v is not None and _UNSAFE.search(v):
            raise ValueError("text")
        return v

    @model_validator(mode="after")
    def _shape(self) -> "NewAction":
        need = {"navigate": ("url",), "click": ("target",), "type": ("target", "text"), "observe": ()}[self.tool]
        given = {k for k in ("url", "target", "text") if getattr(self, k) is not None}
        if given != set(need):
            raise ValueError("fields")
        return self

    def to_worker(self) -> dict[str, Any]:
        """Rebuilt from validated fields only (never forwards what the caller sent verbatim)."""
        out: dict[str, Any] = {"tool": self.tool}
        if self.url is not None:
            out["url"] = self.url
        if self.target is not None:
            t = self.target
            out["target"] = {"by": t.by, **({"role": t.role} if t.by == "role" else {}), "value": t.value, "exact": t.exact}
        if self.text is not None:
            out["text"] = self.text
        return out


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


def interactive_enabled() -> bool:
    return enabled() and bool(interactive_scopes())


def validate_session_url(value: str) -> str:
    """Start page / `navigate` target of an interactive session. A regex over the raw string (no URL parser), like validate_url."""
    if not _session_url_re().fullmatch(value) or ".." in value.split("/"):
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


def _bounded_int(v: Any, lo: int, hi: int) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi else None


def clean_job(raw: Any) -> dict[str, Any]:
    """Whitelist-rebuild of the worker's job view. Anything unexpected -> ValueError (becomes a generic 502)."""
    if not isinstance(raw, dict):
        raise ValueError("job")
    job_id, status, url = raw.get("id"), raw.get("status"), raw.get("url")
    if not (isinstance(job_id, str) and _ID_RE.fullmatch(job_id)) or status not in JOB_STATUSES:
        raise ValueError("id/status")
    interactive = raw.get("mode") == "interactive"
    if raw.get("mode") not in (None, "interactive"):
        raise ValueError("mode")
    if interactive and not interactive_scopes():
        raise ValueError("interactive disabled")  # the worker must never hand us an interactive session we did not authorize
    url_re = _session_url_re() if interactive else _URL_RE
    result_re = _session_result_re() if interactive else _RESULT_URL_RE
    if not (isinstance(url, str) and url_re.fullmatch(url)):
        raise ValueError("url")
    expected_steps = list(INTERACTIVE_STEP_IDS if interactive else STEP_IDS)
    steps_raw = raw.get("steps")
    if not (isinstance(steps_raw, list) and [s.get("id") if isinstance(s, dict) else None for s in steps_raw] == expected_steps):
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
        if not isinstance(res, dict) or not (isinstance(res.get("url"), str) and result_re.fullmatch(res["url"])):
            raise ValueError("result")
        out["result"] = {"title": _clean_text(res.get("title"), 200), "url": res["url"],
                         "excerpt": _clean_text(res.get("excerpt"), 4000), "hasScreenshot": res.get("hasScreenshot") is True}
        if interactive and (ver := _bounded_int(res.get("version"), 0, 10**6)) is not None:
            out["result"]["version"] = ver
    if interactive:
        out.update(_clean_interactive(raw, result_re))
    return out


def _clean_interactive(raw: dict[str, Any], url_re: re.Pattern[str]) -> dict[str, Any]:
    out: dict[str, Any] = {"mode": "interactive", "ready": raw.get("ready") is True}
    limits = raw.get("limits")
    if not isinstance(limits, dict):
        raise ValueError("limits")
    clean_limits = {k: _bounded_int(limits.get(k), 1, 3_600_000) for k in ("maxActions", "deadlineMs", "idleMs", "approvalMs")}
    if None in clean_limits.values() or clean_limits["maxActions"] > MAX_ACTIONS:
        raise ValueError("limits")
    out["limits"] = clean_limits
    if (d := _bounded_int(raw.get("deadlineAt"), 1, 10**14)) is not None:
        out["deadlineAt"] = d
    out["blockedRequests"] = _bounded_int(raw.get("blockedRequests"), 0, 10**6) or 0
    actions_raw = raw.get("actions")
    if not isinstance(actions_raw, list) or len(actions_raw) > MAX_ACTIONS:
        raise ValueError("actions")
    actions = []
    for i, a in enumerate(actions_raw, start=1):
        if not isinstance(a, dict) or a.get("seq") != i or a.get("tool") not in TOOLS or a.get("status") not in ACTION_STATUSES:
            raise ValueError("action")
        item = {"seq": i, "tool": a["tool"], "status": a["status"], "summary": _clean_text(a.get("summary"), 300)}
        if a.get("error") is not None:
            item["error"] = a["error"] if a["error"] in ACTION_ERRORS else "action_failed"
        actions.append(item)
    out["actions"] = actions
    if raw.get("endReason") in END_REASONS:
        out["endReason"] = raw["endReason"]
    p = raw.get("pending")
    if p is not None:
        seq = _bounded_int(p.get("seq") if isinstance(p, dict) else None, 1, MAX_ACTIONS)
        if seq is None or p.get("kind") not in ("submit", "button"):
            raise ValueError("pending")
        pend = {"seq": seq, "kind": p["kind"], "summary": _clean_text(p.get("summary"), 300)}
        if (e := _bounded_int(p.get("expiresAt"), 1, 10**14)) is not None:
            pend["expiresAt"] = e
        el = p.get("element")
        if el is not None:
            if not isinstance(el, dict):
                raise ValueError("pending.element")
            tag = _clean_text(el.get("tag"), 20)
            if not re.fullmatch(r"[a-z][a-z0-9]{0,19}", tag):
                raise ValueError("pending.element.tag")
            pend["element"] = {"tag": tag, "text": _clean_text(el.get("text"), 120)}
            if el.get("role"):
                pend["element"]["role"] = _clean_text(el.get("role"), 30)
        if p.get("submitsTo") is not None:
            if not (isinstance(p["submitsTo"], str) and url_re.fullmatch(p["submitsTo"])):
                raise ValueError("pending.submitsTo")
            pend["submitsTo"] = p["submitsTo"]
        out["pending"] = pend
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


def _worker_error(raw: bytes) -> str | None:
    try:
        v = json.loads(raw).get("error")
        return v if isinstance(v, str) and len(v) < 40 else None
    except (ValueError, TypeError, AttributeError):
        return None


def _job_from(status: int, raw: bytes, ok: tuple[int, ...], method: str, path: str) -> dict[str, Any]:
    if status == 404:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    if status == 429:
        raise HTTPException(status_code=409, detail={"code": "busy"})
    if status == 403 and _worker_error(raw) == "interactive_disabled":
        raise HTTPException(status_code=503, detail={"code": "interactive_disabled"})
    if status == 409:
        err = _worker_error(raw)
        raise HTTPException(status_code=409, detail={"code": err if err in ACTION_CONFLICTS else "conflict"})
    if status == 400:
        raise HTTPException(status_code=400, detail={"code": "url_not_allowed" if _worker_error(raw) == "url_not_allowed" else "invalid_request"})
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
    body: dict[str, Any]
    if payload.mode == "interactive":
        if not interactive_scopes():
            raise HTTPException(status_code=503, detail={"code": "interactive_disabled"})
        body = {"url": validate_session_url(payload.url), "mode": "interactive"}
    else:
        body = {"url": validate_url(payload.url)}
    status, raw = _call_worker("POST", "/v1/jobs", body, timeout=10, max_bytes=MAX_JOB_JSON)
    result = _job_from(status, raw, (202,), "POST", "/v1/jobs")
    # host only: never the path, never anything a page or a user typed
    host = payload.url.split("/")[2]
    audit_log.record("browser.session.start" if payload.mode == "interactive" else "browser.task.create", actor="bff", host=host, task=result["task"]["id"], status="started")
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


# ── interactive control (CHAT-BROWSER-2) ─────────────────────────────────────────────────────────────────────────────────────────────
def _require_interactive() -> None:
    _require_enabled()
    if not interactive_scopes():
        raise HTTPException(status_code=503, detail={"code": "interactive_disabled"})


@router.post("/tasks/{task_id}/actions", status_code=202)
def queue_action(task_id: str, payload: NewAction, _: ServiceCall = Depends(require_service_call)) -> dict[str, Any]:
    """Queue ONE action. The text of a `type` action is forwarded and then forgotten: it is not logged, audited or returned."""
    _require_interactive()
    tid = _task_id(task_id)
    if payload.tool == "navigate":
        validate_session_url(payload.url or "")
    path = f"/v1/jobs/{tid}/actions"
    status, raw = _call_worker("POST", path, payload.to_worker(), timeout=10, max_bytes=MAX_JOB_JSON)
    result = _job_from(status, raw, (202,), "POST", path)
    audit_log.record("browser.action.queued", actor="bff", task=tid, tool=payload.tool, seq=len(result["task"]["actions"]))
    return result


def _decide(task_id: str, seq: int, verb: str) -> dict[str, Any]:
    _require_interactive()
    tid = _task_id(task_id)
    if not 1 <= seq <= MAX_ACTIONS:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    path = f"/v1/jobs/{tid}/actions/{seq}/{verb}"
    status, raw = _call_worker("POST", path, {}, timeout=10, max_bytes=MAX_JOB_JSON)
    result = _job_from(status, raw, (200,), "POST", path)
    audit_log.record(f"browser.action.{verb}", actor="bff", task=tid, seq=seq)
    return result


@router.post("/tasks/{task_id}/actions/{seq}/approve")
def approve_action(task_id: str, seq: int, _: ServiceCall = Depends(require_service_call)) -> dict[str, Any]:
    return _decide(task_id, seq, "approve")


@router.post("/tasks/{task_id}/actions/{seq}/reject")
def reject_action(task_id: str, seq: int, _: ServiceCall = Depends(require_service_call)) -> dict[str, Any]:
    return _decide(task_id, seq, "reject")


@router.post("/tasks/{task_id}/finish")
def finish_task(task_id: str, _: ServiceCall = Depends(require_service_call)) -> dict[str, Any]:
    _require_interactive()
    path = f"/v1/jobs/{_task_id(task_id)}/finish"
    status, raw = _call_worker("POST", path, {}, timeout=10, max_bytes=MAX_JOB_JSON)
    result = _job_from(status, raw, (200,), "POST", path)
    audit_log.record("browser.session.finish", actor="bff", task=result["task"]["id"], status=result["task"]["status"])
    return result
