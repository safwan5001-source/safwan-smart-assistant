"""Server-side Anthropic implementation; no secrets or model content in logs."""
from __future__ import annotations

import json
import os
from urllib import request
from urllib.error import HTTPError, URLError
from typing import Protocol

from ..config import Settings


class AssistantUnavailable(Exception):
    """The provider is not configured or could not return a valid response."""


class AssistantProvider(Protocol):
    name: str
    def respond(self, messages: list[dict[str, str]]) -> str: ...


class AnthropicProvider:
    name = "anthropic"

    def respond(self, messages: list[dict[str, str]]) -> str:
        key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        model = os.environ.get("ANTHROPIC_MODEL", "").strip()
        if not key or not model:
            raise AssistantUnavailable("not_configured")
        # Client-provided system messages cannot override the server's policy.
        turns = [
            {"role": m["role"], "content": m["content"]}
            for m in messages
            if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
        ]
        if not turns or turns[-1]["role"] != "user":
            raise AssistantUnavailable("invalid_conversation")
        payload = json.dumps({
            "model": model,
            "max_tokens": min(max(int(os.environ.get("ANTHROPIC_MAX_OUTPUT_TOKENS", "1024")), 1), 4096),
            "messages": turns[-40:],
        }).encode("utf-8")
        req = request.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={
                "x-api-key": key, "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=45) as res:
                raw = res.read(256_001)
                if len(raw) > 256_000:
                    raise AssistantUnavailable("response_too_large")
                data = json.loads(raw)
        except (HTTPError, URLError, TimeoutError, ValueError, OSError):
            raise AssistantUnavailable("provider_request_failed") from None
        answer = "".join(
            block.get("text", "")
            for block in data.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        )
        if not answer.strip():
            raise AssistantUnavailable("empty_provider_response")
        return answer


def get_provider(settings: Settings) -> AssistantProvider:
    if settings.assistant_provider != "anthropic" or not os.environ.get("ANTHROPIC_API_KEY") or not os.environ.get("ANTHROPIC_MODEL"):
        raise AssistantUnavailable("not_configured")
    return AnthropicProvider()


def provider_status(settings: Settings) -> dict[str, object]:
    configured = (
        settings.assistant_provider == "anthropic"
        and bool(os.environ.get("ANTHROPIC_API_KEY"))
        and bool(os.environ.get("ANTHROPIC_MODEL"))
    )
    return {
        "requested": settings.assistant_provider,
        "configured": configured,
        "status": "ready" if configured else "not_configured",
    }
