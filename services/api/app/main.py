import os
import json
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field

from . import browser_token
from .assistant import AssistantUnavailable, get_provider, provider_status
from .audit import audit_log
from .browser_tasks import router as browser_tasks_router
from .body_limit import BodyLimitMiddleware
from .config import SERVICE_VERSION, Settings, get_settings
from .integrations import CATALOG, get_integration, resolve_status
from .internal import router as internal_router
from .permissions import PermissionMode, Risk, policy_matrix
from .security import require_auth
from .status import health_payload, integration_summary
from .tools import execute_tool, registry
from .tools.builtin import register_builtin

app = FastAPI(title="Safwan Assistant API", version=SERVICE_VERSION)
register_builtin(registry)
app.include_router(internal_router)
app.include_router(browser_tasks_router)
# Ceilings applied BEFORE any body is buffered (independent review IR-A1). The browser routes take a ~100-byte JSON; the signed
# prefix matches service_auth.MAX_BODY_BYTES. This layer only rejects; each route keeps its own authentication.
app.add_middleware(BodyLimitMiddleware, limits=[("/internal/browser/", 4096), ("/internal/v1/browser/", 4096), ("/internal/", 1_048_576)])


class TaskRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=4000)
    permission_mode: PermissionMode


class TaskReceipt(BaseModel):
    task_id: str
    status: str
    permission_mode: PermissionMode
    message: str


class ToolExecuteRequest(BaseModel):
    tool: str = Field(min_length=1, max_length=100)
    arguments: dict[str, Any] = Field(default_factory=dict, max_length=20)
    permission_mode: PermissionMode


class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant|system)$")
    content: str = Field(min_length=1, max_length=8000)


class AssistantRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=50)


class BrowserSmokeRequest(BaseModel):
    url: str = Field(default="https://example.com", max_length=200)


