"""Pins the hosting topology so a future edit cannot silently expose the API (fail-closed by construction).

Primary host: Railway. The API (`safwan-api`) has NO public domain; the web tier reaches it over the private network with a
signed request (see docs/deploy/RAILWAY-PHASE3-DB-AUTH.md). `vercel.json` is the legacy fallback that is deliberately left
exactly as it is on `main` during the migration, so it is pinned here as well: whatever it routes publicly must stay harmless.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CFG = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
PUBLIC_BACKEND_PATHS = {"/backend/health", "/backend/health/neon"}  # liveness only; nothing under /internal or a user route


def test_legacy_vercel_never_routes_the_signed_internal_api_publicly():
    assert "/internal" not in json.dumps(CFG)
    for rule in CFG["rewrites"]:
        if rule["destination"] == {"service": "web"}:
            continue
        assert rule["source"] in PUBLIC_BACKEND_PATHS, f"unexpected public route to the backend: {rule}"


def test_legacy_vercel_has_the_expected_services():
    assert set(CFG["services"]) == {"web", "backend"}
    assert CFG["services"]["web"]["root"] == "apps/web"
    assert CFG["services"]["backend"]["root"] == "services/api"
    assert CFG["services"]["backend"]["entrypoint"] == "app.main:app"


def test_the_web_app_has_no_public_proxy_to_the_api():
    """Railway design: no `rewrites()` in next.config.ts that could forward browser traffic to the API."""
    text = (ROOT / "apps" / "web" / "next.config.ts").read_text(encoding="utf-8")
    assert "rewrites" not in text and "API_PROXY_URL" not in text
