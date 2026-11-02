"""Chat -> browser worker bridge (/internal/v1/browser/tasks*): authentication, opt-in flag, SSRF policy, response sanitising, failure mapping."""
import io
import json
import time
import urllib.request
from urllib.error import HTTPError, URLError

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
_n = iter(range(1_000_000))


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_SECRET", SECRET)
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", BROWSER_TOKEN)
    monkeypatch.setenv("BROWSER_SERVICE_URL", WORKER)
    monkeypatch.setenv("BROWSER_CHAT_ENABLED", "1")
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


def job(**over):
    base = {"id": TASK, "status": "running", "url": "https://example.com/", "createdAt": 1_700_000_000_000,
            "steps": [{"id": s, "status": "pending"} for s in bt.STEP_IDS], "sessionReleased": False}
    return {**base, **over}


class Resp(io.BytesIO):
    def __init__(self, data, status=200):
        super().__init__(data if isinstance(data, bytes) else json.dumps(data).encode())
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


@pytest.fixture
def worker(monkeypatch):
    """Fake worker. `.reply` is what it answers; `.calls` records every outbound request."""
    class W:
        calls: list = []
        reply = Resp({"job": job()}, 202)
    w = W()
    w.calls = []

    def fake(request, timeout):
        w.calls.append({"url": request.full_url, "method": request.get_method(), "auth": request.get_header("Authorization"),
                        "body": request.data, "timeout": timeout, "ctype": request.get_header("Content-type")})
        r = w.reply
        if isinstance(r, Exception):
            raise r
        return r
    monkeypatch.setattr(bt, "_open", fake)
    return w


# ── authentication & opt-in ──────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("method,target", [("POST", BASE), ("GET", f"{BASE}/{TASK}"), ("POST", f"{BASE}/{TASK}/cancel"), ("GET", f"{BASE}/{TASK}/screenshot")])
def test_unsigned_and_wrongly_credentialed_calls_never_reach_the_worker(client, worker, method, target):
    payload = {"url": "https://example.com/"} if method == "POST" and target == BASE else None
    assert call(client, method, target, payload, headers={}).status_code == 401
    assert call(client, method, target, payload, headers={"Authorization": f"Bearer {BROWSER_TOKEN}"}).status_code == 401   # worker token != BFF credential
    assert call(client, method, target, payload, headers={"Authorization": f"Bearer {SECRET}"}).status_code == 401
    bad = signed(method, target); bad["x-svc-sig"] = "0" * 64
    assert call(client, method, target, payload, headers=bad).status_code == 401
    assert worker.calls == []


def test_a_replayed_request_is_refused(client, worker):
    body = json.dumps({"url": "https://example.com/"}).encode()
    h = {**signed("POST", BASE, body), "content-type": "application/json"}
    worker.reply = Resp({"job": job()}, 202)
    assert client.post(BASE, content=body, headers=h).status_code == 202
    worker.reply = Resp({"job": job()}, 202)
    assert client.post(BASE, content=body, headers=h).status_code == 401
    assert len(worker.calls) == 1


def test_off_by_default_even_for_a_validly_signed_call(client, worker, monkeypatch):
    monkeypatch.delenv("BROWSER_CHAT_ENABLED")
    r = call(client, "POST", BASE, {"url": "https://example.com/"})
    assert r.status_code == 503 and r.json()["detail"] == {"code": "browser_chat_disabled"}
    for flag in ("", "0", "false", "no", "off"):
        monkeypatch.setenv("BROWSER_CHAT_ENABLED", flag)
        assert call(client, "GET", f"{BASE}/{TASK}").status_code == 503
    assert worker.calls == []


@pytest.mark.parametrize("token", ["", "short", "x" * 31, SECRET])
def test_weak_missing_or_colliding_worker_token_fails_closed(client, worker, monkeypatch, token):
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", token)
    r = call(client, "POST", BASE, {"url": "https://example.com/"})
    assert r.status_code in (503,) and worker.calls == []


@pytest.mark.parametrize("url", ["", "http://safwan-browser.railway.internal:8080/", "http://safwan-browser.railway.internal:8081", "https://safwan-browser.railway.internal:8080",
                                 "http://evil.test:8080", "http://127.0.0.1:9000", "http://169.254.169.254"])
