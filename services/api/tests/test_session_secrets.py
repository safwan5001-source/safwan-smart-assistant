from datetime import datetime, timezone
import pytest
from app.session_secrets import (
    issue_session_secret, digest_session_secret, verify_session_secret, expires_at
)

def test_secret_generation_and_verification():
    a, b = issue_session_secret(), issue_session_secret()
    assert a != b
    assert len(a) >= 32
    assert verify_session_secret(a, digest_session_secret(a))
    assert not verify_session_secret(b, digest_session_secret(a))

def test_reject_short_or_missing_secret():
    with pytest.raises(ValueError):
        digest_session_secret("short")
    assert not verify_session_secret("short", b"\x00" * 32)

def test_expiry_is_aware_and_bounded():
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert (expires_at(3600, now) - now).total_seconds() == 3600
    with pytest.raises(ValueError):
        expires_at(999999999)
    with pytest.raises(ValueError):
        expires_at(3600, datetime(2026, 1, 1))
