"""Internal PostgreSQL email verification token repository.

The caller must commit the transaction before sending email. Consume uses a
single conditional UPDATE so a token cannot be redeemed twice.
"""
from datetime import datetime, timezone
from uuid import UUID, uuid4
from .email_verification import issue_email_verification
import hashlib

def store_email_verification(connection, account_id: UUID) -> str:
    if not isinstance(account_id, UUID) or account_id.int == 0:
        raise ValueError("Verified account ID required")
    token, record = issue_email_verification()
    connection.execute(
        """INSERT INTO email_verification_tokens
           (id, account_id, token_hash, expires_at)
           VALUES (%s, %s, %s, %s)""",
        (uuid4(), account_id, record.token_hash, record.expires_at),
    )
    return token

def consume_email_verification(connection, account_id: UUID, token: str) -> bool:
    """Must run inside a transaction; caller marks account verified in same transaction."""
    if not isinstance(account_id, UUID) or account_id.int == 0:
        return False
    if not isinstance(token, str) or len(token) < 32:
        return False
    token_hash = hashlib.sha256(token.encode("utf-8")).digest()
    result = connection.execute(
        """UPDATE email_verification_tokens
           SET consumed_at = now()
           WHERE account_id = %s AND token_hash = %s
             AND consumed_at IS NULL AND expires_at > now()""",
        (account_id, token_hash),
    )
    return result.rowcount == 1
