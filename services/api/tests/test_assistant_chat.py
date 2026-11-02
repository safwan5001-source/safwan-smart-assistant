"""End-to-end (real PostgreSQL + a local fake Anthropic server): authentication, account separation, hard spend/rate limits,
streaming, stop/partial persistence, durable conversations. No real key, no real customer data."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

import app.service_auth as sa
from app.main import app
from app.service_auth import MemoryNonceStore, sign
from tests.pg_support import ACCOUNT_A, ACCOUNT_B, make_account

SECRET = "unit-test-secret-0123456789abcdef-0123456789abcdef"
KEY = "sk-ant-TEST-ONLY-NOT-A-REAL-KEY"
MODELS = json.dumps([
    {"id": "m-small", "label": "Small", "input_per_mtok": "1", "output_per_mtok": "5", "max_output": 2000},
    {"id": "m-big", "label": "Big", "input_per_mtok": "10", "output_per_mtok": "50", "max_output": 2000},
])


class Fake:
    """Local stand-in for api.anthropic.com. `chunks` are streamed one by one; `gate` can hold the stream open mid-answer."""
    def __init__(self):
        self.requests: list[dict] = []
        self.headers: list[dict] = []
        self.chunks = ["مرحبا", " بك", " يا صفوان"]
        self.out_tokens, self.in_tokens = 9, 21
        self.gate: threading.Event | None = None
        self.status = 200
        self.upstream_closed = threading.Event()
        self.probe_status = 200


@pytest.fixture
def fake():
    f = Fake()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            f.headers.append({"path": self.path, **{k.lower(): v for k, v in self.headers.items()}})
            self.send_response(f.probe_status); self.send_header("content-length", "2"); self.end_headers(); self.wfile.write(b"{}")
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            f.requests.append(body); f.headers.append({"path": self.path, **{k.lower(): v for k, v in self.headers.items()}})
            if f.status != 200:
                self.send_response(f.status); self.send_header("content-length", "2"); self.end_headers(); self.wfile.write(b"{}"); return
            self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
            def ev(t, d): self.wfile.write(f"event: {t}\ndata: {json.dumps(d)}\n\n".encode()); self.wfile.flush()
            try:
                ev("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": f.in_tokens, "output_tokens": 1}}})
                for i, c in enumerate(f.chunks):
                    ev("content_block_delta", {"type": "content_block_delta", "delta": {"type": "text_delta", "text": c}})
                    if f.gate is not None and i == 0:
                        f.gate.wait(10)
                ev("message_delta", {"type": "message_delta", "usage": {"output_tokens": f.out_tokens}})
                ev("message_stop", {"type": "message_stop"})
            except (BrokenPipeError, ConnectionResetError):
                f.upstream_closed.set()

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    f.url = f"http://127.0.0.1:{srv.server_address[1]}"
    yield f
    srv.shutdown()


@pytest.fixture
def env(monkeypatch, pg_runtime_dsn, pg_owner, fake):
    make_account(pg_owner, ACCOUNT_A, "Owner A")
    make_account(pg_owner, ACCOUNT_B, "Other B")
    for k, v in {
        "APP_ENV": "test", "SERVICE_AUTH_SECRET": SECRET, "SERVICE_NONCE_STORE": "memory", "APP_DATABASE_URL": pg_runtime_dsn,
        "ASSISTANT_PROVIDER": "anthropic", "ANTHROPIC_API_KEY": KEY, "ANTHROPIC_MODELS": MODELS, "ANTHROPIC_DEFAULT_MODEL": "m-small",
        "ANTHROPIC_BASE_URL": fake.url, "AI_DAILY_BUDGET_USD": "1", "AI_MONTHLY_BUDGET_USD": "5", "AI_REQUESTS_PER_MINUTE": "50",
        "ANTHROPIC_MAX_OUTPUT_TOKENS": "1000", "AI_ALLOWED_ACCOUNT_IDS": f"{ACCOUNT_A}",
    }.items():
        monkeypatch.setenv(k, v)
    for k in ("SERVICE_AUTH_SECRET_PREVIOUS", "DATABASE_URL", "BROWSER_SERVICE_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())
    return monkeypatch


class Caller:
    def __init__(self, account: UUID | None = ACCOUNT_A):
        self.account, self.c, self.n = account, TestClient(app), 0

    def headers(self, method, path, body=b""):
        self.n += 1
        ts, nonce = int(time.time()), f"n{uuid4().hex}"[:30]
        h = {"x-svc-ts": str(ts), "x-svc-nonce": nonce, "x-svc-sig": sign(SECRET.encode(), method, path, ts, nonce, body, str(self.account) if self.account else None)}
        if self.account:
            h["x-svc-acct"] = str(self.account)
        return h

    def get(self, path):
        return self.c.get(path, headers=self.headers("GET", path))

    def post(self, path, obj):
        body = json.dumps(obj).encode()
        return self.c.post(path, content=body, headers={**self.headers("POST", path, body), "content-type": "application/json"})

    def chat(self, cid, message, **kw):
        path = "/internal/v1/assistant/chat"
        body = json.dumps({"conversation_id": str(cid), "message": message, **kw}).encode()
        with self.c.stream("POST", path, content=body, headers={**self.headers("POST", path, body), "content-type": "application/json"}) as r:
            if r.status_code != 200:
                r.read()
                return r.status_code, r.json()
            return 200, [json.loads(line) for line in r.iter_lines() if line]


def text_of(events): return "".join(e["text"] for e in events if e["type"] == "delta")
def usage_row(owner, account, kind="day"):
    return owner.execute("SELECT spent_micro, reserved_micro, requests FROM ai_usage WHERE account_id=%s AND period LIKE %s", (account, kind + ":%")).fetchone()


# ── authentication & authorisation ───────────────────────────────────────────────────────────────
def test_unsigned_calls_are_rejected_and_nothing_reaches_anthropic(env, fake):
    c = TestClient(app)
    for m, p in [("GET", "/internal/v1/assistant/state"), ("POST", "/internal/v1/assistant/chat"), ("GET", "/internal/v1/assistant/conversations")]:
        assert c.request(m, p, json={} if m == "POST" else None).status_code == 401
    assert fake.requests == []


def test_a_signed_call_without_an_account_is_forbidden(env, fake):
    assert Caller(None).get("/internal/v1/assistant/state").status_code == 403
    assert Caller(None).chat(uuid4(), "hi")[0] == 403
    assert fake.requests == []


def test_an_account_not_on_the_api_allow_list_cannot_spend(env, fake, pg_owner):
    r = Caller(ACCOUNT_B).chat(uuid4(), "hi")
    assert r[0] == 403 and fake.requests == []
    assert pg_owner.execute("SELECT count(*) FROM ai_usage").fetchone()[0] == 0


def test_a_disabled_account_is_refused(env, fake, pg_owner):
    pg_owner.execute("UPDATE accounts SET disabled_at = now() WHERE id=%s", (ACCOUNT_A,))
    assert Caller().chat(uuid4(), "hi")[0] == 403 and fake.requests == []


def test_replayed_signature_is_rejected(env):
    caller = Caller()
    h = caller.headers("GET", "/internal/v1/assistant/state")
    assert caller.c.get("/internal/v1/assistant/state", headers=h).status_code == 200
    assert caller.c.get("/internal/v1/assistant/state", headers=h).status_code == 401


def test_unconfigured_feature_is_503_not_open(env, monkeypatch, fake):
    monkeypatch.delenv("AI_DAILY_BUDGET_USD")
    assert Caller().chat(uuid4(), "hi")[0] == 503 and fake.requests == []


# ── streaming, persistence ────────────────────────────────────────────────────────────────────────
def test_streams_incrementally_persists_and_the_key_stays_server_side(env, fake, pg_owner):
    cid = uuid4()
    status, events = Caller().chat(cid, "ما هو الطقس؟")
    assert status == 200
    assert [e["type"] for e in events] == ["start", "delta", "delta", "delta", "done"]
    assert text_of(events) == "مرحبا بك يا صفوان"
    assert events[-1]["usage"] == {"input_tokens": 21, "output_tokens": 9, "cost_usd": events[-1]["usage"]["cost_usd"]}
    assert fake.headers[-1]["x-api-key"] == KEY and fake.requests[-1]["stream"] is True and fake.requests[-1]["model"] == "m-small"
    assert KEY not in json.dumps(events)
    conv = Caller().get(f"/internal/v1/assistant/conversations/{cid}").json()
    assert [(m["role"], m["content"]) for m in conv["messages"]] == [("user", "ما هو الطقس؟"), ("assistant", "مرحبا بك يا صفوان")]
    assert KEY not in json.dumps(conv)
    # persisted in PostgreSQL (the durable store), not in process memory
    assert pg_owner.execute("SELECT count(*) FROM sync_records WHERE kind='message'").fetchone()[0] == 2


def test_context_is_loaded_from_the_server_not_trusted_from_the_client(env, fake):
    cid = uuid4()
    Caller().chat(cid, "اسمي صفوان")
    Caller().chat(cid, "ما اسمي؟")
    sent = fake.requests[-1]["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user"]
    assert sent[0]["content"] == "اسمي صفوان" and sent[1]["content"] == "مرحبا بك يا صفوان" and sent[2]["content"] == "ما اسمي؟"


def test_context_survives_a_new_process(env, fake, monkeypatch):
    """'Reopening the app': a brand new client/process only needs the conversation id."""
    cid = uuid4()
    Caller().chat(cid, "الرقم السري للتجربة 4242")
    fresh = Caller()  # new TestClient, new nonce store
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())
    fresh.chat(cid, "كرر ما قلته")
    assert fake.requests[-1]["messages"][0]["content"] == "الرقم السري للتجربة 4242"
    assert len(fresh.get(f"/internal/v1/assistant/conversations/{cid}").json()["messages"]) == 4


def test_conversations_are_separated_between_accounts(env, fake, monkeypatch, pg_owner):
    monkeypatch.setenv("AI_ALLOWED_ACCOUNT_IDS", f"{ACCOUNT_A},{ACCOUNT_B}")
    cid = uuid4()
    Caller(ACCOUNT_A).chat(cid, "سر خاص بالحساب A")
    b = Caller(ACCOUNT_B)
    assert b.get(f"/internal/v1/assistant/conversations/{cid}").status_code == 404
    assert b.get("/internal/v1/assistant/conversations").json()["conversations"] == []
    assert b.post(f"/internal/v1/assistant/conversations/{cid}/delete", {}).status_code == 404
    # B reusing A's conversation id must not read, extend or reveal A's history
    code, ev = b.chat(cid, "ما السر؟")
    assert all("سر خاص" not in m["content"] for m in fake.requests[-1]["messages"])
    assert Caller(ACCOUNT_A).get(f"/internal/v1/assistant/conversations/{cid}").json()["messages"][0]["content"] == "سر خاص بالحساب A"


def test_delete_hides_the_conversation_and_its_messages(env, fake):
    cid = uuid4()
    Caller().chat(cid, "للحذف")
    assert Caller().post(f"/internal/v1/assistant/conversations/{cid}/delete", {}).status_code == 200
    assert Caller().get(f"/internal/v1/assistant/conversations/{cid}").status_code == 404
    assert Caller().chat(cid, "بعد الحذف")[0] == 404
    assert Caller().get("/internal/v1/assistant/conversations").json()["conversations"] == []


def test_stop_midstream_saves_the_partial_answer_and_closes_upstream(env, fake, pg_owner):
    from app.config import get_settings
    from app.internal import ChatRequest, assistant_chat
    from app.service_auth import ServiceCall
    fake.gate = threading.Event()
    fake.chunks = ["جزء أول", " جزء ثان", " جزء ثالث"]
    cid = uuid4()

    async def go():
        resp = assistant_chat(ChatRequest(conversation_id=cid, message="ابدأ"), get_settings(), ServiceCall(account_id=ACCOUNT_A))
        it = resp.body_iterator
        first = await it.__anext__(); second = await it.__anext__()
        await it.aclose()  # the client pressed Stop / went away
        return first, second
    first, second = asyncio.run(go())
    assert b'"start"' in first and "جزء أول" in second.decode()
    fake.gate.set()
    conv = Caller().get(f"/internal/v1/assistant/conversations/{cid}").json()
    assert conv["messages"][-1]["role"] == "assistant" and conv["messages"][-1]["partial"] is True and conv["messages"][-1]["content"].startswith("جزء أول")
    spent, reserved, requests = usage_row(pg_owner, ACCOUNT_A)
    assert reserved == 0 and spent > 0 and requests == 1  # reservation fully settled; the stopped answer was still charged (conservatively)


# ── hard limits ──────────────────────────────────────────────────────────────────────────────────
def test_spend_is_recorded_exactly_and_reservation_released(env, fake, pg_owner):
    Caller().chat(uuid4(), "hi")
    spent, reserved, requests = usage_row(pg_owner, ACCOUNT_A)
    assert (spent, reserved, requests) == (21 * 1 + 9 * 5, 0, 1)  # m-small: $1/MTok in, $5/MTok out
    assert usage_row(pg_owner, ACCOUNT_A, "month")[0] == spent


def test_daily_budget_is_a_hard_stop_that_survives_restart(env, fake, monkeypatch, pg_owner):
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "0.006")   # 6000 micro-USD; worst-case reservation for one call is ~5100
    monkeypatch.setenv("AI_MONTHLY_BUDGET_USD", "0.006")
    cid = uuid4()
    assert Caller().chat(cid, "الأول")[0] == 200
    # the day is now nearly used up (real spend recorded in PostgreSQL): less than one worst-case reply remains
    pg_owner.execute("UPDATE ai_usage SET spent_micro = 5000 WHERE account_id=%s", (ACCOUNT_A,))
    spent, _, _ = usage_row(pg_owner, ACCOUNT_A)
    # 'Restart': the counter lives in PostgreSQL, so a fresh process sees the same spend.
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())
    n = len(fake.requests)
    status, err = Caller().chat(cid, "الثاني")
    assert status == 429 and err["detail"]["code"] in ("budget_daily", "budget_monthly")
    assert len(fake.requests) == n, "a refused request must never reach Anthropic"
    assert usage_row(pg_owner, ACCOUNT_A)[0] == spent
    # and the refused user turn is not left behind in the conversation
    assert [m["content"] for m in Caller().get(f"/internal/v1/assistant/conversations/{cid}").json()["messages"] if m["role"] == "user"] == ["الأول"]


def test_parallel_requests_cannot_jointly_exceed_the_cap(env, fake, monkeypatch, pg_owner):
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "0.011")   # room for two worst-case reservations, not three
    monkeypatch.setenv("AI_MONTHLY_BUDGET_USD", "0.011")
    fake.gate = threading.Event()
    fake.chunks = ["أ", "ب"]
    results: list[int] = []
    def one():
        results.append(Caller().chat(uuid4(), "x")[0])
    threads = [threading.Thread(target=one) for _ in range(6)]
    for t in threads: t.start()
    time.sleep(1.5)
    fake.gate.set()
    for t in threads: t.join(20)
    ok, denied = results.count(200), results.count(429)
    assert ok == 2 and denied == 4, results
    spent, reserved, _ = usage_row(pg_owner, ACCOUNT_A)
    assert reserved == 0 and spent <= 11_000


def test_monthly_budget_is_enforced_independently(env, fake, monkeypatch, pg_owner):
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "0.006")
    monkeypatch.setenv("AI_MONTHLY_BUDGET_USD", "0.006")
    pg_owner.execute("INSERT INTO ai_usage (account_id, period, spent_micro, requests) VALUES (%s, %s, 5000, 3)", (ACCOUNT_A, __import__("app.assistant.store", fromlist=["x"]).periods()[1]))
    status, err = Caller().chat(uuid4(), "x")
    assert status == 429 and err["detail"]["code"] == "budget_monthly" and fake.requests == []


def test_request_rate_limit_is_durable_and_per_account(env, fake, monkeypatch):
    monkeypatch.setenv("AI_REQUESTS_PER_MINUTE", "2")
    codes = [Caller().chat(uuid4(), "x")[0] for _ in range(3)]
    assert codes == [200, 200, 429] and len(fake.requests) == 2


def test_provider_failure_costs_nothing_and_returns_an_error_event(env, fake, pg_owner):
    fake.status = 500
    status, events = Caller().chat(uuid4(), "x")
    assert status == 200 and events[-1] == {"type": "error", "code": "provider_request_failed"}
    spent, reserved, _ = usage_row(pg_owner, ACCOUNT_A)
    assert spent == 0 and reserved == 0


def test_oversized_and_invalid_input_is_rejected_before_any_spend(env, fake):
    c = Caller()
    assert c.post("/internal/v1/assistant/chat", {"conversation_id": str(uuid4()), "message": "x" * 8001}).status_code == 422
    assert c.post("/internal/v1/assistant/chat", {"conversation_id": "nope", "message": "x"}).status_code == 422
    assert c.post("/internal/v1/assistant/chat", {"conversation_id": str(uuid4()), "message": "x", "model": "gpt-other"}).status_code == 422
    assert fake.requests == []


# ── models, settings, status ─────────────────────────────────────────────────────────────────────
def test_default_model_is_selectable_persisted_and_used(env, fake):
    c = Caller()
    st = c.get("/internal/v1/assistant/state").json()
    assert [m["id"] for m in st["models"]] == ["m-small", "m-big"] and st["default_model"] == "m-small"
    assert c.post("/internal/v1/assistant/settings", {"model": "m-big"}).json() == {"default_model": "m-big"}
    assert Caller().get("/internal/v1/assistant/state").json()["default_model"] == "m-big"
    Caller().chat(uuid4(), "x")
    assert fake.requests[-1]["model"] == "m-big"
    assert c.post("/internal/v1/assistant/settings", {"model": "not-in-catalogue"}).status_code == 422


def test_state_exposes_limits_and_usage_but_never_a_key(env, fake):
    Caller().chat(uuid4(), "x")
    raw = Caller().get("/internal/v1/assistant/state")
    st = raw.json()
    assert st["limits"] == {"daily_usd": 1.0, "monthly_usd": 5.0, "per_minute": 50}
    assert st["usage"]["day"]["requests"] == 1 and st["usage"]["day"]["spent_usd"] > 0
    assert KEY not in raw.text and "api_key" not in raw.text.lower()


def test_probe_reports_real_reachability_and_is_cached(env, fake):
    c = Caller()
    assert c.post("/internal/v1/assistant/probe", {}).json() == {"model": "m-small", "reachable": True, "cached": False}
    n = len(fake.headers)
    assert c.post("/internal/v1/assistant/probe", {}).json()["cached"] is True and len(fake.headers) == n
    assert fake.headers[0]["x-api-key"] == KEY and fake.headers[0]["path"] == "/v1/models/m-small"


def test_probe_reports_unreachable(env, fake):
    import app.internal as internal
    internal._probe_cache.clear()
    fake.probe_status = 401
    assert Caller().post("/internal/v1/assistant/probe", {}).json()["reachable"] is False
    internal._probe_cache.clear()
