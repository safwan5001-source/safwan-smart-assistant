"""Validation-only contracts for a future authenticated synchronization API.

No endpoint or persistence is enabled by importing this module.
Ownership must come from a verified server session, never from request data.
"""
from datetime import datetime
from enum import Enum
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

class SyncKind(str, Enum):
    conversation = "conversation"
    message = "message"
    task = "task"
    attachment = "attachment"

class SyncAction(str, Enum):
    upsert = "upsert"
    delete = "delete"

class LocalRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    local_id: UUID
    kind: SyncKind
    action: SyncAction
    revision: int = Field(ge=0)
    updated_at: datetime
    payload: dict[str, str | int | bool | None] | None = None

    @field_validator("updated_at")
    @classmethod
    def aware_timestamp(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Timezone is required")
        return value

    @model_validator(mode="after")
    def action_payload(self):
        if self.action == SyncAction.delete and self.payload is not None:
            raise ValueError("Deletes must not include payload")
        if self.action == SyncAction.upsert and self.payload is None:
            raise ValueError("Upserts must include payload")
        return self

class ImportPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    records: list[LocalRecord] = Field(min_length=1, max_length=100)
    dry_run: bool = True

    @model_validator(mode="after")
    def require_safe_preview(self):
        if not self.dry_run:
            raise ValueError("Phase 5 foundation supports dry-run validation only")
        identifiers = [(r.kind, r.local_id) for r in self.records]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("Duplicate local IDs in batch")
        return self

class SyncConflict(BaseModel):
    local_id: UUID
    kind: SyncKind
    server_revision: int = Field(ge=0)
    client_revision: int = Field(ge=0)
    reason: str
