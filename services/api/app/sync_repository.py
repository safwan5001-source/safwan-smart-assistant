"""Internal account-scoped optimistic concurrency; no public endpoint."""
from uuid import UUID
from .owner_scope import owner_transaction

ALLOWED_KINDS=frozenset({"conversation","message","task","attachment"})

def update_record(connection, owner: UUID, kind: str, record_id: UUID,
                  revision: int, body: str) -> bool:
    if kind not in ALLOWED_KINDS or not isinstance(record_id,UUID):
        raise ValueError("Invalid sync record")
    if not isinstance(revision,int) or isinstance(revision,bool) or revision < 1:
        raise ValueError("Expected server revision required")
    with owner_transaction(connection,owner):
        row=connection.execute(
            """UPDATE sync_records SET revision=revision+1, body=%s::jsonb, updated_at=now()
               WHERE account_id=%s AND kind=%s AND id=%s
               AND revision=%s AND deleted_at IS NULL RETURNING revision""",
            (body,str(owner),kind,record_id,revision),
        ).fetchone()
        return row is not None

def tombstone_record(connection, owner: UUID, kind: str,
                     record_id: UUID, revision: int) -> bool:
    if kind not in ALLOWED_KIN or not isinstance(record_id,UUID):
        raise ValueError("Invalid sync record")
    if not isinstance(revision,int) or isinstance(revision,bool) or revision < 1:
        raise ValueError("Expected server revision required")
    with owner_transaction(connection,owner):
        row=connection.execute(
            """UPDATE sync_records SET revision=revision+1, deleted_at=now(), updated_at=now()
               WHERE account_id=%s AND kind=%s AND id=%s
               AND revision=%s AND deleted_at IS NULL RETURNING revision""",
            (str(owner),kind,record_id,revision),
        ).fetchone()
        return row is not None
