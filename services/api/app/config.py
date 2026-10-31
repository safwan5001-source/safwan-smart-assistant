"""Runtime settings, read from the environment on every call (no import-time side effects).

Secrets (API keys, tokens) live only in server-side environment variables and
are never returned by any endpoint.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

SERVICE_VERSION = "0.2.0"
_TRUTHY = {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    env: str
    dev_auth_requested: bool
    dev_auth_token: str | None
    assistant_provider: str

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def dev_auth_enabled(self) -> bool:
        """Experimental auth is never active in production, whatever the flags say."""
        return (not self.is_production) and self.dev_auth_requested and bool(self.dev_auth_token)

    @property
    def auth_mode(self) -> str:
        if self.is_production:
            return "locked"  # real authentication not implemented: protected routes fail closed
        return "dev_token" if self.dev_auth_enabled else "open_dev"


def get_settings() -> Settings:
    # Fail closed: anything other than an explicit development/test environment is production.
    env = os.environ.get("APP_ENV", "production").strip().lower()
    if env not in {"development", "test"} or os.environ.get("VERCEL_ENV", "").lower() == "production":
        env = "production"
    return Settings(
        env=env,
        dev_auth_requested=os.environ.get("ENABLE_DEV_AUTH", "").strip().lower() in _TRUTHY,
        dev_auth_token=os.environ.get("DEV_AUTH_TOKEN") or None,
        assistant_provider=os.environ.get("ASSISTANT_PROVIDER", "none").strip().lower() or "none",
    )
