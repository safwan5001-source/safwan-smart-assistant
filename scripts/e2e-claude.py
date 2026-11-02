#!/usr/bin/env python3
"""CHAT-AI-1 end-to-end proof on REAL processes: PostgreSQL (migrated), the FastAPI service, the Next.js BFF/UI (production build),
a local FAKE Anthropic server (no real key, no real data) and a headless Chromium with an iPhone profile.

Usage: SAFWAN_TEST_DATABASE_URL=<disposable superuser DSN> python scripts/e2e-claude.py   (needs `pnpm build:web` first)
Never point it at a real database."""
from __future__ import annotations

import json, os, secrets, subprocess, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg
from psycopg.conninfo import make_conninfo

ROOT = Path(__file__).resolve().parent.parent
BASE = os.environ["SAFWAN_TEST_DATABASE_URL"]
PY = str(ROOT / "services/api/.venv/bin/python")
API_PORT, WEB_PORT, FAKE_PORT = 8791, 3191, 8792
SECRET = "e2e-secret-" + secrets.token_hex(24)
CODE = secrets.token_urlsafe(36)
ACCOUNT = "5f1d6c3e-0d3a-4a55-9a41-7a2c1b3f9e01"
KEY = "sk-ant-FAKE-E2E-" + secrets.token_hex(8)
DB, ROLE = "safwan_e2e_ai_" + secrets.token_hex(3), "safwan_e2e_ai_login_" + secrets.token_hex(3)
procs: list[subprocess.Popen] = []
fake_log: list[dict] = []


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        fake_log.append({"path": self.path, "key": self.headers.get("x-api-key")})
        self.send_response(200); self.send_header("content-length", "2"); self.end_headers(); self.wfile.write(b"{}")
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        fake_log.append({"path": self.path, "key": self.headers.get("x-api-key"), "body": body})
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        def ev(t, d): self.wfile.write(f"event: {t}\ndata: {json.dumps(d)}\n\n".encode()); self.wfile.flush()
        last = body["messages"][-1]["content"]
        words = (["بطيء"] * 40) if "اطلب رداً طويلاً" in last else ["أهلاً", " صفوان،", f" سياق={len(body['messages'])}", " ", "تم", "."]
        try:
            ev("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": 30, "output_tokens": 1}}})
            for w in words:
                ev("content_block_delta", {"type": "content_block_delta", "delta": {"type": "text_delta", "text": w}})
                time.sleep(0.35)
            ev("message_delta", {"type": "message_delta", "usage": {"output_tokens": len(words)}})
            ev("message_stop", {"type": "message_stop"})
        except (BrokenPipeError, ConnectionResetError):
            fake_log.append({"path": "client-disconnected"})


def wait(url: str, secs=60):
    end = time.time() + secs
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=2).read(); return
        except Exception:
            time.sleep(0.5)
    raise SystemExit("timeout waiting for " + url)


def start_api(dsn):
    env = {**os.environ, "APP_ENV": "test", "APP_DATABASE_URL": dsn, "SERVICE_AUTH_SECRET": SECRET, "ASSISTANT_PROVIDER": "anthropic",
           "ANTHROPIC_API_KEY": KEY, "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{FAKE_PORT}", "AI_DAILY_BUDGET_USD": "2", "AI_MONTHLY_BUDGET_USD": "10",
           "AI_REQUESTS_PER_MINUTE": "60", "AI_ALLOWED_ACCOUNT_IDS": ACCOUNT, "ANTHROPIC_DEFAULT_MODEL": "claude-test-small",
           "ANTHROPIC_MODELS": json.dumps([{"id": "claude-test-small", "label": "Claude Test Small", "input_per_mtok": "1", "output_per_mtok": "5", "max_output": 2000},
                                            {"id": "claude-test-big", "label": "Claude Test Big", "input_per_mtok": "5", "output_per_mtok": "25", "max_output": 2000}])}
    p = subprocess.Popen([PY, "-m", "uvicorn", "app.main:app", "--port", str(API_PORT), "--log-level", "warning"], cwd=ROOT / "services/api", env=env)
    procs.append(p); wait(f"http://127.0.0.1:{API_PORT}/health"); return p


def main():
    with psycopg.connect(BASE, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{DB}"')
    owner = make_conninfo(BASE, dbname=DB)
    subprocess.run([PY, "-m", "app.db.migrate"], cwd=ROOT / "services/api", env={**os.environ, "MIGRATION_DATABASE_URL": owner}, check=True)
    with psycopg.connect(owner, autocommit=True) as c:
        c.execute(f"CREATE ROLE {ROLE} LOGIN PASSWORD 'e2e' IN ROLE safwan_app NOSUPERUSER NOBYPASSRLS")
        c.execute("INSERT INTO accounts (id, display_name) VALUES (%s, 'E2E owner')", (ACCOUNT,))
    runtime = make_conninfo(owner, user=ROLE, password="e2e")
    srv = ThreadingHTTPServer(("127.0.0.1", FAKE_PORT), Fake); threading.Thread(target=srv.serve_forever, daemon=True).start()
    api = start_api(runtime)
    web = subprocess.Popen(["pnpm", "--filter", "@safwan/web", "exec", "next", "start", "-p", str(WEB_PORT)], cwd=ROOT,
                           env={**os.environ, "BACKEND_URL": f"http://127.0.0.1:{API_PORT}", "SERVICE_AUTH_SECRET": SECRET, "AI_CHAT_ACCESS_CODE": CODE, "AI_OWNER_ACCOUNT_ID": ACCOUNT})
    procs.append(web); wait(f"http://127.0.0.1:{WEB_PORT}/api/health")
    ui = subprocess.run(["node", str(ROOT / "scripts/e2e-claude-ui.cjs")], cwd=ROOT, env={**os.environ, "WEB": f"http://127.0.0.1:{WEB_PORT}", "CODE": CODE, "SHOTS": os.environ.get("SHOTS", "/tmp")}, text=True)
    if ui.returncode != 0:
        raise SystemExit("UI scenario failed")
    # server-side evidence, independent of the UI
    with psycopg.connect(owner, autocommit=True) as c:
        msgs = c.execute("SELECT body->>'role', left(body->>'content', 40), coalesce(body->>'partial','false') FROM sync_records WHERE kind='message' ORDER BY (body->>'seq')::int, updated_at").fetchall()
        usage = c.execute("SELECT period, spent_micro, reserved_micro, requests FROM ai_usage ORDER BY period").fetchall()
    print("DB messages:", msgs); print("DB usage:", usage)
    assert usage and all(r[2] == 0 for r in usage), "reservations must all be settled"
    assert all(e.get("key") in (KEY, None) for e in fake_log), "only the server key may reach Anthropic"
    assert any(e["path"] == "/v1/models/claude-test-big" for e in fake_log), "default model switch + probe must hit Anthropic with the new model"
    print("fake anthropic saw", len([e for e in fake_log if 'body' in e]), "chat calls; disconnects:", len([e for e in fake_log if e['path'] == 'client-disconnected']))
    # restart the API: spend and conversations are in PostgreSQL, not memory
    api.terminate(); api.wait(); start_api(runtime)
    with psycopg.connect(owner, autocommit=True) as c:
        after = c.execute("SELECT count(*) FROM sync_records WHERE kind='message'").fetchone()[0]
    assert after == len(msgs)
    print("E2E OK")


try:
    main()
finally:
    for p in procs:
        p.terminate()
    try:
        with psycopg.connect(BASE, autocommit=True) as c:
            c.execute(f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'); c.execute(f"DROP ROLE IF EXISTS {ROLE}")
    except Exception:
        pass
