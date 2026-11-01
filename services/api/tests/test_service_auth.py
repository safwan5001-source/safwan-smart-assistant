"""BFF -> API service authentication: signature, freshness, replay, tamper resistance, fail-closed behaviour."""
import json
import logging
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.service_auth as sa
from app.main import app
from app.service_auth import MemoryNonceStore, sign

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "shared" / "service-signature-vectors.json").read_text(encoding="utf-8"))
SECRET = "unit-test-secret-0123456789abcdef-0123456789abcdef"
ACCOUNT = "11111111-1111-4111-8111-111111111111"
PATH = "/internal/v1/ping"


@pytest.fixture(autouse=True)
def svc_env(monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_SECRET", SECRET)
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    monkeypatch.delenv("SERVICE_AUTH_SECRET_PREVIOUS", raising=False)
    monkeypatch.delenv("APP_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())


@pytest.fixture
def client():
    return TestClient(app)


_n = iter(range(10_000))


def signed(method="GET", target=PATH, body=b"", account=None, secret=SECRET, ts=None, nonce=None):
    ts = int(time.time()) if ts is None else ts
    nonce = nonce or f"nonce{next(_n):020d}"
    headers = {"x-svc-ts": str(ts), "x-svc-nonce": nonce, "x-svc-sig": sign(secret.encode(), method, target, ts, nonce, body, account)}
    if account:
        headers["x-svc-acct"] = account
    return headers


def get(client, **kw):
    kw_headers = kw.pop("headers", None)
    return client.get(kw.pop("target", PATH), headers=kw_headers if kw_headers is not None else signed(**kw))


# ── wire contract shared with the TypeScript BFF ─────────────────────────────
@pytest.mark.parametrize("v", VECTORS["vectors"], ids=lambda v: v["name"])
def test_shared_vectors_are_reproduced(v):
    secret = VECTORS["secret"].encode()
    body = v["body"].encode("utf-8")
    assert sa.body_sha256(body) == v["body_sha256"]
    assert sa.canonical(v["method"], v["target"], v["ts"], v["nonce"], v["body_sha256"], v["account"]).decode() == v["canonical"]
    assert sign(secret, v["method"], v["target"], v["ts"], v["nonce"], body, v["account"]) == v["signature"]


# ── the happy path and what it returns ───────────────────────────────────────
def test_valid_call_succeeds_and_returns_truthful_status(client):
    r = get(client)
    assert r.status_code == 200
    assert r.json()["status"] == "ok" and r.json()["features"]["assistant"] is False
    assert "secret" not in r.text.lower()


def test_account_binding_is_accepted_when_signed(client):
    assert get(client, account=ACCOUNT).status_code == 200


# ── authentication failures: every one is the same opaque 401 ─────────────────
def denied(r):
    assert r.status_code == 401 and r.json() == {"detail": {"code": "service_auth_failed"}}


def test_no_headers(client):
    denied(client.get(PATH))


def test_wrong_secret(client):
    denied(get(client, secret="a-completely-different-secret-of-sufficient-length-0000"))


def test_tampered_signature_bit(client):
    h = signed()
    h["x-svc-sig"] = ("0" if h["x-svc-sig"][0] != "0" else "1") + h["x-svc-sig"][1:]
    denied(get(client, headers=h))


@pytest.mark.parametrize("field,value", [("x-svc-ts", "abc"), ("x-svc-ts", "-5"), ("x-svc-ts", "9" * 20), ("x-svc-nonce", "short"),
                                         ("x-svc-nonce", "bad nonce with spaces!!"), ("x-svc-sig", "XYZ"), ("x-svc-sig", "A" * 64)])
def test_malformed_headers(client, field, value):
    h = signed()
    h[field] = value
    denied(get(client, headers=h))


@pytest.mark.parametrize("missing", ["x-svc-ts", "x-svc-nonce", "x-svc-sig"])
def test_each_required_header_is_required(client, missing):
    h = signed()
    h.pop(missing)
    denied(get(client, headers=h))


def test_stale_and_future_timestamps(client):
    denied(get(client, ts=int(time.time()) - 61))
    denied(get(client, ts=int(time.time()) + 61))
    assert get(client, ts=int(time.time()) - 30).status_code == 200


def test_replay_of_a_captured_request_is_refused(client):
    h = signed()
    assert client.get(PATH, headers=h).status_code == 200
    denied(client.get(PATH, headers=h))          # byte-identical resend
    denied(client.get(PATH, headers=h))          # and again


def test_query_string_is_covered_by_the_signature(client):
    h = signed(target=PATH + "?a=1")
    denied(client.get(PATH + "?a=2", headers=h))
    h2 = signed(target=PATH + "?a=1")
    assert client.get(PATH + "?a=1", headers=h2).status_code == 200


def test_path_is_covered_by_the_signature(client):
    h = signed(target="/internal/v1/other")
    denied(client.get(PATH, headers=h))


def test_method_is_covered_by_the_signature(client):
    h = signed(method="POST")
    denied(client.get(PATH, headers=h))


def test_account_cannot_be_added_removed_or_swapped(client):
    h = signed()
    h["x-svc-acct"] = ACCOUNT                                   # added after signing
    denied(client.get(PATH, headers=h))
    h = signed(account=ACCOUNT)
    h.pop("x-svc-acct")                                         # removed
    denied(client.get(PATH, headers=h))
    h = signed(account=ACCOUNT)
    h["x-svc-acct"] = "22222222-2222-4222-8222-222222222222"    # swapped
    denied(client.get(PATH, headers=h))


@pytest.mark.parametrize("bad", ["not-a-uuid", "00000000-0000-0000-0000-000000000000", ACCOUNT.upper() + "x"])
def test_malformed_or_nil_account_is_refused(client, bad):
    h = signed(account=ACCOUNT)
    h["x-svc-acct"] = bad
    denied(client.get(PATH, headers=h))


@pytest.mark.parametrize("name", ["x-svc-ts", "x-svc-nonce", "x-svc-sig", "x-svc-acct"])
@pytest.mark.parametrize("copy_first", [True, False], ids=["valid-first", "valid-last"])
def test_a_duplicated_service_header_is_refused_whichever_copy_is_valid(client, name, copy_first):
    """First-wins here vs last-wins in some proxies would let an injected copy decide what is verified: refuse both."""
    h = signed(account=ACCOUNT)
    other = {"x-svc-ts": str(int(time.time())), "x-svc-nonce": "z" * 22, "x-svc-sig": "0" * 64, "x-svc-acct": "22222222-2222-4222-8222-222222222222"}[name]
    pairs = list(h.items())
    pairs = pairs + [(name, other)] if copy_first else [(name, other)] + pairs
    denied(client.get(PATH, headers=pairs))
    assert client.get(PATH, headers=h).status_code == 200  # the refusal consumed nothing: the genuine request still works


def test_failed_signature_does_not_consume_the_nonce(client):
    h = signed()
    bad = dict(h, **{"x-svc-sig": "0" * 64})
    denied(client.get(PATH, headers=bad))
    assert client.get(PATH, headers=h).status_code == 200  # an attacker cannot burn a victim's nonce


def test_body_is_covered_by_the_signature(client):
    # No body-accepting internal route exists in B1; prove the primitive on the shared canonical form instead.
    a = sign(SECRET.encode(), "POST", "/x", 1, "n" * 22, b'{"a":1}', None)
    b = sign(SECRET.encode(), "POST", "/x", 1, "n" * 22, b'{"a":2}', None)
    assert a != b


def test_oversized_declared_body_is_rejected_before_hashing(client):
    r = client.get(PATH, headers=dict(signed(), **{"content-length": str(sa.MAX_BODY_BYTES + 1)}))
    assert r.status_code in (413, 400)


# ── key rotation ─────────────────────────────────────────────────────────────
def test_previous_secret_is_accepted_during_rotation_and_then_not(client, monkeypatch):
    old = "previous-secret-0123456789abcdef-0123456789abcdef"
    h = signed(secret=old)
    denied(client.get(PATH, headers=h))                                   # not configured as previous yet
    monkeypatch.setenv("SERVICE_AUTH_SECRET_PREVIOUS", old)
    assert client.get(PATH, headers=signed(secret=old)).status_code == 200
    assert client.get(PATH, headers=signed(secret=SECRET)).status_code == 200
    monkeypatch.delenv("SERVICE_AUTH_SECRET_PREVIOUS")
    denied(client.get(PATH, headers=signed(secret=old)))


# ── fail closed when misconfigured ───────────────────────────────────────────
@pytest.mark.parametrize("value", [None, "", "short-secret", "x" * 31])
def test_missing_or_weak_secret_disables_the_route(client, monkeypatch, value):
    if value is None:
        monkeypatch.delenv("SERVICE_AUTH_SECRET")
    else:
        monkeypatch.setenv("SERVICE_AUTH_SECRET", value)
    r = client.get(PATH, headers=signed())
    assert r.status_code == 503 and r.json()["detail"]["code"] == "service_auth_unconfigured"


def test_production_never_uses_the_memory_store_even_if_asked(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    r = client.get(PATH, headers=signed())
    assert r.status_code == 503 and r.json()["detail"]["code"] == "service_auth_unavailable"


def test_nonce_store_failure_fails_closed(client):
    class Broken:
        def claim(self, nonce, ttl):
            raise RuntimeError("db down")

    app.dependency_overrides[sa.get_nonce_store] = lambda: Broken()
    try:
        r = client.get(PATH, headers=signed())
        assert r.status_code == 503 and r.json()["detail"]["code"] == "service_auth_unavailable"
    finally:
        app.dependency_overrides.clear()


def test_full_memory_store_fails_closed_instead_of_forgetting(client):
    store = MemoryNonceStore(max_entries=2)
    app.dependency_overrides[sa.get_nonce_store] = lambda: store
    try:
        assert get(client).status_code == 200
        assert get(client).status_code == 200
        assert get(client).status_code == 503
    finally:
        app.dependency_overrides.clear()


def test_nonce_store_runs_off_the_event_loop(client):
    import asyncio

    seen = {}

    class Probe:
        def claim(self, nonce, ttl):
            try:
                asyncio.get_running_loop()
                seen["on_loop"] = True
            except RuntimeError:
                seen["on_loop"] = False
            return True

    app.dependency_overrides[sa.get_nonce_store] = lambda: Probe()
    try:
        assert client.get(PATH, headers=signed()).status_code == 200
    finally:
        app.dependency_overrides.clear()
    assert seen == {"on_loop": False}, "synchronous database work must not run on the event loop"


# ── public surface unchanged ────────────────────────────────────────────────
def test_health_stays_public_and_protected_routes_stay_locked_in_production(client, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    assert client.get("/health").status_code == 200
    assert client.get("/tools").status_code == 503
    assert client.get("/tools", headers=signed()).status_code == 503  # a valid service signature does NOT unlock user routes (B2)


def test_internal_routes_are_not_in_the_public_openapi_schema(client):
    assert "/internal/v1/ping" not in client.get("/openapi.json").json()["paths"]


# ── nothing sensitive reaches logs or responses ──────────────────────────────
def test_logs_never_contain_secrets_or_signatures(client, caplog):
    caplog.set_level(logging.DEBUG)
    h = signed()
    client.get(PATH, headers=h)
    client.get(PATH, headers=h)                       # replay -> logged denial
    client.get(PATH, headers=dict(h, **{"x-svc-sig": "0" * 64}))
    blob = "\n".join(r.getMessage() for r in caplog.records)
    for secret_like in (SECRET, h["x-svc-sig"], h["x-svc-nonce"]):
        assert secret_like not in blob


# ── real PostgreSQL nonce store behind the real dependency ───────────────────
def test_replay_protection_works_through_postgres(pg_dsn, pg_owner, monkeypatch):
    monkeypatch.setenv("SERVICE_NONCE_STORE", "postgres")
    monkeypatch.setenv("APP_DATABASE_URL", pg_dsn)
    c = TestClient(app)
    h = signed()
    assert c.get(PATH, headers=h).status_code == 200
    denied(c.get(PATH, headers=h))
    assert pg_owner.execute("SELECT count(*) FROM service_nonces").fetchone()[0] == 1
    assert get(c).status_code == 200


def test_production_with_postgres_accepts_signed_calls_only(pg_runtime_dsn, pg_owner, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SERVICE_NONCE_STORE", "postgres")
    monkeypatch.setenv("APP_DATABASE_URL", pg_runtime_dsn)
    c = TestClient(app)
    denied(c.get(PATH))
    assert get(c).status_code == 200


def test_production_refuses_an_over_privileged_database_role(pg_dsn, pg_owner, monkeypatch):
    """The superuser/owner DSN would make RLS meaningless; production must refuse it, not run with it."""
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_DATABASE_URL", pg_dsn)
    c = TestClient(app)
    r = c.get(PATH, headers=signed())
    assert r.status_code == 503 and r.json()["detail"]["code"] == "service_auth_unavailable"
    assert pg_owner.execute("SELECT count(*) FROM service_nonces").fetchone()[0] == 0  # nothing was recorded


def test_the_owner_style_DATABASE_URL_is_ignored_entirely(client, pg_dsn, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DATABASE_URL", pg_dsn)  # what a managed-Postgres integration injects
    r = client.get(PATH, headers=signed())
    assert r.status_code == 503 and r.json()["detail"]["code"] == "service_auth_unavailable"


# ── request body limit is enforced while streaming, before the whole body is buffered ──
def test_chunked_oversize_body_is_cut_off_early_without_content_length():
    """ASGI-level: count what the server actually pulled from the socket (TestClient pre-reads, so it cannot show this)."""
    import asyncio

    from fastapi import HTTPException
    from starlette.requests import Request

    chunk, delivered = b"x" * 65536, {"n": 0}

    async def receive():
        delivered["n"] += 1
        return {"type": "http.request", "body": chunk, "more_body": delivered["n"] < 64}  # 4 MiB offered, no Content-Length

    scope = {"type": "http", "method": "GET", "path": PATH, "headers": [], "query_string": b""}
    with pytest.raises(HTTPException) as exc:
        asyncio.run(sa._read_body_limited(Request(scope, receive)))
    assert exc.value.status_code == 413
    assert delivered["n"] * 65536 <= sa.MAX_BODY_BYTES + 2 * 65536, f"pulled {delivered['n']} chunks before refusing"


def test_body_up_to_the_limit_is_accepted_and_still_readable_downstream(client):
    from fastapi import APIRouter, Request

    router = APIRouter(prefix="/internal/v1")

    @router.post("/echo-len")
    async def echo(request: Request, call: sa.ServiceCall = __import__("fastapi").Depends(sa.require_service_call)):
        return {"len": len(await request.body())}  # the dependency must not have swallowed the stream

    app.include_router(router)
    try:
        payload = b"y" * 1000
        h = signed(method="POST", target="/internal/v1/echo-len", body=payload)
        r = client.post("/internal/v1/echo-len", headers=h, content=payload)
        assert r.status_code == 200 and r.json() == {"len": 1000}
    finally:
        app.router.routes[:] = [rt for rt in app.router.routes if getattr(rt, "path", "") != "/internal/v1/echo-len"]


# ── freshness must also hold at the moment the nonce is claimed (after a slow body) ──
def test_a_slowly_delivered_body_cannot_outlive_the_nonce_retention_window():
    """Replay attempt: valid headers, then the body trickles in until the original nonce has expired from the store.
    Freshness is therefore re-checked right before claiming, so a request can never be accepted later than ts+SKEW."""
    import asyncio

    from fastapi import HTTPException
    from starlette.requests import Request

    from app.config import get_settings

    ts = 1_800_000_000
    clock = {"now": float(ts)}
    h = signed(ts=ts)  # signed for ts; the first freshness check happens at "now == ts"
    scope = {"type": "http", "method": "GET", "path": PATH, "query_string": b"", "headers": [(k.encode(), v.encode()) for k, v in h.items()]}
    calls = {"n": 0}

    async def receive():
        calls["n"] += 1
        clock["now"] = ts + sa.NONCE_TTL_SECONDS + 1  # the body takes "181 seconds" to arrive
        return {"type": "http.request", "body": b"", "more_body": False}

    real_time = sa.time.time
    sa.time.time = lambda: clock["now"]
    try:
        store = MemoryNonceStore()
        with pytest.raises(HTTPException) as exc:
            asyncio.run(sa.require_service_call(Request(scope, receive), get_settings(), store))
        assert exc.value.status_code == 401
        assert store._seen == {}, "the nonce must not even be claimed for a stale request"
    finally:
        sa.time.time = real_time


def test_body_reading_has_a_deadline(client):
    import asyncio

    from fastapi import HTTPException
    from starlette.requests import Request

    from app.config import get_settings

    h = signed()
    scope = {"type": "http", "method": "GET", "path": PATH, "query_string": b"", "headers": [(k.encode(), v.encode()) for k, v in h.items()]}

    async def receive():  # a client that never finishes sending
        await asyncio.sleep(3600)

    old = sa.BODY_READ_DEADLINE_SECONDS
    sa.BODY_READ_DEADLINE_SECONDS = 0.05
    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(sa.require_service_call(Request(scope, receive), get_settings(), MemoryNonceStore()))
        assert exc.value.status_code == 408
    finally:
        sa.BODY_READ_DEADLINE_SECONDS = old
