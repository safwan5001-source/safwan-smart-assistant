from datetime import datetime, timezone
from uuid import uuid4
import pytest
from pydantic import ValidationError
from app.sync_contracts import ImportPreviewRequest, LocalRecord

def row(**changes):
    data = dict(local_id=uuid4(),kind="task",action="upsert",revision=0,
                updated_at=datetime.now(timezone.utc),payload={"title":"Test"})
    data.update(changes)
    return data

def test_safe_preview_only():
    assert ImportPreviewRequest(records=[row()]).dry_run is True
    with pytest.raises(ValidationError):
        ImportPreviewRequest(records=[row()],dry_run=False)

def test_no_user_identity_from_client():
    with pytest.raises(ValidationError):
        LocalRecord(**row(user_id="someone-else"))

def test_timezone_and_revision_required():
    with pytest.raises(ValidationError):
        LocalRecord(**row(updated_at=datetime(2026, 1, 1)))
    with pytest.raises(ValidationError):
        LocalRecord(**row(revision=-1))

def test_tombstone_is_payload_free():
    with pytest.raises(ValidationError):
        LocalRecord(**row(action="delete"))
    assert LocalRecord(**row(action="delete", payload=None)).payload is None

def test_duplicate_import_records_rejected():
    r=row()
    with pytest.raises(ValidationError):
        ImportPreviewRequest(records=[r,r])
