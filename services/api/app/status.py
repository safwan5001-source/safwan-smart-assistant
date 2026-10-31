"""Public, minimal and truthful service status (shared by /health and the signed internal ping)."""
from __future__ import annotations

import os
from typing import Any

from .assistant import provider_status
from .config import SERVICE_VERSION, Settings
from .integrations import CATALOG, resolve_status


def integration_summary() -> dict[str, int]:
    statuses = [resolve_status(spec, os.environ).value for spec in CATALOG]
    return {"total": len(statuses), "connected": statuses.count("connected")}


def health_payload(settings: Settings) -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "orchestrator-foundation",
        "version": SERVICE_VERSION,
        "features": {
            "assistant": bool(provider_status(settings)["configured"]),
            "connected_integrations": integration_summary()["connected"],
            "task_execution": False,
        },
    }
