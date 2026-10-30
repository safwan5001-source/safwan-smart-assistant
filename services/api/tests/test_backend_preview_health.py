"""Offline verification for the Vercel Services health route.

A green result does not prove Vercel deployed the Python service.
"""
import json
from pathlib import Path
from fastapi.testclient import TestClient
from app.main import app


def test_fastapi_health_responds_from_python_application():
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "orchestrator-foundation",
    }


def test_services_rewrite_maps_public_health_to_backend_health_only():
    root = Path(__file__).resolve().parents[3]
    config = json.loads((root / "vercel.json").read_text())
    ingress = config["rewrites"]
    backend = config["services"]["backend"]
    assert {
        "source": "/backend/health",
        "destination": {"service": "backend"},
    } in ingress
    assert {
        "source": "/backend/health/neon",
        "destination": {"service": "backend"},
    } in ingress
    assert backend["root"] == "services/api"
    assert backend["entrypoint"] == "app.main:app"
    assert {
        "source": "/backend/:path(.*)?",
        "destination": "/:path",
    } in backend["rewrites"]
    assert {route["source"] for route in ingress if route["destination"] == {"service": "backend"}} == {"/backend/health", "/backend/health/neon"}


def test_neon_probe_not_exposed_outside_preview(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "production")
    response = TestClient(app).get("/health/neon")
    assert response.status_code == 404


def test_neon_probe_fails_closed_without_preview_credentials(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    response = TestClient(app).get("/health/neon")
    assert response.status_code == 503
    assert "postgres" not in response.text.lower()
