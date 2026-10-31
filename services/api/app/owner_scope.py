"""Transaction-bound account context for future database operations.

No public routes are enabled. Never accept account IDs from unverified request bodies.
"""
from contextlib import contextmanager
from collections.abc import Iterator
from uuid import UUID

def verified_account_id(value: str) -> UUID:
    """Called only after verifying a server-side session against persisted token hashes."""
    account_id = UUID(value)
    if account_id.int == 0:
        raise ValueError("Empty account ID")
    return account_id

@contextmanager
def owner_transaction(connection, account_id: UUID) -> Iterator[object]:
    """Run statements with a transaction-local PostgreSQL RLS scope.

    The caller must pass a real DB connection and authenticated account ID.
    It must not reuse a transaction with untrusted SQL or user-selected ownership.
    """
    if not isinstance(account_id, UUID) or account_id.int == 0:
        raise ValueError("Verified account ID required")
    with connection.transaction():
        # PostgreSQL set_config(..., true) is LOCAL to the transaction.
        connection.execute(
            "SELECT set_config('app.account_id', %s, true)",
            (str(account_id),)
        )
        yield connection
