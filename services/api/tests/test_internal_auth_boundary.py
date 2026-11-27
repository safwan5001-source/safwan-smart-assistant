"""The two authentication mechanisms under /internal/*, and the guarantee that neither becomes a blanket exemption.

Decision (architecture, 2026-11): the API has exactly two private surfaces and each keeps its OWN mechanism.
  * /internal/v1/*       BFF -> API, HMAC service signature (SERVICE_AUTH_SECRET) + freshness + single-use nonce.
  * /internal/browser/*  owner diagnostics / read bridge, `Authorization: Bearer <BROWSER_SERVICE_TOKEN>` (>= 32 chars).
Unifying them is a separate task. Until then these tests make sure that
  1. every route under /internal is on exactly one of the two lists below (a new route without a guard fails CI),
  2. a credential for one mechanism never opens the other,
  3. the browser routes keep their current contract (statuses, bodies, allow-listed URL, bounded worker call),
  4. no path trick turns an unauthenticated request into a 200.
"""
import io
import json
import time
from urllib.error import URLError

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import app.service_auth as sa
from app import main
from app.main import app
from app.service_auth import MemoryNonceStore, require_service_call, sign

SECRET = "unit-test-secret-0123456789abcdef-0123456789abcdef"
BROWSER_TOKEN = "t" * 40
WORKER = "http://safwan-browser.railway.internal:8080"

