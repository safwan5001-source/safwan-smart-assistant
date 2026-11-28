"""Public, minimal and truthful service status (shared by /health and the signed internal ping)."""
from __future__ import annotations

import os
from typing import Any

from .assistant import provider_status
from .auth.owner import config as owner_auth_config
from .basht_chat import configured as basht_chat_configured
from .basht_core import core_state
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
            # LEGACY (R11): "a direct-provider key is CONFIGURED", never "it works" and never "BASHT is ready". The app UI no longer draws
            # a badge from it (only the legacy direct-Claude chat path reads it); BASHT's readiness is `basht` below plus the engine's own
            # /status read through GET /internal/v1/basht/engine-status. Kept (additive-only contract) so a web build from before this
            # change, deployed on its own, still accepts this answer.
            "assistant": bool(provider_status(settings)["configured"]),
            "connected_integrations": integration_summary()["connected"],  # LEGACY: counts the old env-driven catalogue; the UI shows none of it
            "task_execution": False,
            # BASHT Core Integration C1: coarse engine state (unconfigured / connected / starting / offline), cached 60 s
            "basht": core_state(os.environ),
            # C2/C4: the app can read and chat with BASHT (engine URL + app token present; never the token itself)
            "basht_chat": basht_chat_configured(os.environ),
            # A1: one owner session (code / passkey) is available; passkeys only once the app's permanent domain is set
            **{k: v for k, v in owner_auth_config(settings).items()},
        },
    }
