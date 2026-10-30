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
    assert ingress[0] == {
        "source": "/backend/health",
        "destination": {"service": "backend"},
    }
    assert backend["root"] == "services/api"
    assert backend["entrypoint"] == "app.main:app"
    assert {
        "source": "/backend/:path(.*)?",
        "destination": "/:path",
    } in backend["rewrites"]
    assert all(route["destination"] != {"service": "backend"} for route in ingress[1:])
