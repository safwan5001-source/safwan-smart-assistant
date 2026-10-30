"""Internal transactional account registration; no public endpoints or email sending.

The caller must commit the account and token transaction before enqueueing an
email. Do not return whether an existing address is registered to public callers.
"""
from uuid import uuid4
from .registration_contracts import RegistrationRequest, normalize_email
from .email_verification_repository import store_email_verification

def register_pending_account(connection, request: RegistrationRequest) -> tuple[str, str]:
    """Returns server-generated account ID and verification secret for an internal mail job.

    Caller must handle unique-email conflicts without revealing account existence
    and must not send a message until the transaction commits.
    """
    account_id = uuid4()
    normalized = normalize_email(str(request.email))
    connection.execute(
        """INSERT INTO accounts (id, email_normalized, display_name)
           VALUES (%s, %s, %s)""",
        (account_id, normalized, request.display_name),
    )
    secret = store_email_verification(connection, account_id)
    return str(account_id), secret