# The ONLY approved surfaces. Adding a route under /internal requires adding it here deliberately, with its guard.
SIGNED_ROUTES = {
    ("GET", "/internal/v1/ping"),
    # chat -> browser worker bridge (tests/test_browser_tasks.py): signed like /ping, plus its own opt-in flag
    ("POST", "/internal/v1/browser/tasks"),
    ("GET", "/internal/v1/browser/tasks/{task_id}"),
    ("POST", "/internal/v1/browser/tasks/{task_id}/cancel"),
    ("GET", "/internal/v1/browser/tasks/{task_id}/screenshot"),
    # CHAT-BROWSER-2 interactive control (tests/test_browser_interactive.py): same signature, plus the lab-scope opt-in
    ("POST", "/internal/v1/browser/tasks/{task_id}/actions"),
    ("POST", "/internal/v1/browser/tasks/{task_id}/actions/{seq}/approve"),
    ("POST", "/internal/v1/browser/tasks/{task_id}/actions/{seq}/reject"),
    ("POST", "/internal/v1/browser/tasks/{task_id}/finish"),
    # CHAT-AI-1 Claude chat (tests/test_assistant_chat.py): same signature + acting-account allow-list + durable budget
    ("GET", "/internal/v1/assistant/state"),
    ("POST", "/internal/v1/assistant/settings"),
    ("POST", "/internal/v1/assistant/probe"),
    ("GET", "/internal/v1/assistant/conversations"),
    ("GET", "/internal/v1/assistant/conversations/{conversation_id}"),
    ("POST", "/internal/v1/assistant/conversations/{conversation_id}/delete"),
    ("POST", "/internal/v1/assistant/chat"),
    # BASHT Core C2/C4 (tests/test_basht_chat.py): same signature; the engine bridge holds the gateway token, the API its app token
    ("GET", "/internal/v1/basht/sessions"),
    ("POST", "/internal/v1/basht/history"),
    ("POST", "/internal/v1/basht/send"),
    ("GET", "/internal/v1/basht/runs/{run_id}"),
    ("POST", "/internal/v1/basht/runs/{run_id}/stop"),
}
BROWSER_TOKEN_ROUTES = {("POST", "/internal/browser/smoke"), ("POST", "/internal/browser/read")}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_SECRET", SECRET)
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", BROWSER_TOKEN)
    monkeypatch.setenv("BROWSER_SERVICE_URL", WORKER)
    for var in ("SERVICE_AUTH_SECRET_PREVIOUS", "APP_DATABASE_URL", "DATABASE_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())


@pytest.fixture
def worker_calls(monkeypatch):
    """Any attempt to reach the browser worker is recorded; unauthenticated requests must record none."""
    calls: list[str] = []

    def fake(request, timeout):  # noqa: ARG001
        calls.append(request.full_url)
        raise AssertionError("the browser worker must not be contacted")

    monkeypatch.setattr(main.urllib_request, "urlopen", fake)
    return calls


@pytest.fixture
def client():
    return TestClient(app)


def _walk(dependant):
    yield dependant.call
    for sub in dependant.dependencies:
        yield from _walk(sub)


def _flatten(routes, prefix=""):
    """Every concrete route, including those added with include_router (FastAPI keeps those behind a wrapper object).
    Fails closed on anything it does not understand under /internal, so a mounted sub-app cannot hide a route."""
    for route in routes:
        if isinstance(route, APIRoute):
            yield prefix + route.path, route
        elif hasattr(route, "original_router") and hasattr(route, "include_context"):
            yield from _flatten(route.original_router.routes, prefix + route.include_context.prefix)
        elif type(route).__name__ == "Mount" or getattr(route, "path", "").startswith("/internal"):
            pytest.fail(f"unsupported route object {type(route).__name__} at {getattr(route, 'path', '?')}: cannot prove it is guarded")
        # plain Starlette routes (/docs, /openapi.json, /redoc) are not under /internal


def _internal_routes():
    for path, route in _flatten(app.routes):
        if path == "/internal" or path.startswith("/internal/"):
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                yield method, path, route


def _signed_headers(method="GET", target="/internal/v1/ping", body=b""):
    ts, nonce = int(time.time()), f"nonce{time.monotonic_ns():020d}"[-24:]
    return {"x-svc-ts": str(ts), "x-svc-nonce": nonce, "x-svc-sig": sign(SECRET.encode(), method, target, ts, nonce, body)}


# ── 1. inventory: nothing under /internal is unguarded, nothing is silently exempt ───────────────────────────────
def test_every_internal_route_is_on_one_approved_list():
    found = {(m, p) for m, p, _ in _internal_routes()}
    assert found == SIGNED_ROUTES | BROWSER_TOKEN_ROUTES, (
        "a route under /internal was added or removed: give it an explicit guard and list it in this test deliberately"
    )


def test_every_discovered_internal_route_rejects_an_unauthenticated_call(client, worker_calls):
    """Independent of how a guard is written: whatever lives under /internal must say 401 to a caller with no credentials."""
    routes = list(_internal_routes())
    assert routes, "route discovery returned nothing: the inventory would be vacuous"
    for method, path, _ in routes:
        r = client.request(method, path, json={} if method == "POST" else None)
        assert r.status_code == 401, f"{method} {path} answered {r.status_code} to an unauthenticated request"
    assert worker_calls == []


def test_every_signed_route_depends_on_the_service_signature():
    for method, path, route in _internal_routes():
        if (method, path) in SIGNED_ROUTES:
            assert require_service_call in set(_walk(route.dependant)), f"{method} {path} lost its signature dependency"


def test_there_is_no_global_exemption_or_guard_hiding_behind_middleware():
    # A middleware that special-cased a prefix would be an app-wide exemption. The ONLY one allowed is the reject-only body ceiling
    # (it can answer 413, never let anything through); it authenticates nothing and exempts nothing.
    from app.body_limit import BodyLimitMiddleware

    assert [m.cls for m in app.user_middleware] == [BodyLimitMiddleware]
    assert app.router.dependencies == []


def test_the_two_mechanisms_are_not_mixed_on_one_route():
    for method, path, route in _internal_routes():
        has_signature = require_service_call in set(_walk(route.dependant))
        assert has_signature == ((method, path) in SIGNED_ROUTES), f"{method} {path}: wrong mechanism"


# ── 2. a credential for one mechanism never opens the other ──────────────────────────────────────────────────────
@pytest.mark.parametrize("path", ["/internal/browser/read", "/internal/browser/smoke"])
def test_a_valid_service_signature_does_not_open_the_browser_routes(client, worker_calls, path):
    body = b"{}"
    headers = _signed_headers("POST", path, body) | {"content-type": "application/json"}
    r = client.post(path, content=body, headers=headers)
    assert r.status_code == 401 and r.json() == {"detail": "Unauthorized"}
    assert worker_calls == []


def test_the_browser_token_does_not_open_the_signed_route_and_burns_no_nonce(client):
    r = client.get("/internal/v1/ping", headers={"Authorization": f"Bearer {BROWSER_TOKEN}"})
    assert r.status_code == 401
    # a perfectly valid signed call right afterwards still works: nothing was consumed by the rejected attempt
    assert client.get("/internal/v1/ping", headers=_signed_headers()).status_code == 200


def test_the_service_secret_is_not_accepted_as_a_browser_token(client, worker_calls):
    r = client.post("/internal/browser/read", json={}, headers={"Authorization": f"Bearer {SECRET}"})
    assert r.status_code == 401 and worker_calls == []


# ── 3. browser routes keep their contract and fail closed ────────────────────────────────────────────────────────
@pytest.mark.parametrize("path", ["/internal/browser/read", "/internal/browser/smoke"])
@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": ""},
        {"Authorization": "Bearer "},
        {"Authorization": "Bearer wrong"},
        {"Authorization": "bearer " + BROWSER_TOKEN},          # scheme is case-sensitive today: do not loosen it
        {"Authorization": "Basic " + BROWSER_TOKEN},
        {"Authorization": BROWSER_TOKEN},
        {"Authorization": "Bearer " + BROWSER_TOKEN + "x"},
        {"Authorization": "Bearer " + BROWSER_TOKEN[:-1]},
        {"Authorization": "Bearer " + "z" * len(BROWSER_TOKEN)},                         # same length, nothing in common
        {"Authorization": "Bearer " + BROWSER_TOKEN[:-1] + "x"},                        # one character off at the end
        {"Authorization": "Bearer " + "x" + BROWSER_TOKEN[1:]},                         # one character off at the start
        {"Authorization": "Bearer " + BROWSER_TOKEN[:20] + "x" * (len(BROWSER_TOKEN) - 20)},  # long shared prefix
    ],
    ids=["none", "empty", "empty-bearer", "wrong", "lowercase-scheme", "basic", "no-scheme", "longer", "shorter",
         "same-length", "last-char-off", "first-char-off", "shared-prefix"],
)
def test_browser_routes_reject_every_bad_credential_without_touching_the_worker(client, worker_calls, path, headers):
    r = client.post(path, json={}, headers=headers)
    assert r.status_code == 401 and r.json() == {"detail": "Unauthorized"}
    assert worker_calls == []


