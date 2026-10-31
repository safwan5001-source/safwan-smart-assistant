"""Authentication dependency.

Production: there is no real authentication yet, so every protected route fails
closed (503). The experimental dev-token auth can only ever be active outside
production. Only /health is public.
"""
from __future__ import annotations

import hmac

from fastapi import Depends, HTTPException, Request

from .config import Settings, get_settings


def require_auth(request: Request, settings: Settings = Depends(get_settings)) -> str:
    if settings.is_production:
        raise HTTPException(
            status_code=503,
            detail={"code": "auth_not_configured", "message": "Authentication is not configured; protected endpoints are disabled."},
        )
    if not settings.dev_auth_enabled:
        return "dev-open"
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.encode(), (settings.dev_auth_token or "").encode()):
        raise HTTPException(status_code=401, detail={"code": "unauthorized", "message": "Missing or invalid token."},
                            headers={"WWW-Authenticate": "Bearer"})
    return "dev-user"
