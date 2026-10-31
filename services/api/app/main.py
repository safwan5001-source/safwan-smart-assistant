import os
from enum import Enum
from uuid import uuid4
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Safwan Assistant API", version="0.1.0")
from .preview_session_http import router as preview_session_router
app.include_router(preview_session_router)

class PermissionMode(str, Enum):
    review = "review"
    execute = "execute"
    approve = "approve"

class TaskRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=4000)
    permission_mode: PermissionMode

class TaskReceipt(BaseModel):
    task_id: str
    status: str
    permission_mode: PermissionMode
    message: str

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "orchestrator-foundation"}


@app.get("/health/neon")
def neon_preview_health() -> dict[str, str]:
    # Preview-only, read-only connectivity probe; never emit credentials or raw exceptions.
    if os.getenv("VERCEL_ENV") != "preview":
        raise HTTPException(status_code=404, detail="Not found")
    try:
        import psycopg
        from .neon_probe import probe_neon
        connected = probe_neon(psycopg.connect)
    except Exception:
        raise HTTPException(status_code=503, detail="Neon preview connectivity unavailable") from None
    if not connected:
        raise HTTPException(status_code=503, detail="Neon preview connectivity unavailable")
    return {"status": "ok", "database": "connected", "mode": "read-only"}

@app.post("/tasks", response_model=TaskReceipt, status_code=202)
def create_task(request: TaskRequest) -> TaskReceipt:
    # Deliberately does not persist, dispatch or execute anything yet.
    return TaskReceipt(task_id=str(uuid4()), status="not_scheduled", permission_mode=request.permission_mode,
                       message="Foundation only: task was not saved or executed.")
