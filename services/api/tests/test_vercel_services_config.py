"""Check Vercel Services configuration guards public API exposure."""
from pathlib import Path
import json

def test_backend_only_exposes_health_and_web_keeps_routes():
    root=Path(__file__).resolve().parents[3]
    cfg=json.loads((root/"vercel.json").read_text())
    assert cfg["services"]["web"]["root"]=="apps/web"
    assert cfg["services"]["backend"]["root"]=="services/api"
    assert cfg["services"]["backend"]["entrypoint"]=="app.main:app"
    routes=cfg["rewrites"]
    assert routes[0]["source"]=="/backend/health"
    assert routes[0]["destination"]=={"service":"backend"}
    assert routes[-1]["destination"]=={"service":"web"}
    assert all("/tasks" not in str(route) for route in routes)