@app.post("/internal/browser/smoke")
def browser_smoke(payload: BrowserSmokeRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """Owner-controlled diagnostic. Does not change normal production authentication."""
    expected = os.environ.get("BROWSER_SERVICE_TOKEN", "")
    if not browser_token.authorized(authorization):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if payload.url != "https://example.com":
        raise HTTPException(status_code=400, detail="Only example.com may be tested")
    host = os.environ.get("BROWSER_SERVICE_URL", "").rstrip("/")
    if host != "http://safwan-browser.railway.internal:8080":
        raise HTTPException(status_code=503, detail="Browser worker is not configured")
    body = json.dumps({"url": payload.url}).encode("utf-8")
    req = urllib_request.Request(host + "/v1/navigate", body, {
        "Authorization": "Bearer " + expected, "Content-Type": "application/json"
    }, method="POST")
    try:
        with urllib_request.urlopen(req, timeout=35) as response:
            data = json.load(response)
    except (HTTPError, URLError, TimeoutError, ValueError):
        raise HTTPException(status_code=502, detail="Browser worker request failed") from None
    return {"ok": data.get("ok") is True, "title": str(data.get("title", ""))[:200]}


@app.post("/internal/browser/read")
def browser_read(payload: BrowserSmokeRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """Private read-only proof of concept. Never expose its service token to browsers."""
    expected = os.environ.get("BROWSER_SERVICE_TOKEN", "")
    if not browser_token.authorized(authorization):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if payload.url not in ("https://example.com", "https://example.com/"):
        raise HTTPException(status_code=400, detail="Only example.com may be tested")
    host = os.environ.get("BROWSER_SERVICE_URL", "").rstrip("/")
    if host != "http://safwan-browser.railway.internal:8080":
        raise HTTPException(status_code=503, detail="Browser worker is not configured")
    req = urllib_request.Request(
        host + "/v1/navigate",
        json.dumps({"url": payload.url}).encode("utf-8"),
        {"Authorization": "Bearer " + expected, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=40) as response:
            raw = response.read(400_001)
            if len(raw) > 400_000:
                raise ValueError("Oversized browser response")
            data = json.loads(raw)
        shot = data.get("screenshot")
        if not isinstance(shot, dict) or shot.get("mimeType") != "image/jpeg":
            raise ValueError("Missing JPEG")
        base64_value = shot.get("base64")
        if not isinstance(base64_value, str) or len(base64_value) > 335_000:
            raise ValueError("Invalid JPEG payload")
        if data.get("ok") is not True:
            raise ValueError("Browse failed")
        return {
            "ok": True,
            "title": str(data.get("title", ""))[:200],
            "url": str(data.get("url", ""))[:500],
            "excerpt": str(data.get("excerpt", ""))[:4000],
            "screenshot": {"mimeType": "image/jpeg", "base64": base64_value},
        }
    except (HTTPError, URLError, TimeoutError, ValueError, TypeError):
        raise HTTPException(status_code=502, detail="Browser read failed") from None


@app.get("/health")
def health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Public, minimal and truthful: what is actually running right now."""
    return health_payload(settings)


@app.get("/capabilities")
def capabilities(settings: Settings = Depends(get_settings), _: str = Depends(require_auth)) -> dict[str, Any]:
    tools = registry.all()
    return {
        "environment": settings.env,
        "auth_mode": settings.auth_mode,
        "assistant": provider_status(settings),
        "tools": {"total": len(tools), "implemented": sum(t.implemented for t in tools)},
        "integrations": integration_summary(),
        "task_execution": False,
    }


@app.get("/permissions/policy")
def permissions_policy(_: str = Depends(require_auth)) -> dict[str, Any]:
    return {"modes": [m.value for m in PermissionMode], "risks": [r.value for r in Risk], "matrix": policy_matrix()}


@app.get("/tools")
def list_tools(_: str = Depends(require_auth)) -> dict[str, Any]:
    return {"tools": [t.public() for t in registry.all()]}


@app.post("/tools/execute")
def run_tool(request: ToolExecuteRequest, actor: str = Depends(require_auth)) -> dict[str, Any]:
    result = execute_tool(registry, request.tool, request.arguments, request.permission_mode, actor=actor)
    if result.status == "unknown_tool":
        raise HTTPException(status_code=404, detail={"code": "unknown_tool", "message": "Unknown tool."})
    return result.public()


@app.get("/integrations")
def list_integrations(_: str = Depends(require_auth)) -> dict[str, Any]:
    return {"integrations": [spec.public(os.environ) for spec in CATALOG]}


@app.get("/integrations/{integration_id}")
def get_one_integration(integration_id: str, _: str = Depends(require_auth)) -> dict[str, Any]:
    spec = get_integration(integration_id)
    if spec is None:
        raise HTTPException(status_code=404, detail={"code": "unknown_integration", "message": "Unknown integration."})
    return spec.public(os.environ)


@app.post("/assistant/respond")
def assistant_respond(
    request: AssistantRequest, settings: Settings = Depends(get_settings), _: str = Depends(require_auth)
) -> dict[str, str]:
    try:
        provider = get_provider(settings)
    except AssistantUnavailable:
        raise HTTPException(
            status_code=503,
            detail={"code": "assistant_not_configured", "message": "No AI provider is configured; no reply was generated."},
        ) from None
    return {"provider": provider.name, "content": provider.respond([m.model_dump() for m in request.messages])}


@app.get("/audit")
def get_audit(limit: int = Query(50, ge=1, le=200), _: str = Depends(require_auth)) -> dict[str, Any]:
    return {"entries": audit_log.recent(limit)}


@app.post("/tasks", response_model=TaskReceipt, status_code=202)
def create_task(request: TaskRequest, actor: str = Depends(require_auth)) -> TaskReceipt:
    # Deliberately does not persist, dispatch or execute anything yet.
    audit_log.record("task.receive", actor=actor, mode=request.permission_mode.value, status="not_scheduled")
    return TaskReceipt(task_id=str(uuid4()), status="not_scheduled", permission_mode=request.permission_mode,
                       message="Foundation only: task was not saved or executed.")
