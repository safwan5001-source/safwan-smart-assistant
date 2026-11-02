"""Regression tests for the confirmed findings of the Independent Security Review of PR #26 (head 597f5c7).

Each test first FAILED on 597f5c7 (they reproduce the problem) and passes with the fix. Finding ids refer to docs/INDEPENDENT-SECURITY-REVIEW.md.
"""
from __future__ import annotations

import asyncio
import io
import secrets
import time

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import make_conninfo
from starlette.requests import Request

import app.service_auth as sa
from app import main
from app.config import get_settings
from app.db.connection import OverPrivilegedRole, connect_runtime
from app.main import app
from app.service_auth import MemoryNonceStore, sign

SECRET = "unit-test-secret-0123456789abcdef-0123456789abcdef"
TOKEN = "b" * 40
WORKER = "http://safwan-browser.railway.internal:8080"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_SECRET", SECRET)
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", TOKEN)
    monkeypatch.setenv("BROWSER_SERVICE_URL", WORKER)
    for var in ("SERVICE_AUTH_SECRET_PREVIOUS", "APP_DATABASE_URL", "DATABASE_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())


@pytest.fixture
def worker_calls(monkeypatch):
    calls: list[str] = []

    def fake(request, timeout):  # noqa: ARG001
        calls.append(request.full_url)
        raise AssertionError("the browser worker must not be contacted")

    monkeypatch.setattr(main.urllib_request, "urlopen", fake)
    return calls


@pytest.fixture
def client():
    return TestClient(app)


# ── IR-A1: unauthenticated callers could make the API buffer an unbounded body (memory / bandwidth amplification) ───
@pytest.mark.parametrize("path", ["/internal/browser/smoke", "/internal/browser/read"])
def test_browser_routes_refuse_an_oversized_declared_body_before_reading_it(client, worker_calls, path):
    r = client.post(path, content=b"x" * (64 * 1024), headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json() == {"detail": {"code": "payload_too_large"}}
    assert worker_calls == []


@pytest.mark.parametrize("path", ["/internal/browser/smoke", "/internal/browser/read"])
def test_browser_routes_cut_off_a_chunked_body_without_a_content_length(client, worker_calls, path):
    def chunks():
        for _ in range(64):  # 4 MiB in 64 KiB chunks, no Content-Length
            yield b"x" * 65536

    r = client.post(path, content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413 and worker_calls == []


@pytest.mark.parametrize("auth", [{}, AUTH], ids=["unauthenticated", "authenticated"])
def test_the_body_limit_applies_before_authentication_and_does_not_change_normal_requests(client, monkeypatch, auth):
    # a normal-sized valid request still behaves exactly as before (token required, url allow-list, worker pin)
    r = client.post("/internal/browser/read", json={"url": "https://evil.test"}, headers=auth)
    assert r.status_code == (400 if auth else 401)


def test_the_limit_stops_reading_the_stream_instead_of_buffering_it():
    from app.body_limit import BodyLimitMiddleware

    received = 0

    async def inner(scope, receive, send):  # an app that, like FastAPI, drains the whole body
        nonlocal received
        while True:
            m = await receive()
            if m["type"] != "http.request":
                break
            received += len(m.get("body", b""))
            if not m.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    sent: list[dict] = []
    chunks = [{"type": "http.request", "body": b"x" * 65536, "more_body": True} for _ in range(160)]  # 10 MiB offered
    chunks.append({"type": "http.request", "body": b"", "more_body": False})

    async def receive():
        return chunks.pop(0) if chunks else {"type": "http.disconnect"}

    async def send(m):
        sent.append(m)

    mw = BodyLimitMiddleware(inner, limits=[("/internal/browser/", 4096)])
    scope = {"type": "http", "method": "POST", "path": "/internal/browser/read", "headers": []}
    asyncio.run(mw(scope, receive, send))
    assert received <= 4096, f"the application was handed {received} bytes"
    assert sent[0]["status"] == 413 and len([m for m in sent if m["type"] == "http.response.start"]) == 1
    assert len(chunks) > 100, "the middleware kept pulling the oversized stream"


def test_the_signed_prefix_has_its_own_cap(client):
    r = client.post("/internal/v1/ping", content=b"x" * (sa.MAX_BODY_BYTES + 1))
    assert r.status_code == 413


# ── IR-A2: a non-ASCII Authorization header produced an unauthenticated 500 instead of the uniform 401 ──────────
@pytest.mark.parametrize("path", ["/internal/browser/smoke", "/internal/browser/read"])
@pytest.mark.parametrize("raw", [b"Bearer \xff" + b"a" * 39, b"Bearer " + "é".encode("latin-1") * 40, b"Bearer \xb2" * 8])
def test_non_ascii_authorization_is_a_401_not_a_500(client, worker_calls, path, raw):
    r = client.post(path, json={}, headers={"Authorization": raw})
    assert r.status_code == 401 and r.json() == {"detail": "Unauthorized"}
    assert worker_calls == []


# ── IR-A3: the browser token and the BFF secret must never be interchangeable ───────────────────────────────────
@pytest.mark.parametrize("path", ["/internal/browser/smoke", "/internal/browser/read"])
def test_equal_secret_and_browser_token_fail_closed_on_the_browser_routes(client, worker_calls, monkeypatch, path):
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", SECRET)
    assert client.post(path, json={}, headers={"Authorization": f"Bearer {SECRET}"}).status_code == 401
    assert worker_calls == []


def test_equal_secret_and_browser_token_fail_closed_on_the_signed_route(client, monkeypatch):
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", SECRET)
    ts, nonce = int(time.time()), "n" * 24
    h = {"x-svc-ts": str(ts), "x-svc-nonce": nonce, "x-svc-sig": sign(SECRET.encode(), "GET", "/internal/v1/ping", ts, nonce, b"")}
    assert client.get("/internal/v1/ping", headers=h).status_code == 503


def test_a_previous_secret_equal_to_the_browser_token_is_also_refused(client, worker_calls, monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_SECRET_PREVIOUS", TOKEN)
    assert client.post("/internal/browser/read", json={}, headers=AUTH).status_code == 401
    assert worker_calls == []


# ── IR-A7: a non-ASCII digit in Content-Length ('²'.isdigit() is True) must not raise out of the verifier ─────────
def test_unicode_digit_content_length_does_not_crash_the_verifier():
    ts, nonce = int(time.time()), "m" * 24
    sig = sign(SECRET.encode(), "GET", "/internal/v1/ping", ts, nonce, b"")
    headers = [(b"x-svc-ts", str(ts).encode()), (b"x-svc-nonce", nonce.encode()), (b"x-svc-sig", sig.encode()),
               (b"content-length", b"\xb2")]
    scope = {"type": "http", "method": "GET", "path": "/internal/v1/ping", "query_string": b"", "headers": headers}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    call = asyncio.run(sa.require_service_call(Request(scope, receive), get_settings(), MemoryNonceStore()))
    assert call.account_id is None


# ── DB-level findings (real PostgreSQL) ──────────────────────────────────────────────────────────────────────────
def _login(pg_dsn: str, grants: list[str]):
    name, password = "rev_g_" + secrets.token_hex(4), secrets.token_hex(8)
    with psycopg.connect(pg_dsn, autocommit=True) as c:
        db = c.execute("SELECT current_database()").fetchone()[0]
        c.execute(f"CREATE ROLE {name} LOGIN PASSWORD '{password}' IN ROLE safwan_app NOSUPERUSER NOBYPASSRLS")
        for g in grants:
            c.execute(g.format(r=name, db=f'"{db}"'))
    return name, make_conninfo(pg_dsn, user=name, password=password)


def _drop(pg_dsn: str, name: str):
    with psycopg.connect(pg_dsn, autocommit=True) as c:
        c.execute(f"DROP OWNED BY {name}")
        c.execute(f"DROP ROLE IF EXISTS {name}")


# IR-B2: the production guard only looked at attributes, so memberships that escalate (OS command execution, file access,
# owner via SET, CREATE on the database/public schema) were accepted and `smoke` printed SMOKE PASSED for them.
ESCALATING = {
    "pg_execute_server_program": ["GRANT pg_execute_server_program TO {r}"],
    "pg_read_server_files": ["GRANT pg_read_server_files TO {r}"],
    "pg_write_all_data": ["GRANT pg_write_all_data TO {r}"],
    "pg_signal_backend": ["GRANT pg_signal_backend TO {r}"],
    "owner via SET (INHERIT FALSE)": ["GRANT postgres TO {r} WITH INHERIT FALSE, SET TRUE"],
    "CREATE on the database": ["GRANT CREATE ON DATABASE {db} TO {r}"],
    "CREATE on schema public": ["GRANT CREATE ON SCHEMA public TO {r}"],
}


@pytest.mark.parametrize("grants", ESCALATING.values(), ids=ESCALATING.keys())
def test_production_guard_refuses_roles_that_can_escalate(pg_dsn, grants):
    name, dsn = _login(pg_dsn, grants)
    try:
        with pytest.raises(OverPrivilegedRole):
            connect_runtime(dsn, production=True)
    finally:
        _drop(pg_dsn, name)


def test_guard_catches_ownership_reachable_only_through_SET(pg_dsn):
    """Relations owned by the application role itself, login joined with INHERIT FALSE, SET TRUE: no USAGE (so the old check
    passed), yet `SET ROLE safwan_app` makes it the owner and RLS stops applying. Needs the MEMBER test specifically."""
    name, password = "rev_s_" + secrets.token_hex(4), secrets.token_hex(8)
    table = "rev_owned_" + secrets.token_hex(4)
    with psycopg.connect(pg_dsn, autocommit=True) as c:
        c.execute(f"CREATE ROLE {name} LOGIN PASSWORD '{password}' NOSUPERUSER NOBYPASSRLS")
        c.execute(f"GRANT safwan_app TO {name} WITH INHERIT FALSE, SET TRUE")
        c.execute(f"CREATE TABLE public.{table} (id int)")
        c.execute(f"ALTER TABLE public.{table} OWNER TO safwan_app")
    try:
        with pytest.raises(OverPrivilegedRole):
            connect_runtime(make_conninfo(pg_dsn, user=name, password=password), production=True)
    finally:
        with psycopg.connect(pg_dsn, autocommit=True) as c:
            c.execute(f"DROP TABLE IF EXISTS public.{table}")
            c.execute(f"DROP OWNED BY {name}")
            c.execute(f"DROP ROLE IF EXISTS {name}")


def test_production_guard_still_accepts_the_intended_runtime_login(pg_dsn):
    name, dsn = _login(pg_dsn, [])
    try:
        connect_runtime(dsn, production=True).close()
    finally:
        _drop(pg_dsn, name)


def test_smoke_does_not_pass_for_an_escalating_login(pg_dsn, capsys):
    from app.db import smoke

    name, dsn = _login(pg_dsn, ["GRANT pg_execute_server_program TO {r}"])
    try:
        code = smoke.run({"APP_DATABASE_URL": dsn})
        out = capsys.readouterr().out
        assert code != 0 and "SMOKE PASSED" not in out and "FAIL" in out
    finally:
        _drop(pg_dsn, name)


# IR-B5: a compromised runtime login can `ALTER ROLE self SET ...`; re-running phase 2 rotated the password but left the
# settings in place (persistent denial of service, e.g. statement_timeout = 1ms).
def test_phase_2_wipes_role_level_settings_the_login_planted():
    from tests.test_bootstrap import PW_RUNTIME, admin, host, owner_dsn, run_migrations_and_phase_2, run_phase_1  # noqa: F401
    from app.db.bootstrap import bootstrap_runtime

    base = __import__("tests.pg_support", fromlist=["admin_url"]).admin_url()
    tag = secrets.token_hex(3)
    n = {"db": f"ir_db_{tag}", "owner": f"ir_owner_{tag}", "runtime": f"ir_rt_{tag}"}
    try:
        run_phase_1(base, n)
        run_migrations_and_phase_2(base, n)
        with admin(base) as a:
            a.execute(f"ALTER ROLE {n['runtime']} SET statement_timeout = '1ms'")
            a.execute(f"ALTER ROLE {n['runtime']} SET default_transaction_read_only = on")
            a.execute(f'ALTER ROLE {n["runtime"]} IN DATABASE "{n["db"]}" SET search_path = pg_temp')
        with psycopg.connect(owner_dsn(base, n), autocommit=True) as o:
            bootstrap_runtime(o, runtime=n["runtime"], runtime_password=PW_RUNTIME)
        with admin(base) as a:
            left = a.execute("SELECT count(*) FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = %s",
                             (n["runtime"],)).fetchone()[0]
        assert left == 0, "role-level settings planted by the runtime login survived the rotation"
    finally:
        with admin(base) as a:
            a.execute(f'DROP DATABASE IF EXISTS "{n["db"]}" WITH (FORCE)')
            for r in ("runtime", "owner"):
                a.execute(f'DROP ROLE IF EXISTS "{n[r]}"')
