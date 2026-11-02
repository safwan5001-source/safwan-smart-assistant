"""CHAT-BROWSER-2: interactive control through /internal/v1/browser/tasks/*/actions|finish.

What is proven here (the real Chromium behaviour is proven in services/browser/test/interactive.test.mjs and the e2e):
  * OFF unless BROWSER_INTERACTIVE_SCOPES holds a valid `host/prefix/` scope - for every new route, even for a validly signed call;
  * every action is rebuilt from a closed schema; no selector / script / extra field can be forwarded;
  * typed text is forwarded to the worker and appears NOWHERE else (response, audit trail, logs);
  * the worker's reply is re-validated field by field; an interactive job we did not authorize is refused;
  * conflicts and refusals from the worker map to fixed codes.
"""
import io
import json
import logging
import time

import pytest
from fastapi.testclient import TestClient

import app.browser_tasks as bt
import app.service_auth as sa
from app.audit import audit_log
from app.main import app
from app.service_auth import MemoryNonceStore, sign

SECRET = "unit-test-secret-0123456789abcdef-0123456789abcdef"
BROWSER_TOKEN = "w" * 40
WORKER = "http://safwan-browser.railway.internal:8080"
TASK = "11111111-1111-4111-8111-111111111111"
BASE = "/internal/v1/browser/tasks"
SCOPE = "lab.example.org/browser-lab/"
LAB = "https://lab.example.org/browser-lab/index.html"
CANARY = "TYPED-CANARY-9921-do-not-leak"
_n = iter(range(2_000_000, 3_000_000))


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_SECRET", SECRET)
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", BROWSER_TOKEN)
    monkeypatch.setenv("BROWSER_SERVICE_URL", WORKER)
    monkeypatch.setenv("BROWSER_CHAT_ENABLED", "1")
    monkeypatch.setenv("BROWSER_INTERACTIVE_SCOPES", SCOPE)
    for var in ("SERVICE_AUTH_SECRET_PREVIOUS", "APP_DATABASE_URL", "DATABASE_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())
    audit_log.clear()


@pytest.fixture
def client():
    return TestClient(app)


def signed(method, target, body=b""):
    ts, nonce = int(time.time()), f"n{next(_n):023d}"
    return {"x-svc-ts": str(ts), "x-svc-nonce": nonce, "x-svc-sig": sign(SECRET.encode(), method, target, ts, nonce, body)}


def call(client, method, target, payload=None, headers=None):
    body = json.dumps(payload).encode() if payload is not None else b""
    h = signed(method, target, body) if headers is None else headers
    if payload is not None:
        h = {**h, "content-type": "application/json"}
    return client.request(method, target, content=body or None, headers=h)


class Resp(io.BytesIO):
    def __init__(self, data, status=200):
        super().__init__(data if isinstance(data, bytes) else json.dumps(data).encode())
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def ijob(**over):
    base = {
        "id": TASK, "mode": "interactive", "status": "running", "url": LAB, "createdAt": 1_700_000_000_000, "ready": True,
        "steps": [{"id": s, "status": "pending"} for s in bt.INTERACTIVE_STEP_IDS], "sessionReleased": False,
        "limits": {"maxActions": 20, "deadlineMs": 300000, "idleMs": 45000, "approvalMs": 60000}, "deadlineAt": 1_700_000_300_000,
        "blockedRequests": 0, "actions": [], "result": {"title": "Lab", "url": LAB, "excerpt": "hello", "hasScreenshot": True, "version": 1},
    }
    return {**base, **over}


@pytest.fixture
def worker(monkeypatch):
    class W:
        calls: list = []
        reply = Resp({"job": ijob()}, 202)
    w = W()
    w.calls = []

    def fake(request, timeout):
        w.calls.append({"url": request.full_url, "method": request.get_method(), "body": request.data, "auth": request.get_header("Authorization")})
        r = w.reply
        if isinstance(r, Exception):
            raise r
        return r
    monkeypatch.setattr(bt, "_open", fake)
    return w


def last_body(w):
    return json.loads(w.calls[-1]["body"])


CLICK = {"tool": "click", "target": {"by": "role", "role": "button", "value": "Count"}}
ACTION_ROUTES = [("POST", f"{BASE}/{TASK}/actions", CLICK), ("POST", f"{BASE}/{TASK}/actions/1/approve", None),
                 ("POST", f"{BASE}/{TASK}/actions/1/reject", None), ("POST", f"{BASE}/{TASK}/finish", None)]


# ── off by default / authentication ──────────────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("method,target,payload", ACTION_ROUTES)
def test_unsigned_or_wrongly_credentialed_calls_never_reach_the_worker(client, worker, method, target, payload):
    assert call(client, method, target, payload, headers={}).status_code == 401
    assert call(client, method, target, payload, headers={"Authorization": f"Bearer {BROWSER_TOKEN}"}).status_code == 401
    bad = signed(method, target); bad["x-svc-sig"] = "0" * 64
    assert call(client, method, target, payload, headers=bad).status_code == 401
    assert worker.calls == []


@pytest.mark.parametrize("scopes", ["", "  ", " , ", "lab.example.org", "lab.example.org/", "10.0.0.1/a/", "127.0.0.1/a/", "x.railway.internal/a/", "localhost/a/",
                                    "lab.example.org:8443/a/", "https://lab.example.org/a/", "lab.example.org/../a/", "lab.example.org/%2e%2e/", "LAB.example.org/a/",
                                    f"{SCOPE},not valid"])
def test_interactive_is_off_without_a_valid_scope_for_every_route(client, worker, monkeypatch, scopes):
    monkeypatch.setenv("BROWSER_INTERACTIVE_SCOPES", scopes)
    r = call(client, "POST", BASE, {"url": LAB, "mode": "interactive"})
    assert r.status_code == 503 and r.json()["detail"] == {"code": "interactive_disabled"}
    for method, target, payload in ACTION_ROUTES:
        r = call(client, method, target, payload)
        assert r.status_code == 503 and r.json()["detail"] == {"code": "interactive_disabled"}, target
    assert worker.calls == []


def test_chat_flag_off_beats_a_configured_scope(client, worker, monkeypatch):
    monkeypatch.delenv("BROWSER_CHAT_ENABLED")
    assert call(client, "POST", BASE, {"url": LAB, "mode": "interactive"}).status_code == 503
    assert call(client, "POST", f"{BASE}/{TASK}/actions", CLICK).status_code == 503
    assert worker.calls == []


# ── starting a session ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_start_forwards_only_a_validated_url_and_the_mode(client, worker):
    r = call(client, "POST", BASE, {"url": LAB, "mode": "interactive"})
    assert r.status_code == 202 and r.json()["task"]["mode"] == "interactive"
    assert worker.calls[0]["method"] == "POST" and worker.calls[0]["url"] == WORKER + "/v1/jobs"
    assert last_body(worker) == {"url": LAB, "mode": "interactive"}
    # a look-only page is a legal START page; the worker still refuses to click there
    worker.reply = Resp({"job": ijob(url="https://example.com/", result=None)}, 202)
    assert call(client, "POST", BASE, {"url": "https://example.com/", "mode": "interactive"}).status_code == 202
    events = [e for e in audit_log.recent()]
    assert [e["event"] for e in events] == ["browser.session.start", "browser.session.start"]
    assert all(set(e) <= {"id", "ts", "event", "actor", "host", "task", "status"} for e in events)


@pytest.mark.parametrize("url", [
    "https://lab.example.org/", "https://lab.example.org/browser-lab", "https://lab.example.org/other/x.html", "https://lab.example.org/browser-lab/../admin",
    "https://lab.example.org/browser-lab/a?x=1", "https://lab.example.org/browser-lab/a#h", "http://lab.example.org/browser-lab/a", "https://lab.example.org:8443/browser-lab/a",
    "https://u:p@lab.example.org/browser-lab/a", "https://lab.example.org.evil.test/browser-lab/a", "https://evil.test/browser-lab/a", "https://evil.lab.example.org/browser-lab/a",
    "https://lab.example.org/browser-lab/a b", "https://lab.example.org/browser-lab/%2e%2e/x", "javascript:alert(1)", "https://169.254.169.254/browser-lab/", "https://example.com:443/",
    "https://example.com/?x", "", "https://lab.example.org/browser-lab/" + "a" * 130,
])
def test_start_url_must_be_inside_a_scope_or_the_look_only_host(client, worker, url):
    r = call(client, "POST", BASE, {"url": url, "mode": "interactive"})
    assert r.status_code in (400, 422), (url, r.status_code)
    assert worker.calls == []


def test_read_mode_is_unchanged_and_cannot_use_a_lab_url(client, worker):
    worker.reply = Resp({"job": {"id": TASK, "status": "running", "url": "https://example.com/", "steps": [{"id": s, "status": "pending"} for s in bt.STEP_IDS], "sessionReleased": False}}, 202)
    assert call(client, "POST", BASE, {"url": "https://example.com/"}).status_code == 202
    assert last_body(worker) == {"url": "https://example.com/"}
    assert call(client, "POST", BASE, {"url": LAB}).status_code == 400
    assert call(client, "POST", BASE, {"url": LAB, "mode": "root"}).status_code == 422


# ── actions: closed schema, rebuilt payload ──────────────────────────────────────────────────────────────────────────────────────────
def test_valid_actions_are_rebuilt_field_by_field(client, worker):
    cases = [
        ({"tool": "observe"}, {"tool": "observe"}),
        ({"tool": "navigate", "url": "https://lab.example.org/browser-lab/page2.html"}, {"tool": "navigate", "url": "https://lab.example.org/browser-lab/page2.html"}),
        (CLICK, {"tool": "click", "target": {"by": "role", "role": "button", "value": "Count", "exact": False}}),
        ({"tool": "click", "target": {"by": "label", "value": "  Name  ", "exact": True}}, {"tool": "click", "target": {"by": "label", "value": "Name", "exact": True}}),
        ({"tool": "type", "target": {"by": "placeholder", "value": "Query"}, "text": "مرحبا"}, {"tool": "type", "target": {"by": "placeholder", "value": "Query", "exact": False}, "text": "مرحبا"}),
    ]
    for payload, expected in cases:
        worker.reply = Resp({"job": ijob(actions=[{"seq": 1, "tool": "click", "status": "queued", "summary": "click button «Count»"}])}, 202)
        r = call(client, "POST", f"{BASE}/{TASK}/actions", payload)
        assert r.status_code == 202, (payload, r.text)
        assert last_body(worker) == expected
        assert worker.calls[-1]["url"] == f"{WORKER}/v1/jobs/{TASK}/actions"


BAD_ACTIONS = [
    {}, {"tool": "eval", "code": "1"}, {"tool": "press", "key": "Enter"}, {"tool": "observe", "url": "https://lab.example.org/browser-lab/"},
    {"tool": "navigate"}, {"tool": "navigate", "url": "https://lab.example.org/browser-lab/a", "text": "x"},
    {"tool": "click"}, {"tool": "click", "target": "button"}, {"tool": "click", "target": {"by": "css", "value": "#a"}}, {"tool": "click", "target": {"by": "xpath", "value": "//a"}},
    {"tool": "click", "target": {"by": "role", "value": "x"}}, {"tool": "click", "target": {"by": "role", "role": "script", "value": "x"}},
    {"tool": "click", "target": {"by": "label", "role": "button", "value": "x"}}, {"tool": "click", "target": {"by": "text", "value": ""}},
    {"tool": "click", "target": {"by": "text", "value": "   "}}, {"tool": "click", "target": {"by": "text", "value": "a" * 81}},
    {"tool": "click", "target": {"by": "text", "value": "a\nb"}}, {"tool": "click", "target": {"by": "text", "value": "a‮b"}},
    {"tool": "click", "target": {"by": "text", "value": "a​b"}}, {"tool": "click", "target": {"by": "text", "value": "x", "css": "a"}},
    {"tool": "click", "target": {"by": "text", "value": "x"}, "approved": True}, {"tool": "click", "target": {"by": "text", "value": "x"}, "text": "y"},
    {"tool": "type", "target": {"by": "label", "value": "x"}}, {"tool": "type", "text": "x"}, {"tool": "type", "target": {"by": "label", "value": "x"}, "text": "a" * 201},
    {"tool": "type", "target": {"by": "label", "value": "x"}, "text": "a\nb"}, {"tool": "type", "target": {"by": "label", "value": "x"}, "text": "a\u0000b"},
    {"tool": "type", "target": {"by": "label", "value": "x"}, "text": 5},
]


@pytest.mark.parametrize("payload", BAD_ACTIONS)
def test_malformed_or_dangerous_actions_never_reach_the_worker(client, worker, payload):
    assert call(client, "POST", f"{BASE}/{TASK}/actions", payload).status_code in (400, 422)
    assert worker.calls == []


@pytest.mark.parametrize("url", ["https://evil.test/", "https://lab.example.org/", "https://lab.example.org/browser-lab/../x", "https://lab.example.org/browser-lab/a?x=1",
                                 "http://lab.example.org/browser-lab/a", "javascript:alert(1)", "file:///etc/passwd"])
def test_navigate_target_is_checked_against_the_scope(client, worker, url):
    assert call(client, "POST", f"{BASE}/{TASK}/actions", {"tool": "navigate", "url": url}).status_code in (400, 422)
    assert worker.calls == []


def test_task_id_must_be_a_uuid_v4(client, worker):
    for tid in ("../x", "123", "11111111-1111-1111-1111-111111111111", "AAAAAAAA-1111-4111-8111-111111111111"):
        assert call(client, "POST", f"{BASE}/{tid}/actions", CLICK).status_code == 404
        assert call(client, "POST", f"{BASE}/{tid}/finish", {}).status_code == 404
    assert worker.calls == []


# ── typed text never leaks ───────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_typed_text_is_forwarded_and_appears_nowhere_else(client, worker, caplog):
    caplog.set_level(logging.DEBUG)
    worker.reply = Resp({"job": ijob(actions=[{"seq": 1, "tool": "type", "status": "queued", "summary": "type 28 chars into label «Name»"}])}, 202)
    r = call(client, "POST", f"{BASE}/{TASK}/actions", {"tool": "type", "target": {"by": "label", "value": "Name"}, "text": CANARY})
    assert r.status_code == 202
    assert last_body(worker)["text"] == CANARY, "the worker does need the text"
    assert CANARY not in r.text
    assert CANARY not in json.dumps(audit_log.recent(), default=str)
    assert CANARY not in caplog.text
    ev = audit_log.recent()[0]
    assert ev["event"] == "browser.action.queued" and ev["tool"] == "type" and ev["seq"] == 1 and "text" not in ev and "target" not in ev


def test_worker_failures_do_not_echo_the_text_either(client, worker, caplog):
    caplog.set_level(logging.DEBUG)
    worker.reply = Resp(b"x" * 200_000, 202)  # oversized
    r = call(client, "POST", f"{BASE}/{TASK}/actions", {"tool": "type", "target": {"by": "label", "value": "Name"}, "text": CANARY})
    assert r.status_code == 502 and CANARY not in r.text and CANARY not in caplog.text and CANARY not in json.dumps(audit_log.recent(), default=str)


# ── approvals ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_approve_and_reject_refer_to_a_step_and_carry_no_payload(client, worker):
    pending = {"seq": 1, "kind": "submit", "summary": "click button «Send form»", "expiresAt": 1_700_000_060_000, "submitsTo": "https://lab.example.org/browser-lab/submit"}
    worker.reply = Resp({"job": ijob(actions=[{"seq": 1, "tool": "click", "status": "awaiting_approval", "summary": "click button «Send form»"}], pending=pending)}, 200)
    r = call(client, "POST", f"{BASE}/{TASK}/actions/1/approve", {})
    assert r.status_code == 200 and r.json()["task"]["pending"] == pending
    assert worker.calls[-1]["url"] == f"{WORKER}/v1/jobs/{TASK}/actions/1/approve" and last_body(worker) == {}
    worker.reply = Resp({"job": ijob()}, 200)
    assert call(client, "POST", f"{BASE}/{TASK}/actions/1/reject", {}).status_code == 200
    assert worker.calls[-1]["url"] == f"{WORKER}/v1/jobs/{TASK}/actions/1/reject"
    assert [e["event"] for e in audit_log.recent()][::-1] == ["browser.action.approve", "browser.action.reject"]
    assert all(e["task"] == TASK and e["seq"] == 1 for e in audit_log.recent())


def test_pending_method_and_the_new_outcome_codes_pass_and_anything_else_is_refused(client, worker):
    pend = {"seq": 1, "kind": "submit", "summary": "x", "method": "POST", "submitsTo": "https://lab.example.org/browser-lab/submit"}
    acts = [{"seq": 1, "tool": "click", "status": "denied", "summary": "x", "error": "effect_blocked"}]
    t = view(client, worker, ijob(actions=acts + [{"seq": 2, "tool": "click", "status": "awaiting_approval", "summary": "y"}], pending={**pend, "seq": 2})).json()["task"]
    assert t["pending"]["method"] == "POST" and t["actions"][0]["error"] == "effect_blocked"
    for code in ("element_unstable", "unsupported_target"):
        assert view(client, worker, ijob(actions=[{**acts[0], "error": code}])).json()["task"]["actions"][0]["error"] == code
    assert view(client, worker, ijob(actions=acts + [{"seq": 2, "tool": "click", "status": "awaiting_approval", "summary": "y"}], pending={**pend, "seq": 2, "method": "DELETE"})).status_code == 502


def test_form_fields_of_a_pending_submit_are_passed_on_cleaned_and_bounded(client, worker):
    pend = {"seq": 1, "kind": "submit", "summary": "x", "method": "POST", "element": {"tag": "my-button", "text": "Send"},
            "fields": [{"name": "amount", "value": "10"}, {"name": "pin", "value": "••••"}, {"name": "n\u202e", "value": "v\x00", "extra": 1}]}
    acts = [{"seq": 1, "tool": "click", "status": "awaiting_approval", "summary": "x"}]
    t = view(client, worker, ijob(actions=acts, pending=pend)).json()["task"]
    assert t["pending"]["fields"] == [{"name": "amount", "value": "10"}, {"name": "pin", "value": "••••"}, {"name": "n", "value": "v"}]
    assert t["pending"]["element"]["tag"] == "my-button"
    for bad in ([{"name": "a", "value": "b"}] * 14, "x", ["x"]):
        assert view(client, worker, ijob(actions=acts, pending={**pend, "fields": bad})).status_code == 502
    for code in ("unsupported_enctype", "payload_too_large"):
        assert view(client, worker, ijob(actions=[{"seq": 1, "tool": "click", "status": "denied", "summary": "x", "error": code}])).json()["task"]["actions"][0]["error"] == code


def test_the_resolved_element_in_a_pending_approval_is_passed_on_cleaned(client, worker):
    pend = {"seq": 1, "kind": "button", "summary": "x", "element": {"tag": "button", "role": "switch", "text": "Share\u202e my profile", "html": "<b>", "x": 1}}
    worker.reply = Resp({"job": ijob(actions=[{"seq": 1, "tool": "click", "status": "awaiting_approval", "summary": "x"}], pending=pend)}, 200)
    t = call(client, "GET", f"{BASE}/{TASK}").json()["task"]
    assert t["pending"]["element"] == {"tag": "button", "text": "Share my profile", "role": "switch"}
    for bad in ({"tag": "BUTTON<script>", "text": "x"}, "button", {"text": "no tag"}):
        worker.reply = Resp({"job": ijob(actions=[{"seq": 1, "tool": "click", "status": "awaiting_approval", "summary": "x"}], pending={**pend, "element": bad})}, 200)
        assert call(client, "GET", f"{BASE}/{TASK}").status_code == 502


@pytest.mark.parametrize("seq", ["0", "21", "999", "-1", "x", "1.5", "01x"])
def test_step_numbers_are_bounded(client, worker, seq):
    r = call(client, "POST", f"{BASE}/{TASK}/actions/{seq}/approve", {})
    assert r.status_code in (404, 422) and worker.calls == []


def test_finish_ends_the_session_and_is_audited(client, worker):
    worker.reply = Resp({"job": ijob(status="running")}, 200)
    r = call(client, "POST", f"{BASE}/{TASK}/finish", {})
    assert r.status_code == 200 and worker.calls[-1]["url"] == f"{WORKER}/v1/jobs/{TASK}/finish"
    assert audit_log.recent()[0]["event"] == "browser.session.finish"


# ── worker answers -> fixed codes ────────────────────────────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("status,body,expected_status,code", [
    (409, {"error": "action_in_progress"}, 409, "action_in_progress"), (409, {"error": "limit_reached"}, 409, "limit_reached"), (409, {"error": "not_ready"}, 409, "not_ready"),
    (409, {"error": "session_ended"}, 409, "session_ended"), (409, {"error": "no_pending_approval"}, 409, "no_pending_approval"),
    (409, {"error": "not_interactive"}, 409, "not_interactive"), (409, {"error": "<script>alert(1)</script>"}, 409, "conflict"), (409, {}, 409, "conflict"),
    (404, {"error": "not_found"}, 404, "not_found"), (429, {"error": "busy"}, 409, "busy"), (400, {"error": "url_not_allowed"}, 400, "url_not_allowed"),
    (400, {"error": "invalid_action"}, 400, "invalid_request"), (403, {"error": "interactive_disabled"}, 503, "interactive_disabled"),
])
def test_worker_refusals_map_to_fixed_codes(client, worker, status, body, expected_status, code):
    worker.reply = Resp(body, status)
    r = call(client, "POST", f"{BASE}/{TASK}/actions", CLICK)
    assert r.status_code == expected_status and r.json()["detail"] == {"code": code}