@pytest.mark.parametrize("path", ["/internal/browser/read", "/internal/browser/smoke"])
@pytest.mark.parametrize("configured", ["", "short", "x" * 31])
def test_browser_routes_are_closed_when_the_token_is_unset_or_weak(client, worker_calls, monkeypatch, path, configured):
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", configured)
    for presented in (configured, "", "Bearer"):
        headers = {"Authorization": f"Bearer {presented}"}
        assert client.post(path, json={}, headers=headers).status_code == 401
    assert worker_calls == []


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


AUTH = {"Authorization": f"Bearer {BROWSER_TOKEN}"}


def test_smoke_contract_is_unchanged(client, monkeypatch):
    seen = {}

    def fake(request, timeout):
        seen.update(url=request.full_url, auth=request.get_header("Authorization"), body=request.data, timeout=timeout)
        return _Resp(json.dumps({"ok": True, "title": "Example Domain" + "!" * 300}).encode())

    monkeypatch.setattr(main.urllib_request, "urlopen", fake)
    r = client.post("/internal/browser/smoke", json={}, headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"ok": True, "title": ("Example Domain" + "!" * 300)[:200]}
    assert seen["url"] == WORKER + "/v1/navigate" and seen["auth"] == "Bearer " + BROWSER_TOKEN
    assert json.loads(seen["body"]) == {"url": "https://example.com"} and seen["timeout"] == 35


