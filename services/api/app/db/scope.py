"""Transaction-bound account scope for row-level security.

Ported from the Phase 5 `owner_scope` primitive after review, with these changes:
the nil UUID is rejected here *and* in SQL, a statement timeout bounds every scoped transaction,
and the scope is applied with `set_config(..., true)` so it can never outlive the transaction
(which also makes it safe behind transaction-pooling proxies).
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

import psycopg


def verified_account_id(value: str | UUID) -> UUID:
    """Call only with an id that came from a verified server-side session, never from request data."""
    account_id = value if isinstance(value, UUID) else UUID(str(value))
    if account_id.int == 0:
        raise ValueError("verified account id required")
    return account_id


@contextmanager
def owner_transaction(conn: psycopg.Connection, account_id: UUID, *, statement_timeout_ms: int = 5000) -> Iterator[psycopg.Connection]:
    if not isinstance(account_id, UUID) or account_id.int == 0:
        raise ValueError("verified account id required")
    if not 100 <= statement_timeout_ms <= 60000:
        raise ValueError("statement timeout out of bounds")
    with conn.transaction():
        conn.execute("SELECT set_config('app.account_id', %s, true)", (str(account_id),))
        conn.execute("SELECT set_config('statement_timeout', %s, true)", (f"{statement_timeout_ms}ms",))
        yield conn
