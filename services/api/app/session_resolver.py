"""Pure verification of persisted session records; not an HTTP login service."""
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID

from .session_secrets import verify_session_secret

@dataclass(frozen=True)
class PersistedSession:
    account_id: UUID
    token_hash: bytes
    expires_at: datetime
    revoked_at: datetime | None = None

def resolve_session(secret: str | None, session: PersistedSession | None,
                    now: datetime | None = None) -> UUID | None:
    """Only return owner when hash matches and server-side session is still valid."""
    if not secret or session is None:
        return None
    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError("Timezone-aware clock required")
    if session.account_id.int == 0 or session.revoked_at is not None:
        return None
    if session.expires_at.tzinfo is None or session.expires_at <= instant:
        return None
    if not verify_session_secret(secret, session.token_hash):
        return None
    return session.account_id