def test_only_the_private_railway_worker_is_ever_contacted(client, worker, monkeypatch, url):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("BROWSER_SERVICE_URL", url)
    assert call(client, "POST", BASE, {"url": "https://example.com/"}).status_code == 503
    assert worker.calls == []


def test_loopback_worker_is_accepted_only_outside_production(client, worker, monkeypatch):
    monkeypatch.setenv("BROWSER_SERVICE_URL", "http://127.0.0.1:9123")
    monkeypatch.setenv("APP_ENV", "development")
    assert call(client, "POST", BASE, {"url": "https://example.com/"}).status_code == 202
    assert worker.calls[-1]["url"] == "http://127.0.0.1:9123/v1/jobs"
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_ID", "x")           # any Railway runtime is forced to production
    assert call(client, "POST", BASE, {"url": "https://example.com/"}).status_code == 503


# ── SSRF / URL policy ────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("url", [
    "http://example.com/", "https://example.com:8443/", "https://example.com:443/", "https://user:pw@example.com/", "https://example.com@evil.test/",
    "https://example.com.evil.test/", "https://evil.test/https://example.com/", "https://sub.example.com/", "https://example.com/?a=1", "https://example.com/#x",
    "https://example.com/%2e%2e/", "https://example.com/a/../b", "https://example.com\\@evil.test", "https://example.com/\n", "https://example.com/ ", " https://example.com/",
    "https://EXAMPLE.com/", "https://localhost/", "https://127.0.0.1/", "https://[::1]/", "https://[::ffff:169.254.169.254]/", "https://169.254.169.254/latest/meta-data/",
    "https://2852039166/", "https://0xa9fea9fe/", "https://10.0.0.1/", "https://safwan-api.railway.internal/", "https://safwan-browser.railway.internal:8080/",
    "file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "data:text/html,x", "//example.com/", "example.com", "https://example.com/" + "a" * 200,
])
def test_ssrf_and_malformed_targets_are_refused_before_the_worker_is_contacted(client, worker, url):
    r = call(client, "POST", BASE, {"url": url})
    assert r.status_code in (400, 422), (url, r.status_code)
    assert worker.calls == []


@pytest.mark.parametrize("payload", [{}, {"url": 5}, {"url": None}, {"url": ["https://example.com/"]}, {"url": "https://example.com/", "extra": 1}, {"url": "https://example.com/", "host": "evil.test"}])
def test_body_shape_is_strict(client, worker, payload):
    assert call(client, "POST", BASE, payload).status_code == 422 and worker.calls == []


def test_oversized_bodies_are_rejected_before_parsing(client, worker):
    body = json.dumps({"url": "https://example.com/", "pad": "x" * 10_000}).encode()
    r = client.post(BASE, content=body, headers={**signed("POST", BASE, body), "content-type": "application/json"})
    assert r.status_code == 413 and worker.calls == []


def test_redirects_from_the_worker_are_never_followed():
    assert bt._NoRedirect().redirect_request(None, None, 302, "Found", {}, "http://evil.test/") is None


# ── happy path: what is sent, what comes back ────────────────────────────────────────────────────
def test_create_forwards_exactly_the_validated_url_with_the_worker_token_and_returns_a_clean_view(client, worker):
    worker.reply = Resp({"job": {**job(), "connectUrl": "wss://secret", "sessionId": "abc", "signingKey": "k"}}, 202)
    r = call(client, "POST", BASE, {"url": "https://example.com/page-1"})
    assert r.status_code == 202
    sent = worker.calls[0]
    assert sent["url"] == WORKER + "/v1/jobs" and sent["method"] == "POST" and sent["auth"] == "Bearer " + BROWSER_TOKEN
    assert json.loads(sent["body"]) == {"url": "https://example.com/page-1"} and sent["timeout"] == 10
    assert set(r.json()) == {"task"} and set(r.json()["task"]) == {"id", "status", "url", "steps", "sessionReleased", "createdAt"}
    for secret in ("secret", "signingKey", "sessionId", BROWSER_TOKEN, "railway.internal"):
        assert secret not in r.text
    entry = audit_log.recent(1)[0]
    assert entry["event"] == "browser.task.create" and "page-1" not in json.dumps(entry)