def test_read_contract_is_unchanged(client, monkeypatch):
    seen = {}
    payload = {"ok": True, "title": "T", "url": "https://example.com/", "excerpt": "E" * 5000,
               "screenshot": {"mimeType": "image/jpeg", "base64": "abcd"}, "extra": "dropped"}

    def fake(request, timeout):
        seen.update(timeout=timeout, auth=request.get_header("Authorization"))
        return _Resp(json.dumps(payload).encode())

    monkeypatch.setattr(main.urllib_request, "urlopen", fake)
    r = client.post("/internal/browser/read", json={"url": "https://example.com/"}, headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"ok": True, "title": "T", "url": "https://example.com/", "excerpt": "E" * 4000,
                        "screenshot": {"mimeType": "image/jpeg", "base64": "abcd"}}
    assert seen["timeout"] == 40 and seen["auth"] == "Bearer " + BROWSER_TOKEN


@pytest.mark.parametrize("path", ["/internal/browser/read", "/internal/browser/smoke"])
def test_worker_failures_become_a_generic_502(client, monkeypatch, path):
    def boom(request, timeout):
        raise URLError("connection refused: http://safwan-browser.railway.internal:8080")

    monkeypatch.setattr(main.urllib_request, "urlopen", boom)
    r = client.post(path, json={}, headers=AUTH)
    assert r.status_code == 502 and "railway.internal" not in r.text and BROWSER_TOKEN not in r.text


def test_read_refuses_oversized_or_non_jpeg_worker_replies(client, monkeypatch):
    huge = json.dumps({"ok": True, "pad": "x" * 400_100}).encode()
    for raw in (huge, json.dumps({"ok": True, "screenshot": {"mimeType": "image/png", "base64": "a"}}).encode(),
                json.dumps({"ok": False, "screenshot": {"mimeType": "image/jpeg", "base64": "a"}}).encode()):
        monkeypatch.setattr(main.urllib_request, "urlopen", lambda request, timeout, raw=raw: _Resp(raw))
        assert client.post("/internal/browser/read", json={}, headers=AUTH).status_code == 502


@pytest.mark.parametrize("url", ["http://example.com", "https://example.com.evil.test", "https://evil.test/https://example.com",
                                 "https://example.com@evil.test", "file:///etc/passwd", "https://169.254.169.254/"])
def test_the_url_allow_list_still_applies_after_authentication(client, worker_calls, url):
    for path in ("/internal/browser/read", "/internal/browser/smoke"):
        assert client.post(path, json={"url": url}, headers=AUTH).status_code == 400
    assert worker_calls == []


def test_the_worker_address_is_pinned(client, worker_calls, monkeypatch):
    monkeypatch.setenv("BROWSER_SERVICE_URL", "http://attacker.example:8080")
    for path in ("/internal/browser/read", "/internal/browser/smoke"):
        assert client.post(path, json={}, headers=AUTH).status_code == 503
    assert worker_calls == []


# ── 4. no path trick turns an unauthenticated request into a success ─────────────────────────────────────────────
@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/internal/browser/read/"), ("POST", "/internal/browser//read"), ("POST", "/internal/browser/READ"),
        ("POST", "/internal/browser/%72ead"), ("POST", "/internal/browser/read;x"), ("POST", "/internal/browser/../browser/read"),
        ("GET", "/internal/v1/ping/"), ("GET", "/internal/v1//ping"), ("GET", "/internal/v1/PING"),
        ("GET", "/internal/v1/%70ing"), ("GET", "/internal/browser/../v1/ping"), ("GET", "/internal/"), ("GET", "/internal"),
        ("GET", "/internal/v1"), ("GET", "/internal/v1/"), ("POST", "/internal/browser"), ("POST", "/internal/browser/"),
        ("GET", "/internal/anything"),
    ],
)
def test_unauthenticated_path_variants_never_succeed(client, worker_calls, path, method):
    body = {"json": {}} if method == "POST" else {}
    first = client.request(method, path, follow_redirects=False, **body)
    assert first.status_code in (307, 308, 401, 404, 405), f"{method} {path} -> {first.status_code}"
    final = client.request(method, path, follow_redirects=True, **body)
    assert final.status_code in (401, 404, 405), f"{method} {path} (redirects followed) -> {final.status_code}"
    assert worker_calls == []


def test_health_is_the_only_unauthenticated_route_outside_internal():
    from app.security import require_auth

    open_routes = {r.path for r in app.routes if isinstance(r, APIRoute) and not r.path.startswith("/internal")
                   and require_auth not in set(_walk(r.dependant))}
    assert open_routes == {"/health"}