def test_worker_401_is_a_generic_502_not_a_leak(client, worker):
    worker.reply = Resp({"error": "unauthorized"}, 401)
    r = call(client, "POST", f"{BASE}/{TASK}/actions", CLICK)
    assert r.status_code == 502 and r.json()["detail"] == {"code": "browser_unavailable"}


# ── response sanitising ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
def actions(n=2, **over):
    base = [{"seq": i, "tool": "click", "status": "done", "summary": f"step {i}"} for i in range(1, n + 1)]
    return [{**a, **over} if i == 0 else a for i, a in enumerate(base)]


def view(client, worker, job):
    worker.reply = Resp({"job": job}, 200)
    return call(client, "GET", f"{BASE}/{TASK}")


def test_a_valid_interactive_view_passes_and_unknown_fields_are_dropped(client, worker):
    j = ijob(actions=actions(2), sessionToken="SECRET", connectUrl="wss://x/?signingKey=S", endReason="idle", status="succeeded", finishedAt=1_700_000_100_000,
             result={"title": "T‮", "url": LAB, "excerpt": "e\x00x", "hasScreenshot": True, "version": 3, "html": "<script>"})
    t = view(client, worker, j).json()["task"]
    assert t["mode"] == "interactive" and t["endReason"] == "idle" and t["result"]["version"] == 3 and len(t["actions"]) == 2
    assert t["result"] == {"title": "T", "url": LAB, "excerpt": "ex", "hasScreenshot": True, "version": 3}
    text = json.dumps(t)
    assert "SECRET" not in text and "signingKey" not in text and "<script>" not in text


