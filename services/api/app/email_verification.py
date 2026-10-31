"""Single-use, expiring email-verification tokens. Internal primitive only."""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import secrets

@dataclass(frozen=True)
class EmailVerificationRecord:
    token_hash: bytes
    expires_at: datetime
    consumed_at: datetime | None = None

def issue_email_verification(now: datetime | None = None) -> tuple[str, EmailVerificationRecord]:
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or clock.utcoffset() is None:
        raise ValueError("Timezone-aware clock required")
    token = secrets.token_urlsafe(32)
    return token, EmailVerificationRecord(
        token_hash=hashlib.sha256(token.encode()).digest(),
        expires_at=clock+timedelta(minutes=30),
    )

def verify_email_token(token: str, record: EmailVerificationRecord,
                       now: datetime | None = None) -> bool:
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or clock.utcoffset() is None:
        raise ValueError("Timezone-aware clock required")
    if record.consumed_at is not None or record.expires_at <= clock:
        return False
    if not isinstance(token,str) or len(token)<32:
        return False
    return hmac.compare_digest(hashlib.sha256(token.encode()).digest(),record.token_hash)

# IMPORTANT: actual consumption must be a conditional atomic database UPDATE
# checking expires_at and consumed_at IS NULL; this pure function does not consume.
