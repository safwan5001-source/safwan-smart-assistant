"""Pins the deployment topology so a future edit cannot silently expose the API (fail-closed by construction)."""
import json
from pathlib import Path

CFG = json.loads((Path(__file__).resolve().parents[3] / "vercel.json").read_text(encoding="utf-8"))


def test_exactly_two_services_with_expected_roots():
    assert set(CFG["services"]) == {"web", "backend"}
    assert CFG["services"]["web"]["root"] == "apps/web"
    assert CFG["services"]["backend"]["root"] == "services/api"
    assert CFG["services"]["backend"]["entrypoint"] == "app.main:app"


def test_backend_is_never_publicly_routed():
    rewrites = CFG["rewrites"]
    assert rewrites, "a catch-all to web is required"
    for rule in rewrites:
        assert rule["destination"] == {"service": "web"}, f"public rule routes somewhere other than web: {rule}"
    assert "rewrites" not in CFG["services"]["backend"], "the backend must not define its own public routing"


def test_web_reaches_backend_only_through_a_service_binding():
    bindings = CFG["services"]["web"]["bindings"]
    assert bindings == [{"type": "service", "service": "backend", "format": "url", "env": "BACKEND_URL"}]


def test_no_public_legacy_backend_paths_remain():
    text = json.dumps(CFG)
    assert "/backend" not in text and "neon" not in text.lower()