@pytest.mark.parametrize("mutate", [
    lambda j: j.update(steps=[{"id": s, "status": "pending"} for s in bt.STEP_IDS]),                       # read-mode steps on an interactive job
    lambda j: j.update(mode="admin"),
    lambda j: j.update(url="https://evil.test/"),
    lambda j: j.update(url="https://lab.example.org/other/x"),
    lambda j: j.update(limits={"maxActions": 99, "deadlineMs": 1, "idleMs": 1, "approvalMs": 1}),
    lambda j: j.update(limits=None),
    lambda j: j.update(actions=actions(21)),
    lambda j: j.update(actions=[{"seq": 2, "tool": "click", "status": "done", "summary": "x"}]),            # seq must be 1..n in order
    lambda j: j.update(actions=[{"seq": 1, "tool": "eval", "status": "done", "summary": "x"}]),
    lambda j: j.update(actions=[{"seq": 1, "tool": "click", "status": "weird", "summary": "x"}]),
    lambda j: j.update(actions="all"),
    lambda j: j.update(pending={"seq": 1, "kind": "payment", "summary": "x"}),
    lambda j: j.update(pending={"seq": 0, "kind": "button", "summary": "x"}),
    lambda j: j.update(pending={"seq": 1, "kind": "submit", "summary": "x", "submitsTo": "https://evil.test/collect"}),
    lambda j: j["result"].update(url="https://evil.test/x"),
])
def test_an_unexpected_interactive_view_is_a_generic_502(client, worker, mutate):
    j = ijob(actions=actions(1)); mutate(j)
    r = view(client, worker, j)
    assert r.status_code == 502 and r.json()["detail"] == {"code": "browser_unavailable"}


