"""BASHT B3/B4: approvals (allow-once / deny only, audited) and the live event feed, through the engine's app bridge."""
import io
import json
import time
from urllib.error import HTTPError, URLError

import pytest
from fastapi.testclient import TestClient

import app.service_auth as sa
from app import basht_chat as bc
from app import basht_live as bl
from app.audit import audit_log
from app.main import app
from app.service_auth import MemoryNonceStore, sign

SECRET = "unit-test-secret-0123456789abcdef-0123456789abcdef"
TOKEN = "app-token-0123456789abcdef0123456789abcd"
URL = "https://engine.example"
AID = "2f075550-246c-4742-97d7-5268e18d63d2"
APPROVAL = {"id": AID, "kind": "exec", "summary": "echo hello", "title": None, "host": "gateway", "agentId": "main", "session": "app",
            "isApp": True, "warning": None, "createdAt": 1000, "expiresAt": 1800000, "decisions": ["allow-once", "deny"],
            "cwd": "/data/workspace", "sessionKey": "agent:main:app:owner"}
LINK = {"state": "up", "since": 1, "lastUpAt": 1, "reconnects": 0, "lastError": None, "pendingApprovals": 1}


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_SECRET", SECRET)
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    monkeypatch.setenv("BASHT_CORE_URL", URL)
    monkeypatch.setenv("BASHT_APP_TOKEN", TOKEN)
    for var in ("SERVICE_AUTH_SECRET_PREVIOUS", "APP_DATABASE_URL", "DATABASE_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())
    bl.reset_limits()
    audit_log.clear()


class _Res(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _http_error(status, body):
    return HTTPError(URL, status, "x", {}, io.BytesIO(json.dumps(body).encode()))


@pytest.fixture
def engine(monkeypatch):
    calls, replies = [], {}

    def fake(req, timeout):
        calls.append({"url": req.full_url, "method": req.get_method(), "auth": req.get_header("Authorization"),
                      "body": json.loads(req.data) if req.data else None, "timeout": timeout})
        path = req.full_url.removeprefix(URL + "/app/v1")
        for prefix, r in replies.items():
            if path.startswith(prefix):
                if callable(r):
                    r = r()
                if isinstance(r, Exception):
                    raise r
                return _Res(json.dumps(r).encode())
        raise AssertionError(f"unexpected engine call {path}")

    monkeypatch.setattr(bc, "urlopen", fake)
    return calls, replies


def call(client, method, target, body=None):
    raw = json.dumps(body).encode() if body is not None else b""
    ts, nonce = int(time.time()), f"nonce{time.monotonic_ns():020d}"[-24:]
    h = {"x-svc-ts": str(ts), "x-svc-nonce": nonce, "x-svc-sig": sign(SECRET.encode(), method, target, ts, nonce, raw)}
    if body is not None:
        h["content-type"] = "application/json"
    return client.request(method, target, content=raw or None, headers=h)


@pytest.fixture
def client():
    return TestClient(app)


def test_unsigned_calls_never_reach_the_engine(client, engine):
    calls, _ = engine
    assert client.get("/internal/v1/basht/approvals").status_code == 401
    assert client.post("/internal/v1/basht/approvals/decide", json={"id": AID, "decision": "allow-once"}).status_code == 401
    assert client.post("/internal/v1/basht/events", json={"after": 0}).status_code == 401
    assert calls == []


def test_pending_approvals_are_shaped_and_link_down_is_a_state(client, engine):
    calls, replies = engine
    replies["/approvals"] = {"ok": True, "approvals": [APPROVAL, {"id": "bad id"}, {**APPROVAL, "id": "plugin:abcdef12", "kind": "weird"}],
                             "partial": False, "link": LINK}
    r = call(client, "GET", "/internal/v1/basht/approvals")
    assert r.status_code == 200
    j = r.json()
    assert j["available"] is True and j["link"]["state"] == "up"
    assert j["approvals"] == [{"id": AID, "kind": "exec", "summary": "echo hello", "title": None, "host": "gateway", "agent_id": "main",
                               "session": "app", "is_app": True, "warning": None, "created_at": 1000, "expires_at": 1800000,
                               "decisions": ["allow-once", "deny"]}]
    assert "/data" not in r.text and "agent:main" not in r.text and TOKEN not in r.text
    assert calls[0]["url"] == URL + "/app/v1/approvals" and calls[0]["auth"] == f"Bearer {TOKEN}"
    replies["/approvals"] = _http_error(503, {"ok": False, "error": "link_down", "link": {"state": "down"}})
    down = call(client, "GET", "/internal/v1/basht/approvals")
    assert down.status_code == 200 and down.json()["available"] is False and down.json()["approvals"] == []
    replies["/approvals"] = URLError("refused")
    assert call(client, "GET", "/internal/v1/basht/approvals").status_code == 502


def test_decide_allows_once_or_denies_only_and_audits_without_the_command(client, engine):
    calls, replies = engine
    replies[f"/approvals/{AID}"] = {"ok": True, "applied": True, "approval": {"id": AID, "kind": "exec", "summary": "echo hello", "status": "allowed",
                                                                               "decision": "allow-once", "by": "app", "session": "app"}}
    for bad in ("allow-always", "allow", "yes", "ALLOW-ONCE"):
        r = call(client, "POST", "/internal/v1/basht/approvals/decide", {"id": AID, "decision": bad})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "bad_decision", bad
    for bad_id in ("short", "../../../etc", "a b c d e f g h", "x" * 129):
        r = call(client, "POST", "/internal/v1/basht/approvals/decide", {"id": bad_id, "decision": "deny"})
        assert r.status_code in (400, 422), bad_id
    assert calls == [], "nothing reached the engine"
    r = call(client, "POST", "/internal/v1/basht/approvals/decide", {"id": AID, "decision": "allow-once"})
    assert r.status_code == 200 and r.json()["applied"] is True and r.json()["approval"]["decision"] == "allow-once"
    assert calls[-1]["url"] == f"{URL}/app/v1/approvals/{AID}" and calls[-1]["method"] == "POST" and calls[-1]["body"] == {"decision": "allow-once"}
    rec = [e for e in audit_log.recent(20) if e["event"] == "basht.approval"]
    assert rec[0]["approval_id"] == AID and rec[0]["decision"] == "allow-once" and rec[0]["kind"] == "exec" and rec[0]["status"] == "applied"
    assert "echo hello" not in json.dumps(audit_log.recent(50)), "the command never enters the audit"
    assert any(e["status"] == "bad_decision" for e in rec)


def test_decide_maps_engine_answers_to_codes(client, engine):
    _, replies = engine
    path = f"/approvals/{AID}"
    replies[path] = {"ok": True, "applied": False, "approval": {"id": AID, "kind": "exec", "status": "denied", "decision": "deny"}}
    r = call(client, "POST", "/internal/v1/basht/approvals/decide", {"id": AID, "decision": "allow-once"})
    assert r.status_code == 200 and r.json()["applied"] is False and r.json()["approval"]["decision"] == "deny"
    assert audit_log.recent(1)[0]["status"] == "already_answered"
    for status, body, code in ((503, {"error": "link_down"}, "link_down"), (404, {"error": "not_found"}, "not_found"),
                               (400, {"error": "rejected"}, "rejected"), (400, {"error": "free text from upstream"}, None)):
        replies[path] = _http_error(status, body)
        r = call(client, "POST", "/internal/v1/basht/approvals/decide", {"id": AID, "decision": "deny"})
        if code:
            assert r.status_code == 400 and r.json()["detail"]["code"] == code
        else:
            assert r.status_code == 502 and "upstream" not in r.text
        assert audit_log.recent(1)[0]["event"] == "basht.approval"


def test_decisions_are_rate_limited(client, engine):
    _, replies = engine
    replies[f"/approvals/{AID}"] = {"ok": True, "applied": False, "approval": None}
    codes = [call(client, "POST", "/internal/v1/basht/approvals/decide", {"id": AID, "decision": "deny"}).status_code for _ in range(bl.DECIDE_PER_MINUTE + 2)]
    assert codes[: bl.DECIDE_PER_MINUTE] == [200] * bl.DECIDE_PER_MINUTE and codes[-1] == 429


def test_history_is_shaped(client, engine):
    calls, replies = engine
    replies["/approvals/history"] = {"ok": True, "items": [{"id": AID, "kind": "exec", "summary": "echo", "status": "denied", "decision": "deny",
                                                            "reason": "user", "session": "app", "by": "app", "createdAt": 1, "resolvedAt": 2, "urlPath": "/approve/x"}]}
    r = call(client, "POST", "/internal/v1/basht/approvals/history", {"limit": 5})
    assert r.status_code == 200 and r.json()["items"][0]["decision"] == "deny" and "urlPath" not in r.text and "url_path" not in r.text
    assert calls[-1]["url"] == URL + "/app/v1/approvals/history?limit=5"
    assert call(client, "POST", "/internal/v1/basht/approvals/history", {"limit": 500}).status_code == 422


def test_events_feed_is_re_checked_field_by_field(client, engine):
    calls, replies = engine
    replies["/events"] = {"ok": True, "epoch": "24fd106d565a", "latest": 12, "truncated": False, "link": LINK, "events": [
        {"id": 5, "at": 1, "type": "gateway.up", "downForMs": 3000},
        {"id": 6, "at": 2, "type": "approval.requested", "approval": APPROVAL},
        {"id": 7, "at": 3, "type": "approval.resolved", "approvalId": AID, "kind": "exec", "decision": "deny", "session": "app"},
        {"id": 8, "at": 4, "type": "chat.final", "session": "app", "runId": "r", "seen": False, "text": "secret reply"},
        {"id": 9, "at": 5, "type": "cron.failed", "jobId": "j", "name": "Daily brief", "status": "error", "error": "/data/x"},
        {"id": 10, "at": 6, "type": "shell.exec", "command": "rm"},
        {"id": "11", "type": "gateway.down"},
        {"id": 12, "at": 7, "type": "approval.requested", "approval": {"id": "nope"}},
    ]}
    r = call(client, "POST", "/internal/v1/basht/events", {"after": 4})
    assert r.status_code == 200
    j = r.json()
    assert [e["id"] for e in j["events"]] == [5, 6, 7, 8, 9]
    assert j["events"][0] == {"id": 5, "type": "gateway.up", "at": 1, "down_for_ms": 3000}
    assert j["events"][3] == {"id": 8, "type": "chat.final", "at": 4, "session": "app", "seen": False}
    assert j["events"][4] == {"id": 9, "type": "cron.failed", "at": 5, "job_id": "j", "name": "Daily brief", "status": "error"}
    assert j["epoch"] == "24fd106d565a" and j["latest"] == 12 and j["available"] is True
    assert "secret reply" not in r.text and "/data" not in r.text and "rm" not in [e.get("command") for e in j["events"]]
    assert calls[-1]["url"] == URL + "/app/v1/events?after=4" and calls[-1]["timeout"] == bl.EVENTS_TIMEOUT
    call(client, "POST", "/internal/v1/basht/events", {"after": 4, "wait": 20})
    assert calls[-1]["url"] == URL + "/app/v1/events?after=4&wait=20"
    assert call(client, "POST", "/internal/v1/basht/events", {"after": -1}).status_code == 422
    assert call(client, "POST", "/internal/v1/basht/events", {"wait": 60}).status_code == 422
    replies["/events"] = URLError("down")
    assert call(client, "POST", "/internal/v1/basht/events", {"after": 0}).status_code == 502
    replies["/events"] = _http_error(503, {"error": "not_available"})
    assert call(client, "POST", "/internal/v1/basht/events", {"after": 0}).json()["available"] is False
    # Review (Codex, integration PR): an older bridge without /events (404) is "no feed", never an outage (no false offline push)
    replies["/events"] = _http_error(404, {"ok": False, "error": "not_found"})
    r = call(client, "POST", "/internal/v1/basht/events", {"after": 0})
    assert r.status_code == 200 and r.json()["available"] is False and r.json()["configured"] is True


def test_events_answer_says_how_far_it_reached_so_the_caller_can_page(client, engine):
    """Codex (PR #62): a capped answer must not let the caller jump to `latest` past records it never saw."""
    _, replies = engine
    many = [{"id": i, "at": 1, "type": "cron.failed", "jobId": "j", "name": "n", "status": "error"} for i in range(1, 251)]
    replies["/events"] = {"ok": True, "epoch": "24fd106d565a", "latest": 300, "events": many, "link": LINK}
    j = call(client, "POST", "/internal/v1/basht/events", {"after": 0}).json()
    assert len(j["events"]) == bl.MAX_EVENTS and j["events"][-1]["id"] == 200
    assert j["next_after"] == 200 and j["more"] is True and j["latest"] == 300
    # records dropped as malformed still move the cursor (no endless re-reading), and the last page says "no more"
    replies["/events"] = {"ok": True, "epoch": "24fd106d565a", "latest": 300, "events": [{"id": 299, "type": "cron.failed", "at": 1}, {"id": 300, "type": "bogus"}], "link": LINK}
    j = call(client, "POST", "/internal/v1/basht/events", {"after": 298}).json()
    assert [e["id"] for e in j["events"]] == [299] and j["next_after"] == 300 and j["more"] is False
    replies["/events"] = {"ok": True, "epoch": "24fd106d565a", "latest": 300, "events": [], "link": LINK}
    j = call(client, "POST", "/internal/v1/basht/events", {"after": 300}).json()
    assert j["next_after"] == 300 and j["more"] is False


def test_events_answer_is_bounded_in_bytes_and_pages_the_rest(client, engine):
    """Codex (PR #62): 200 long approval events must not exceed the web's response cap; the rest comes on the next page."""
    _, replies = engine
    long = dict(APPROVAL, summary="أ" * 300, title="ب" * 120, warning="ت" * 200)
    many = [{"id": i, "at": 1, "type": "approval.requested", "approval": dict(long, id=f"{AID[:-4]}{i:04d}")} for i in range(1, 201)]
    replies["/events"] = {"ok": True, "epoch": "24fd106d565a", "latest": 200, "events": many, "link": LINK}
    r = call(client, "POST", "/internal/v1/basht/events", {"after": 0})
    j = r.json()
    assert len(r.content) < 512 * 1024
    assert 0 < len(j["events"]) < 200 and j["more"] is True
    assert j["next_after"] == j["events"][-1]["id"]  # the cursor stops at the last record actually returned


def test_unconfigured_engine_is_503(client, engine, monkeypatch):
    monkeypatch.delenv("BASHT_APP_TOKEN")
    assert call(client, "GET", "/internal/v1/basht/approvals").status_code == 503
    r = call(client, "POST", "/internal/v1/basht/events", {"after": 0})
    assert r.status_code == 200 and r.json()["available"] is False and r.json()["configured"] is False
