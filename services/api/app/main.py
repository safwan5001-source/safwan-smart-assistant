from enum import Enum
from uuid import uuid4
from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="Safwan Assistant API", version="0.1.0")

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

@app.post("/tasks", response_model=TaskReceipt, status_code=202)
def create_task(request: TaskRequest) -> TaskReceipt:
    # Deliberately does not persist, dispatch or execute anything yet.
    return TaskReceipt(task_id=str(uuid4()), status="not_scheduled", permission_mode=request.permission_mode,
                       message="Foundation only: task was not saved or executed.")
