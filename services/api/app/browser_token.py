"""Bearer-token check for the private /internal/browser/* routes (BROWSER_SERVICE_TOKEN).

This is deliberately a separate mechanism from the BFF's signed requests (SERVICE_AUTH_SECRET); neither opens the other.
Extracted from main.py unchanged in behaviour (>= 32 chars, `Bearer ` scheme, constant-time compare) with two fixes found by the
independent security review:
  * IR-A2  a non-ASCII byte in the header made `hmac.compare_digest` raise TypeError -> HTTP 500. It is now a plain 401.
  * IR-A3  if the browser token ever equals the BFF secret (current or previous) the two mechanisms would become interchangeable,
           and the browser worker (which renders untrusted web content and holds this token) could forge BFF calls. That
           configuration is now refused on BOTH sides.
"""
from __future__ import annotations

import hmac
import os

MIN_TOKEN_CHARS = 32
_SECRET_ENV_NAMES = ("SERVICE_AUTH_SECRET", "SERVICE_AUTH_SECRET_PREVIOUS")


def _expected() -> str:
    return os.environ.get("BROWSER_SERVICE_TOKEN", "")


def collides_with_service_secret(token: str | None = None) -> bool:
    """True when the browser token is identical to a configured BFF signing secret."""
    token = _expected() if token is None else token
    if not token:
        return False
    candidate = token.encode("utf-8")
    return any(
        (value := os.environ.get(name, "")) and hmac.compare_digest(value.encode("utf-8"), candidate)
        for name in _SECRET_ENV_NAMES
    )


def authorized(authorization: str | None) -> bool:
    expected = _expected()
    if len(expected) < MIN_TOKEN_CHARS or not authorization or not authorization.startswith("Bearer "):
        return False
    if collides_with_service_secret(expected):
        return False
    return hmac.compare_digest(authorization[7:].encode("utf-8"), expected.encode("utf-8"))
