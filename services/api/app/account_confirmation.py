"""Atomic email confirmation; caller owns transaction and commit.

This is internal only. A token is consumed and the account verified within the
same database transaction. If either statement fails, caller must roll back.
"""
from uuid import UUID
from .email_verification_repository import consume_email_verification

def confirm_account_email(connection, account_id: UUID, token: str) -> bool:
    if not isinstance(account_id, UUID) or account_id.int == 0:
        return False
    if not consume_email_verification(connection, account_id, token):
        return False
    result = connection.execute(
        """UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, now())
           WHERE id = %s AND deleted_at IS NULL""",
        (account_id,),
    )
    if result.rowcount != 1:
        # Critical: caller must abort/rollback this transaction on False.
        # Raise to guarantee that the consumed token cannot commit alone.
        raise RuntimeError("Account verification failed; roll back transaction")
    return True
