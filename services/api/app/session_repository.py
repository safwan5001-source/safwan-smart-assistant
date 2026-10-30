"""PostgreSQL session lookups and revocation primitives.

Internal-only repository; connection must be managed by the caller. Never pass user
identity from request input. No HTTP authentication endpoint is enabled here.
"""
from uuid import UUID
from datetime import datetime, timezone
from .session_secrets import digest_session_secret
from .session_resolver import PersistedSession, resolve_session

def lookup_authenticated_account(connection, secret: str | None, now: datetime | None = None) -> UUID | None:
    if not secret:
        return None
    try:
        token_hash = digest_session_secret(secret)
    except (ValueError, TypeError):
        return None
    instant = now or datetime.now(timezone.utc)
    # Parameterized query; never log the secret or its hash.
    row = connection.execute(
        """SELECT account_id, token_hash, expires_at, revoked_at
           FROM sessions WHERE token_hash = %s LIMIT 1""",
        (token_hash,),
    ).fetchone()
    if row is None:
        return None
    record = PersistedSession(
        account_id=row[0], token_hash=bytes(row[1]),
        expires_at=row[2], revoked_at=row[3],
    )
    return resolve_session(secret, record, instant)

def revoke_session(connection, secret: str) -> bool:
    """Caller must wrap this write in a transaction and commit on success."""
    try:
        token_hash = digest_session_secret(secret)
    except (ValueError, TypeError):
        return False
    result = connection.execute(
        """UPDATE sessions SET revoked_at = now()
           WHERE token_hash = %s AND revoked_at IS NULL""",
        (token_hash,),
    )
    return result.rowcount == 1
