import pytest

from app.config import get_settings

PROTECTED = [("get", "/capabilities"), ("get", "/tools"), ("get", "/integrations"), ("get", "/audit"),
             ("get", "/permissions/policy")]


@pytest.mark.parametrize("env", [None, "production", "prod", "staging", "anything"])
def test_unknown_or_production_env_fails_closed(client, monkeypatch, env):
    monkeypatch.delenv("APP_ENV", raising=False)
    if env:
        monkeypatch.setenv("APP_ENV", env)
    for method, path in PROTECTED:
        assert getattr(client, method)(path).status_code == 503, path
    assert client.post("/tasks", json={"instruction": "x", "permission_mode": "review"}).status_code == 503
    assert client.post("/tools/execute", json={"tool": "system.time", "permission_mode": "review"}).status_code == 503
    assert client.get("/health").status_code == 200  # only health stays public


def test_vercel_production_overrides_development(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("VERCEL_ENV", "production")
    assert client.get("/tools").status_code == 503


@pytest.mark.parametrize("marker", ["RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID"])
def test_any_railway_runtime_overrides_development(client, monkeypatch, marker):
    """APP_ENV=development set by mistake on Railway (production OR a PR/preview environment) must not open the API."""
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv(marker, "anything")
    assert client.get("/tools").status_code == 503
    assert client.get("/capabilities").status_code == 503
    assert get_settings().is_production and get_settings().auth_mode == "locked"


def test_dev_mode_still_works_off_railway(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    assert client.get("/tools").status_code == 200


def test_dev_auth_cannot_be_enabled_in_production(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ENABLE_DEV_AUTH", "true")
    monkeypatch.setenv("DEV_AUTH_TOKEN", "secret")
    r = client.get("/tools", headers={"Authorization": "Bearer secret"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "auth_not_configured"


def test_dev_auth_enforced_outside_production(client, monkeypatch):
    monkeypatch.setenv("ENABLE_DEV_AUTH", "1")
    monkeypatch.setenv("DEV_AUTH_TOKEN", "s3cret")
    assert client.get("/tools").status_code == 401
    assert client.get("/tools", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/tools", headers={"Authorization": "Basic s3cret"}).status_code == 401
    assert client.get("/tools", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    assert client.get("/capabilities", headers={"Authorization": "Bearer s3cret"}).json()["auth_mode"] == "dev_token"


def test_dev_auth_flag_without_token_stays_open_not_silently_secure(client, monkeypatch):
    monkeypatch.setenv("ENABLE_DEV_AUTH", "1")
    assert client.get("/capabilities").json()["auth_mode"] == "open_dev"


def test_secrets_never_exposed(client, monkeypatch):
    monkeypatch.setenv("ENABLE_DEV_AUTH", "1")
    monkeypatch.setenv("DEV_AUTH_TOKEN", "topsecretvalue")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_leak")
    h = {"Authorization": "Bearer topsecretvalue"}
    blob = "".join(client.get(p, headers=h).text for _, p in PROTECTED)
    assert "topsecretvalue" not in blob and "ghp_leak" not in blob
