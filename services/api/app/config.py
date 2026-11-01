"""Runtime settings, read from the environment on every call (no import-time side effects).

Secrets (API keys, tokens) live only in server-side environment variables and
are never returned by any endpoint.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

SERVICE_VERSION = "0.3.0"
_TRUTHY = {"1", "true", "yes", "on"}
# Variables Railway injects into every deployed container (absent on a developer machine and in CI).
RAILWAY_MARKERS = ("RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID")


@dataclass(frozen=True)
class Settings:
    env: str
    dev_auth_requested: bool
    dev_auth_token: str | None
    assistant_provider: str
    # Secrets: excluded from repr so they can never reach a log line through a dataclass dump.
    database_url: str | None = field(default=None, repr=False)
    service_auth_secret: str | None = field(default=None, repr=False)
    service_auth_secret_previous: str | None = field(default=None, repr=False)
    service_nonce_store: str = "postgres"  # "memory" is honoured outside production only

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
    # Hosted runtimes can never run in the open development mode, even if APP_ENV=development is set there by mistake:
    # Vercel production, and ANY Railway environment (production or a PR/preview one) are forced to production.
    hosted = os.environ.get("VERCEL_ENV", "").lower() == "production" or any(os.environ.get(m) for m in RAILWAY_MARKERS)
    if env not in {"development", "test"} or hosted:
        env = "production"
    return Settings(
        env=env,
        dev_auth_requested=os.environ.get("ENABLE_DEV_AUTH", "").strip().lower() in _TRUTHY,
        dev_auth_token=os.environ.get("DEV_AUTH_TOKEN") or None,
        assistant_provider=os.environ.get("ASSISTANT_PROVIDER", "none").strip().lower() or "none",
        # Deliberately NOT `DATABASE_URL`: managed-Postgres integrations inject that with the OWNER role, which bypasses RLS.
        database_url=os.environ.get("APP_DATABASE_URL") or None,
        service_auth_secret=os.environ.get("SERVICE_AUTH_SECRET") or None,
        service_auth_secret_previous=os.environ.get("SERVICE_AUTH_SECRET_PREVIOUS") or None,
        service_nonce_store="memory" if os.environ.get("SERVICE_NONCE_STORE", "").strip().lower() == "memory" else "postgres",
    )
