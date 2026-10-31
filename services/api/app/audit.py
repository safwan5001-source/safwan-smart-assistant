"""In-memory audit trail (bounded). Records what was decided, never argument values.

Persistent, tamper-evident storage is a documented follow-up; this keeps the
shape of the records stable so the storage backend can be swapped in.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from threading import Lock
from typing import Any
from uuid import uuid4


class AuditLog:
    def __init__(self, maxlen: int = 500) -> None:
        self._entries: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._lock = Lock()

    def record(self, event: str, **fields: Any) -> dict[str, Any]:
        entry = {"id": str(uuid4()), "ts": datetime.now(timezone.utc).isoformat(), "event": event, **fields}
        with self._lock:
            self._entries.append(entry)
        return entry

    def recent(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._entries)[-limit:][::-1]

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


audit_log = AuditLog()
