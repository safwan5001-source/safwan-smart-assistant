"""Internal transaction-safe registration and confirmation service.

DB must support .transaction() as psycopg does. Mail dispatch happens after
commit; a durable outbox is required before production rollout.
"""
from uuid import UUID
from .registration_contracts import RegistrationRequest
from .account_registration import register_pending_account
from .account_confirmation import confirm_account_email

def register_in_transaction(connection, request: RegistrationRequest) -> tuple[str,str]:
    with connection.transaction():
        return register_pending_account(connection,request)

def confirm_in_transaction(connection, account_id: UUID, token: str) -> bool:
    with connection.transaction():
        return confirm_account_email(connection, account_id, token)
