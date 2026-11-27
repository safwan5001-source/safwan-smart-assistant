"""B5–B7: BASHT's scheduled tasks, usage, memory (read-only) and capabilities through the engine's app bridge."""
import io
import json
import time
from urllib.error import HTTPError, URLError

import pytest
from fastapi.testclient import TestClient

import app.service_auth as sa
from app import basht_chat as bc
from app.audit import audit_log
from app.main import app
from app.service_auth import MemoryNonceStore, sign

SECRET = "unit-test-secret-0123456789abcdef-0123456789abcdef"
TOKEN = "app-token-0123456789abcdef0123456789abcd"
URL = "https://engine.example"
JOB = "e1e667e6-3167-4e9e-82e6-eeeda67c9afc"
REF = "0123456789abcdef01234567"


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_SECRET", SECRET)
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    monkeypatch.setenv("BASHT_CORE_URL", URL)
    monkeypatch.setenv("BASHT_APP_TOKEN", TOKEN)
    for var in ("SERVICE_AUTH_SECRET_PREVIOUS", "APP_DATABASE_URL", "DATABASE_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())
    audit_log.clear()


class _Res(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _http(code, body):
    return HTTPError(URL, code, "x", {}, io.BytesIO(json.dumps(body).encode()))


@pytest.fixture
def engine(monkeypatch):
    calls, replies = [], {}

    def fake(req, timeout):
        calls.append({"path": req.full_url.removeprefix(URL + "/app/v1"), "method": req.get_method(), "auth": req.get_header("Authorization"),
                      "body": json.loads(req.data) if req.data else None, "timeout": timeout})
        path = calls[-1]["path"]
        for prefix, r in replies.items():
            if path.startswith(prefix):
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


JOBS = {"ok": True, "fetchedAt": 5, "truncated": False, "jobs": [
    {"id": JOB, "name": "متابعة الفواتير", "enabled": True, "system": False, "kind": "agent", "prompt": "راجع الفواتير", "payload": {"x": 1},
     "schedule": {"kind": "every", "everyMs": 21600000}, "nextRunAt": 2000, "running": False, "sessionKey": "agent:main:cron:x",
     "last": {"at": 1000, "status": "error", "durationMs": 11153, "delivery": "not-delivered", "error": "open /data/x.sqlite failed"}, "consecutiveErrors": 2},
    {"id": "sys-1", "name": "Memory Dreaming", "enabled": True, "system": True, "kind": "agent", "schedule": {"kind": "cron", "expr": "0 3 * * *", "tz": None}, "last": None},
    {"id": "../evil", "name": "x"},
]}


def test_unsigned_calls_never_reach_the_engine(client, engine):
    calls, _ = engine
    for m, p in [("GET", "/internal/v1/basht/automations"), ("POST", f"/internal/v1/basht/automations/{JOB}/run"), ("GET", "/internal/v1/basht/usage"),
                 ("POST", "/internal/v1/basht/memory/search"), ("GET", "/internal/v1/basht/capabilities")]:
        assert client.request(m, p).status_code == 401
    assert calls == []


def test_automations_fixed_shape_and_trimmed(client, engine):
    calls, replies = engine
    replies["/automations"] = JOBS
    r = call(client, "GET", "/internal/v1/basht/automations")
    assert r.status_code == 200
    j = r.json()
    assert [x["id"] for x in j["jobs"]] == [JOB, "sys-1"]
    own = j["jobs"][0]
    assert set(own) == {"id", "name", "enabled", "system", "kind", "prompt", "schedule", "next_run_at", "running", "last", "consecutive_errors", "auto_disabled"}
    assert own["schedule"] == {"kind": "every", "every_ms": 21600000}
    assert own["last"]["error"] == "open … failed"
    assert "/data/" not in r.text and "sessionKey" not in r.text and "payload" not in r.text
    assert calls[0]["auth"] == f"Bearer {TOKEN}"


def test_older_engine_reads_as_control_unavailable(client, engine):
    _, replies = engine
    replies["/automations"] = _http(404, {"ok": False, "error": "not_found"})
    replies["/capabilities"] = _http(503, {"ok": False, "error": "not_available"})
    for p in ("/internal/v1/basht/automations", "/internal/v1/basht/capabilities"):
        r = call(client, "GET", p)
        assert r.status_code == 400 and r.json()["detail"]["code"] == "control_unavailable"
    replies["/usage"] = URLError("down")
    r = call(client, "GET", "/internal/v1/basht/usage")
    assert r.status_code == 502 and r.json()["detail"]["code"] == "basht_unavailable"


def test_runs_validate_the_job_id_and_trim_summaries(client, engine):
    calls, replies = engine
    assert call(client, "GET", "/internal/v1/basht/automations/..%2Fx/runs").status_code == 404
    replies[f"/automations/{JOB}/runs"] = {"ok": True, "runs": [
        {"at": 19, "status": "ok", "completion": "succeeded", "durationMs": 1855, "quiet": True, "summary": None, "delivery": "not-requested"},
        {"at": 9, "status": "error", "summary": "سطر\nفيه /tmp/a/b", "error": "x" * 900, "sessionKey": "k"},
        {"status": "ok"}]}
    j = call(client, "GET", f"/internal/v1/basht/automations/{JOB}/runs").json()
    assert [r["at"] for r in j["runs"]] == [19, 9]
    assert j["runs"][0]["quiet"] is True
    assert j["runs"][1]["summary"] == "سطر\nفيه …" and len(j["runs"][1]["error"]) == 200
    assert calls[-1]["path"] == f"/automations/{JOB}/runs?limit=10"
    replies[f"/automations/{JOB}/runs"] = _http(404, {"ok": False, "error": "not_found"})
    r = call(client, "GET", f"/internal/v1/basht/automations/{JOB}/runs")
    assert r.status_code == 404 and r.json()["detail"]["code"] == "not_found"


def test_run_now_and_enable_are_audited_and_pass_refusals(client, engine):
    calls, replies = engine
    replies[f"/automations/{JOB}/run"] = {"ok": True, "id": JOB, "enqueued": True}
    r = call(client, "POST", f"/internal/v1/basht/automations/{JOB}/run", {})
    assert r.json() == {"id": JOB, "enqueued": True}
    assert calls[-1]["body"] == {} and calls[-1]["method"] == "POST"
    replies[f"/automations/{JOB}/enabled"] = {"ok": True, "id": JOB, "enabled": False}
    r = call(client, "POST", f"/internal/v1/basht/automations/{JOB}/enabled", {"enabled": False})
    assert r.json() == {"id": JOB, "enabled": False}
    assert calls[-1]["body"] == {"enabled": False}
    assert call(client, "POST", f"/internal/v1/basht/automations/{JOB}/enabled", {"enabled": "no"}).status_code == 422
    replies["/automations/sys-1/run"] = _http(400, {"ok": False, "error": "system_job"})
    r = call(client, "POST", "/internal/v1/basht/automations/sys-1/run", {})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "system_job"
    replies["/automations/sys-2/run"] = _http(400, {"ok": False, "error": "something /secret/path"})
    assert call(client, "POST", "/internal/v1/basht/automations/sys-2/run", {}).json()["detail"]["code"] == "bad_request"
    events = [e for e in audit_log.recent(10) if e["event"] == "basht.automation"]
    assert [(e["action"], e["job_id"], e["status"]) for e in events[::-1]] == [
        ("run", JOB, "ok"), ("disable", JOB, "ok"), ("run", "sys-1", "system_job"), ("run", "sys-2", "bad_request")]


def test_usage_shape_and_unknown_cost(client, engine):
    _, replies = engine
    replies["/usage"] = {"ok": True, "app": {"tokens": 10953, "input": 9540, "output": 1413, "cost": None, "costPartial": True,
                                              "today": {"date": "2026-11-27", "tokens": 100, "cost": None, "costPartial": True}, "sessionFile": "/data/x"},
                         "all": {"days": 30, "tokens": 11895, "cost": 0.42, "costPartial": False, "today": {"date": "2026-11-27", "tokens": 5, "cost": 0.01},
                                 "daily": [{"date": "2026-11-27", "tokens": 5, "cost": 0.01}, {"date": "bad"}]},
                         "missingCostModels": ["xai/grok-3-fast", "bad model!"]}
    j = call(client, "GET", "/internal/v1/basht/usage").json()
    assert j["app"] == {"tokens": 10953, "cost": None, "cost_partial": True, "input": 9540, "output": 1413,
                        "today": {"date": "2026-11-27", "tokens": 100, "cost": None, "cost_partial": True}}
    assert j["all"]["cost"] == 0.42 and j["all"]["daily"] == [{"date": "2026-11-27", "tokens": 5, "cost": 0.01, "cost_partial": False}]
    assert j["missing_cost_models"] == ["xai/grok-3-fast"]


def test_memory_status_search_item_file(client, engine):
    calls, replies = engine
    replies["/memory/status"] = {"ok": True, "state": "ok", "searchMode": "fts-only", "files": 4, "chunks": 13, "lastIndexedAt": None,
                                 "bootstrap": [{"name": "MEMORY.md", "exists": True, "size": 417, "updatedAt": 7}, {"name": "AGENTS.md", "exists": True}]}
    j = call(client, "GET", "/internal/v1/basht/memory/status").json()
    assert j["state"] == "ok" and [f["name"] for f in j["bootstrap"]] == ["MEMORY.md"]

    replies["/memory/search"] = {"ok": True, "results": [
        {"file": "MEMORY.md", "snippet": "مؤسسة النخبة", "ref": REF, "date": None, "score": 0.9},
        {"file": "memory/../x.md", "snippet": "dir in name", "ref": REF},
        {"file": "2026-11-26.md", "snippet": "", "ref": REF}], "more": False, "stale": True}
    r = call(client, "POST", "/internal/v1/basht/memory/search", {"q": "النخبة", "page": 0})
    assert r.json() == {"results": [{"file": "MEMORY.md", "snippet": "مؤسسة النخبة", "ref": REF, "date": None}], "more": False, "stale": True, "page": 0}
    assert calls[-1]["path"] == "/memory/search?q=%D8%A7%D9%84%D9%86%D8%AE%D8%A8%D8%A9&page=0"
    assert call(client, "POST", "/internal/v1/basht/memory/search", {"q": "x" * 201}).status_code == 422
    assert call(client, "POST", "/internal/v1/basht/memory/search", {"q": "x", "page": 3}).status_code == 422
    e = audit_log.recent(1)[0]
    assert e["event"] == "basht.memory" and e["chars"] == 6 and "النخبة" not in json.dumps(e, ensure_ascii=False)

    replies["/memory/item"] = {"ok": True, "file": "2026-11-26.md", "text": "نص", "part": 0, "parts": 1, "chars": 2, "truncated": False}
    j = call(client, "POST", "/internal/v1/basht/memory/item", {"ref": REF}).json()
    assert j == {"file": "2026-11-26.md", "text": "نص", "part": 0, "parts": 1, "chars": 2, "truncated": False}
    assert call(client, "POST", "/internal/v1/basht/memory/item", {"ref": "memory/2026.md"}).status_code == 422

    replies["/memory/file"] = {"ok": True, "name": "USER.md", "exists": True, "updatedAt": 9, "text": "# USER", "part": 0, "parts": 1, "chars": 6}
    assert call(client, "POST", "/internal/v1/basht/memory/file", {"name": "AGENTS.md"}).status_code == 422
    j = call(client, "POST", "/internal/v1/basht/memory/file", {"name": "USER.md", "part": 0}).json()
    assert j["name"] == "USER.md" and j["text"] == "# USER"
    assert calls[-1]["path"] == "/memory/file?name=USER.md&part=0"


def test_capabilities_trimmed(client, engine):
    _, replies = engine
    replies["/capabilities"] = {"ok": True, "fetchedAt": 3,
        "channels": [{"id": "whatsapp", "label": "WhatsApp", "accounts": 1, "configured": True, "linked": True, "connected": True, "lastConnectedAt": 5,
                      "issue": None, "accountId": "+966500000001"}, {"id": "bad id!", "label": "x"}],
        "skills": {"ready": [{"name": "basht-daftra", "emoji": "📒", "description": "Daftra", "filePath": "/data/s"}],
                   "missing": [{"name": "1password", "missing": {"bins": ["op", "rm -rf"], "env": ["OP_TOKEN"], "config": 2, "os": False}}],
                   "unavailable": [{"name": "notes", "state": "disabled"}], "total": 3},
        "tools": {"profile": "full", "groups": [{"id": "fs", "label": "Files", "tools": [{"id": "read", "label": "Read", "rawDescription": "x"}]}]},
        "plugins": {"enabled": [{"id": "github", "name": "GitHub"}], "needsSetup": [], "failed": [{"id": "bad id", "name": "x"}], "total": 82}}
    r = call(client, "GET", "/internal/v1/basht/capabilities")
    j = r.json()
    assert j["channels"] == [{"id": "whatsapp", "label": "WhatsApp", "accounts": 1, "configured": True, "linked": True, "connected": True,
                              "last_connected_at": 5, "issue": None}]
    assert j["skills"]["missing"][0]["missing"] == {"bins": ["op"], "env": ["OP_TOKEN"], "config": 2, "os": False}
    assert j["tools"] == {"profile": "full", "count": 1, "groups": [{"id": "fs", "label": "Files", "plugin": False, "tools": [{"id": "read", "label": "Read"}]}]}
    assert j["plugins"]["failed"] == [] and j["plugins"]["total"] == 82
    assert "+966" not in r.text and "/data/" not in r.text and "rawDescription" not in r.text


def test_capabilities_uses_the_slow_timeout(client, engine):
    calls, replies = engine
    replies["/capabilities"] = {"ok": True, "channels": [], "skills": None, "tools": None, "plugins": None}
    j = call(client, "GET", "/internal/v1/basht/capabilities").json()
    assert j["skills"] is None and j["channels"] == []
    assert calls[-1]["timeout"] == 40.0
