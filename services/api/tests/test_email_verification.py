from dataclasses import replace
from datetime import datetime,timedelta,timezone
from app.email_verification import issue_email_verification,verify_email_token

NOW=datetime(2026,10,30,tzinfo=timezone.utc)
def test_valid_and_wrong_tokens():
    token,rec=issue_email_verification(NOW)
    assert verify_email_token(token,rec,NOW)
    assert not verify_email_token(token+"x",rec,NOW)
def test_expired_and_used_tokens():
    token,rec=issue_email_verification(NOW)
    assert not verify_email_token(token,rec,NOW+timedelta(minutes=30))
    assert not verify_email_token(token,replace(rec,consumed_at=NOW),NOW)
def test_tokens_not_reused():
    a,ar=issue_email_verification(NOW)
    b,br=issue_email_verification(NOW)
    assert a!=b and ar.token_hash!=br.token_hash
