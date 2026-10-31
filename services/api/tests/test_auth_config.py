import pytest
from app.auth_config import AuthConfiguration, cookie_policy

def test_secure_session_policy():
    config = AuthConfiguration(public_origin="https://assistant.example.com")
    assert cookie_policy(config)["httponly"] is True
    assert cookie_policy(config)["secure"] is True

@pytest.mark.parametrize("origin", [
    "http://assistant.example.com", "https://user:pass@assistant.example.com",
    "https://assistant.example.com/path", "javascript:bad", "https://assistant.example.com/?x=1"
])
def test_reject_invalid_production_origin(origin):
    with pytest.raises(ValueError):
        AuthConfiguration(public_origin=origin).validate()

def test_reject_insecure_cookies():
    with pytest.raises(ValueError):
        AuthConfiguration(public_origin="https://assistant.example.com", secure_cookies=False).validate()

def test_reject_excessive_session_duration():
    with pytest.raises(ValueError):
        AuthConfiguration(public_origin="https://assistant.example.com", session_ttl_seconds=999999).validate()
