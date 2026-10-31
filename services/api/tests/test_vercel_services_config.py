"""Check Vercel Services configuration guards public API exposure."""
from pathlib import Path
import json


def test_backend_only_exposes_health_and_web_keeps_routes():
    root = Path(__file__).resolve().parents[3]
    cfg = json.loads((root / "vercel.json").read_text())
    assert cfg["services"]["web"]["root"] == "apps/web"
    assert cfg["services"]["backend"]["root"] == "services/api"
    assert cfg["services"]["backend"]["entrypoint"] == "app.main:app"

    routes = cfg["rewrites"]
    expected_backend_paths = {"/backend/health", "/backend/health/neon"}
    backend_routes = [route for route in routes if route.get("destination") == {"service": "backend"}]

    assert {route["source"] for route in backend_routes} == expected_backend_paths
    assert len(backend_routes) == len(expected_backend_paths)
    assert all(routes.index(route) < len(routes) - 1 for route in backend_routes)
    assert routes[-1] == {"source": "/(.*)", "destination": {"service": "web"}}
    assert all("/tasks" not in str(route) for route in routes)