def test_result_text_is_sanitised_and_bounded(client, worker):
    res = {"title": "T‮" + "x" * 500, "url": "https://example.com/", "excerpt": "a\u0000b‮c‏d" + "y" * 9000, "hasScreenshot": True}
    worker.reply = Resp({"job": job(status="succeeded", result=res, finishedAt=1_700_000_005_000)}, 200)
    r = call(client, "GET", f"{BASE}/{TASK}")
    out = r.json()["task"]["result"]
    assert len(out["title"]) == 200 and len(out["excerpt"]) == 4000 and out["hasScreenshot"] is True
    assert not any(ch in out["title"] + out["excerpt"] for ch in "‮‏\u0000")
    assert out["excerpt"].startswith("abcd")


def test_cancel_and_status_map_through(client, worker):
    worker.reply = Resp({"job": job(status="cancelling")}, 200)
    r = call(client, "POST", f"{BASE}/{TASK}/cancel")
    assert r.status_code == 200 and r.json()["task"]["status"] == "cancelling"
    assert worker.calls[0]["url"] == f"{WORKER}/v1/jobs/{TASK}/cancel" and worker.calls[0]["method"] == "POST"
    assert audit_log.recent(1)[0]["event"] == "browser.task.cancel"
    worker.reply = Resp({"job": job(status="failed", error="made_up_code")}, 200)
    assert call(client, "GET", f"{BASE}/{TASK}").json()["task"]["error"] == "browser_execution_failed"   # unknown codes collapse


