from datetime import datetime, timedelta, timezone
from uuid import uuid4
import pytest
from app.session_resolver import PersistedSession, resolve_session
from app.session_secrets import issue_session_secret, digest_session_secret

NOW = datetime(2026, 10, 30, tzinfo=timezone.utc)

def fixture():
    token = issue_session_secret()
    session = PersistedSession(uuid4(), digest_session_secret(token), NOW+timedelta(hours=1))
    return token, session

def test_valid_session_resolves_owner():
    secret, record = fixture()
    assert resolve_session(secret, record, NOW)==record.account_id

def test_wrong_secret_is_denied():
    secret, record = fixture()
    assert resolve_session(issue_session_secret(), record, NOW) is None
    assert resolve_session(None, record, NOW) is None

def test_expired_and_revoked_sessions_are_denied():
    secret, record = fixture()
    assert resolve_session(secret,record,NOW+timedelta(hours=1)) is None
    revoked = PersistedSession(record.account_id,record.token_hash,record.expires_at,NOW)
    assert resolve_session(secret,revoked,NOW) is None

def test_absent_session_and_invalid_clock():
    token, record = fixture()
    assert resolve_session(token,None,NOW) is None
    with pytest.raises(ValueError):
        resolve_session(token,record,datetime(2026,10,30))
