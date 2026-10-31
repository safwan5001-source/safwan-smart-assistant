"""Assistant (LLM) provider boundary.

No model provider is implemented yet, so the assistant is reported as not
configured and `/assistant/respond` answers 503 instead of inventing a reply.
When one is added it is selected via ASSISTANT_PROVIDER and reads its API key
from the server environment only; keys must never reach the browser bundle.
"""
from __future__ import annotations

from typing import Protocol

from ..config import Settings


class AssistantUnavailable(Exception):
    """Raised when no usable assistant provider is configured."""


class AssistantProvider(Protocol):
    name: str

    def respond(self, messages: list[dict[str, str]]) -> str: ...


_IMPLEMENTED: dict[str, AssistantProvider] = {}  # name -> provider; empty until one is built and verified


def get_provider(settings: Settings) -> AssistantProvider:
    provider = _IMPLEMENTED.get(settings.assistant_provider)
    if provider is None:
        raise AssistantUnavailable(settings.assistant_provider)
    return provider


def provider_status(settings: Settings) -> dict[str, object]:
    configured = settings.assistant_provider in _IMPLEMENTED
    return {"requested": settings.assistant_provider, "configured": configured,
            "status": "ready" if configured else "not_configured"}