@pytest.mark.parametrize("bad", ["not-a-uuid", "../../etc/passwd", "11111111-1111-1111-1111-111111111111", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", TASK + "x"])
def test_task_ids_are_validated_before_use(client, worker, bad):
    for method, suffix in (("GET", ""), ("POST", "/cancel"), ("GET", "/screenshot")):
        assert call(client, method, f"{BASE}/{bad}{suffix}").status_code == 404
    assert worker.calls == []


# ── failure mapping ──────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("status,expect", [(429, 409), (404, 404), (400, 400), (401, 502), (500, 502), (503, 502), (200, 502)])
def test_worker_statuses_map_to_stable_codes(client, worker, status, expect):
    worker.reply = Resp(b'{"error":"x http://secret.internal"}', status)
    r = call(client, "POST", BASE, {"url": "https://example.com/"})
    assert r.status_code == expect and "secret.internal" not in r.text and "x http" not in r.text


@pytest.mark.parametrize("exc", [URLError("connection refused http://safwan-browser.railway.internal:8080"), TimeoutError("t"), OSError("o"),
                                 HTTPError(WORKER, 502, "bad", {}, io.BytesIO(b"boom"))])
def test_network_failures_are_generic(client, worker, exc):
    worker.reply = exc
    r = call(client, "GET", f"{BASE}/{TASK}")
    assert r.status_code == 502 and r.json()["detail"] == {"code": "browser_unavailable"} and "railway" not in r.text


@pytest.mark.parametrize("bad", [
    {"job": None}, {"job": "x"}, {}, {"job": job(id="nope")}, {"job": job(status="weird")}, {"job": job(url="https://evil.test/")},
    {"job": job(steps=[])}, {"job": job(steps=list(reversed(job()["steps"])))}, {"job": job(steps=[{"id": s, "status": "???"} for s in bt.STEP_IDS])},
    {"job": job(result={"url": "https://evil.test/", "title": "", "excerpt": "", "hasScreenshot": False})}, {"job": job(result="x")},
])
def test_malformed_worker_views_become_a_generic_502(client, worker, bad):
    worker.reply = Resp(bad, 200)
    assert call(client, "GET", f"{BASE}/{TASK}").status_code == 502


def test_oversized_worker_replies_are_refused(client, worker):
    worker.reply = Resp(b'{"job":' + b" " * 20_000 + b"}", 200)
    assert call(client, "GET", f"{BASE}/{TASK}").status_code == 502


# ── screenshot ───────────────────────────────────────────────────────────────────────────────────
def test_screenshot_is_a_jpeg_or_nothing(client, worker):
    jpeg = b"\xff\xd8\xff" + b"\x00" * 3000
    worker.reply = Resp(jpeg, 200)
    r = call(client, "GET", f"{BASE}/{TASK}/screenshot")
    assert r.status_code == 200 and r.json()["mimeType"] == "image/jpeg"
    import base64
    assert base64.b64decode(r.json()["base64"]) == jpeg
    for bad in (b"<html><script>alert(1)</script></html>", b"\x89PNG\r\n", b"", b"\xff\xd8\xff" + b"0" * 270_000):
        worker.reply = Resp(bad, 200)
        assert call(client, "GET", f"{BASE}/{TASK}/screenshot").status_code == 502
    worker.reply = Resp(b"{}", 404)
    assert call(client, "GET", f"{BASE}/{TASK}/screenshot").status_code == 404


def test_the_real_opener_does_not_follow_redirects():
    """A 302 from the worker address must surface as an HTTP error, not a second request."""
    import http.server
    import threading

    hits = []

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            hits.append(self.path)
            self.send_response(302); self.send_header("Location", "http://127.0.0.1:1/stolen"); self.end_headers()

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{srv.server_port}/x", headers={"Authorization": "Bearer t"})
        with pytest.raises(HTTPError) as e:
            bt._open(req, 3)
        assert e.value.code == 302 and hits == ["/x"]
    finally:
        srv.shutdown()


# ── root cause of the production 502: a header-unsafe BROWSER_SERVICE_TOKEN ──────────────────────
# Evidence (Railway, 2026-11-02): POST /internal/v1/browser/tasks -> 502 in ~50 ms, no DNS lookup or TCP flow to the worker, nothing in
# the worker's ingress, no "invalid job view" log. `http.client` raises ValueError for a CR/LF (or non-latin-1 char) in a header value
# *before opening a socket*; the bridge caught ValueError together with network errors and answered an unexplained 502.
UNSAFE_TOKENS = {
    "trailing_lf": "w" * 40 + "\n",
    "trailing_crlf": "w" * 40 + "\r\n",
    "leading_space": " " + "w" * 40,
    "inner_space": "w" * 20 + " " + "w" * 20,
    "tab": "w" * 20 + "\t" + "w" * 20,
    "non_latin1": "w" * 40 + "ل",
    "latin1_accent": "w" * 40 + "é",
}


@pytest.mark.parametrize("token", list(UNSAFE_TOKENS.values()), ids=list(UNSAFE_TOKENS))
def test_header_unsafe_token_is_a_configuration_error_not_an_unexplained_502(client, worker, monkeypatch, caplog, token):
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", token)
    with caplog.at_level("ERROR", logger="safwan.browser_tasks"):
        for method, target, payload in (("POST", BASE, {"url": "https://example.com/"}), ("GET", f"{BASE}/{TASK}", None),
                                        ("POST", f"{BASE}/{TASK}/cancel", None), ("GET", f"{BASE}/{TASK}/screenshot", None)):
            r = call(client, method, target, payload)
            assert r.status_code == 503 and r.json()["detail"] == {"code": "browser_unconfigured"}, (method, target)
    assert worker.calls == []
    log_text = caplog.text
    assert "reason=worker_unconfigured" in log_text and "token_header_safe=False" in log_text
    assert token.strip() not in log_text and "w" * 20 not in log_text            # the secret never reaches the logs


def test_unsafe_token_never_reaches_urllib_with_the_real_opener(client, monkeypatch):
    """Same scenario without the fake `_open`: no socket may be opened at all."""
    import socket
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", UNSAFE_TOKENS["trailing_lf"])
    def no_network(*a, **k):
        raise AssertionError("a socket was opened")
    monkeypatch.setattr(socket, "create_connection", no_network)
    monkeypatch.setattr(socket, "getaddrinfo", no_network)
    assert call(client, "POST", BASE, {"url": "https://example.com/"}).status_code == 503


@pytest.mark.parametrize("token,ok", [("w" * 40, True), ("Ab3-_.~+/=" * 4, True), ("0123456789abcdef" * 4, True), ("w" * 31, True), ("", False), ("a b", False), ("a\n", False), ("é", False)])
def test_header_safe_accepts_only_visible_ascii(token, ok):
    from app import browser_token
    assert browser_token.header_safe(token) is ok


# ── every failure class is distinguishable in the logs (and only there) ──────────────────────────
@pytest.mark.parametrize("reply,reason", [
    (URLError(OSError("x")), "connect_failed"),
    (URLError(ConnectionRefusedError()), "connect_failed"),
    (ConnectionResetError(), "connect_failed"),
    (URLError(__import__("socket").gaierror(-2, "Name or service not known")), "dns_failed"),
    (TimeoutError("t"), "timeout"),
    (URLError(TimeoutError("t")), "timeout"),
    (ValueError("Invalid header value"), "invalid_request"),
    (UnicodeEncodeError("latin-1", "ل", 0, 1, "x"), "invalid_request"),
])
def test_network_failure_classes_are_logged_with_a_fixed_vocabulary(client, worker, caplog, reply, reason):
    worker.reply = reply
    with caplog.at_level("ERROR", logger="safwan.browser_tasks"):
        r = call(client, "POST", BASE, {"url": "https://example.com/"})
    assert r.status_code == 502 and r.json()["detail"] == {"code": "browser_unavailable"}
    assert f"reason={reason} op=POST /v1/jobs status=-" in caplog.text
    assert "railway" not in caplog.text and BROWSER_TOKEN not in caplog.text


@pytest.mark.parametrize("status,reason", [(401, "worker_unauthorized"), (403, "worker_unauthorized"), (415, "worker_rejected"), (500, "worker_rejected"), (503, "worker_rejected")])
def test_worker_auth_rejection_is_told_apart_from_other_rejections(client, worker, caplog, status, reason):
    worker.reply = Resp(b'{"error":"unauthorized"}', status)
    with caplog.at_level("ERROR", logger="safwan.browser_tasks"):
        assert call(client, "POST", BASE, {"url": "https://example.com/"}).status_code == 502
    assert f"reason={reason} op=POST /v1/jobs status={status}" in caplog.text


def test_invalid_job_view_is_told_apart_and_logs_no_content(client, worker, caplog):
    worker.reply = Resp({"job": job(url="https://evil.test/secret-path")}, 200)
    with caplog.at_level("ERROR", logger="safwan.browser_tasks"):
        assert call(client, "GET", f"{BASE}/{TASK}").status_code == 502
    assert "reason=invalid_job_view op=GET /v1/jobs/:id status=200" in caplog.text
    assert "evil.test" not in caplog.text and TASK not in caplog.text


def test_oversized_and_bad_screenshot_are_classified(client, worker, caplog):
    with caplog.at_level("ERROR", logger="safwan.browser_tasks"):
        worker.reply = Resp(b'{"job":' + b" " * (bt.MAX_JOB_JSON + 1_000) + b"}", 200)
        call(client, "GET", f"{BASE}/{TASK}")
        worker.reply = Resp(b"<html>", 200)
        call(client, "GET", f"{BASE}/{TASK}/screenshot")
        worker.reply = Resp(b"nope", 401)
        call(client, "GET", f"{BASE}/{TASK}/screenshot")
    assert "reason=oversized op=GET /v1/jobs/:id" in caplog.text
    assert "reason=invalid_screenshot op=GET /v1/jobs/:id/screenshot status=200" in caplog.text
    assert "reason=worker_unauthorized op=GET /v1/jobs/:id/screenshot status=401" in caplog.text


def test_a_browserbase_failure_is_a_valid_failed_job_not_a_502(client, worker, caplog):
    """Provider errors happen after POST /v1/jobs returned 202: the worker reports them inside a *valid* job view."""
    failed = job(status="failed", error="browser_execution_failed", finishedAt=1_700_000_009_000,
                 steps=[{"id": "create_session", "status": "failed"}] + [{"id": s, "status": "skipped"} for s in bt.STEP_IDS[1:-1]] + [{"id": "release", "status": "done"}])
    worker.reply = Resp({"job": failed}, 200)
    with caplog.at_level("ERROR", logger="safwan.browser_tasks"):
        r = call(client, "GET", f"{BASE}/{TASK}")
    assert r.status_code == 200 and r.json()["task"]["status"] == "failed" and r.json()["task"]["error"] == "browser_execution_failed"
    assert "browser worker call failed" not in caplog.text
