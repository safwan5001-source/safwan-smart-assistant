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
from psycopg.pq import TransactionStatus


def verified_account_id(value: str | UUID) -> UUID:
    """Call only with an id that came from a verified server-side session, never from request data."""
    account_id = value if isinstance(value, UUID) else UUID(str(value))
    if account_id.int == 0:
        raise ValueError("verified account id required")
    return account_id


@contextmanager
def owner_transaction(conn: psycopg.Connection, account_id: UUID, *, statement_timeout_ms: int = 5000) -> Iterator[psycopg.Connection]:
    """Run the block scoped to `account_id`.

    Nesting is allowed and SAFE: a nested block runs inside a savepoint, and PostgreSQL keeps `set_config(..., true)` values after a
    savepoint is released, so without the restore below the inner account would silently stay active for the rest of the outer
    block (cross-account leakage). The previous scope and statement timeout are therefore put back when the inner block exits
    normally; when it raises, the savepoint rollback already reverts them.
    """
    if not isinstance(account_id, UUID) or account_id.int == 0:
        raise ValueError("verified account id required")
    if not 100 <= statement_timeout_ms <= 60000:
        raise ValueError("statement timeout out of bounds")
    nested = conn.info.transaction_status != TransactionStatus.IDLE
    previous: tuple[str, str] | None = None
    with conn.transaction():
        if nested:
            row = conn.execute("SELECT current_setting('app.account_id', true), current_setting('statement_timeout')").fetchone()
            assert row is not None
            previous = (row[0] or "", row[1])
        conn.execute("SELECT set_config('app.account_id', %s, true)", (str(account_id),))
        conn.execute("SELECT set_config('statement_timeout', %s, true)", (f"{statement_timeout_ms}ms",))
        yield conn
    if previous is not None:
        conn.execute("SELECT set_config('app.account_id', %s, true), set_config('statement_timeout', %s, true)", previous)
