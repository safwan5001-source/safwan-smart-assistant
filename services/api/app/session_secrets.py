"""Session credential helpers only; do not expose authentication endpoints yet."""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

SESSION_TOKEN_BYTES = 32

def issue_session_secret() -> str:
    return secrets.token_urlsafe(SESSION_TOKEN_BYTES)

def digest_session_secret(secret: str) -> bytes:
    if not isinstance(secret, str) or len(secret) < 32:
        raise ValueError("Invalid session secret")
    return hashlib.sha256(secret.encode("utf-8")).digest()

def verify_session_secret(secret: str, expected_digest: bytes) -> bool:
    try:
        actual = digest_session_secret(secret)
    except (ValueError, TypeError):
        return False
    return isinstance(expected_digest, bytes) and hmac.compare_digest(actual, expected_digest)

def expires_at(ttl_seconds: int, now: datetime | None = None) -> datetime:
    if not 300 <= ttl_seconds <= 604800:
        raise ValueError("Session TTL out of bounds")
    base = now or datetime.now(timezone.utc)
    if base.tzinfo is None or base.utcoffset() is None:
        raise ValueError("Timezone-aware clock required")
    return base + timedelta(seconds=ttl_seconds)
