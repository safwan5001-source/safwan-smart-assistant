"""HTTP security boundary tests until account endpoints are implemented.

These are fail-closed regression gates, not a claim of implemented authentication.
"""
from fastapi.testclient import TestClient
from app.main import app
from app.auth_config import AuthConfiguration, cookie_policy

client = TestClient(app)

def test_account_http_routes_remain_unavailable():
    for method, path in (
        ("POST", "/auth/login"),
        ("POST", "/auth/register"),
        ("POST", "/auth/logout"),
        ("POST", "/auth/refresh"),
        ("POST", "/auth/recover"),
        ("GET", "/auth/me"),
        ("GET", "/sync/records"),
        ("POST", "/sync/records"),
    ):
        response = client.request(method, path, json={})
        assert response.status_code == 404, (method, path, response.status_code)

def test_untrusted_cookie_does_not_enable_account_routes():
    client_with_cookie = TestClient(app, cookies={"safwan_session": "forged"})
    response = client_with_cookie.get("/auth/me")
    assert response.status_code == 404

def test_cookie_security_contract():
    policy = cookie_policy(AuthConfiguration(public_origin="https://assistant.example.test"))
    assert policy["httponly"] is True
    assert policy["secure"] is True
    assert policy["samesite"] in ("lax", "strict")
    assert policy["path"] == "/"
    assert 300 <= policy["max_age"] <= 604800

def test_unsafe_auth_config_cannot_be_used_in_production():
    for origin in ("http://assistant.example.test", "https://user:pass@assistant.example.test",
                   "https://assistant.example.test/unsafe", "https://assistant.example.test?next=1"):
        try:
            AuthConfiguration(public_origin=origin).validate(production=True)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Unsafe production origin accepted: {origin}")

def test_no_real_account_operations_are_advertised_in_openapi():
    paths = client.get("/openapi.json").json()["paths"]
    assert not any(p.startswith(("/auth", "/sync", "/accounts")) for p in paths)