def test_an_interactive_job_is_refused_when_we_never_authorized_interactive_control(client, worker, monkeypatch):
    monkeypatch.setenv("BROWSER_INTERACTIVE_SCOPES", "")
    assert view(client, worker, ijob(url="https://example.com/", result=None)).status_code == 502


def test_the_largest_legal_interactive_view_fits_the_bridge_limit(client, worker):
    cjk = "漢" * 80
    acts = [{"seq": i, "tool": "click", "status": "failed", "summary": "نقر على زر «" + cjk + "»" + "漢" * 200, "error": "element_not_found"} for i in range(1, 21)]
    big = ijob(actions=acts, result={"title": "漢" * 200, "url": LAB, "excerpt": "漢" * 4000, "hasScreenshot": True, "version": 9})
    body = json.dumps({"job": big}, ensure_ascii=False).encode()
    assert len(body) > 16_384, "this is the case the old limit broke"
    worker.reply = Resp(body, 200)
    r = call(client, "GET", f"{BASE}/{TASK}")
    assert r.status_code == 200 and len(r.json()["task"]["actions"]) == 20


def test_unknown_error_codes_collapse_to_fixed_vocabulary(client, worker):
    t = view(client, worker, ijob(actions=actions(1, status="failed", error="Traceback: /srv/secret/app.py"))).json()["task"]
    assert t["actions"][0]["error"] == "action_failed"
    t = view(client, worker, ijob(actions=actions(1, status="denied", error="sensitive_field"))).json()["task"]
    assert t["actions"][0] == {"seq": 1, "tool": "click", "status": "denied", "summary": "step 1", "error": "sensitive_field"}
    t = view(client, worker, ijob(status="failed", error="stack trace here")).json()["task"]
    assert t["error"] == "browser_execution_failed"
