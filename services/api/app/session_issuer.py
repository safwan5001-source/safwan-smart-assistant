"""Internal transactional session creation, not yet exposed by HTTP."""
from uuid import UUID, uuid4
from .session_secrets import issue_session_secret, digest_session_secret, expires_at

def create_session(connection, verified_owner: UUID, ttl_seconds: int = 86400) -> str:
    """Caller authenticates owner and commits transaction before returning token."""
    if not isinstance(verified_owner, UUID) or verified_owner.int == 0:
        raise ValueError("Verified owner required")
    token = issue_session_secret()
    expiry = expires_at(ttl_seconds)
    connection.execute(
        "INSERT INTO sessions (id, account_id, token_hash, expires_at) VALUES (%s, %s, %s, %s)",
        (uuid4(), verified_owner, digest_session_secret(token), expiry),
    )
    return token
