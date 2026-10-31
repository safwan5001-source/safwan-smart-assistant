import pytest
from fastapi.testclient import TestClient

from app.audit import audit_log
from app.main import app


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    """Tests run as a non-production environment with no experimental auth unless a test opts in."""
    monkeypatch.setenv("APP_ENV", "test")
    for var in ("ENABLE_DEV_AUTH", "DEV_AUTH_TOKEN", "ASSISTANT_PROVIDER", "VERCEL_ENV"):
        monkeypatch.delenv(var, raising=False)
    audit_log.clear()


@pytest.fixture
def client():
    return TestClient(app)
