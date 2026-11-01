#!/usr/bin/env bash
# End-to-end proof of the BFF -> API hop on real processes and a real PostgreSQL (the same code paths Vercel runs;
# it does NOT prove Vercel's Service Binding itself — that is verified on a Preview deployment, see docs/B1-PREVIEW-CHECKLIST.md).
#
# Needs: SAFWAN_TEST_DATABASE_URL (superuser DSN of a DISPOSABLE postgres), a Python env with the API installed
#        (PYTHON=...), and a built web app (pnpm build:web). Never point this at a real database.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SAFWAN_TEST_DATABASE_URL:?set SAFWAN_TEST_DATABASE_URL to a disposable PostgreSQL superuser DSN}"
# Prefer the API's locked environment (created by `uv sync` per the README) so a clean machine needs no global installs.
if [ -z "${PYTHON:-}" ]; then
  if [ -x "$PWD/services/api/.venv/bin/python" ]; then PYTHON="$PWD/services/api/.venv/bin/python"; else PYTHON=python; fi
fi
API_PORT="${API_PORT:-8765}"; WEB_PORT="${WEB_PORT:-3101}"
SECRET="e2e-secret-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
RAND="$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
DB="safwan_e2e_$RAND"; LOGIN_ROLE="safwan_e2e_login_$RAND"   # roles are cluster-wide: never share a fixed name with other tooling
PIDS=(); FAILS=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS+1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  "$PYTHON" - <<PY 2>/dev/null || true
import psycopg
c = psycopg.connect("$SAFWAN_TEST_DATABASE_URL", autocommit=True)
c.execute('DROP DATABASE IF EXISTS "$DB" WITH (FORCE)')
c.execute('DROP ROLE IF EXISTS $LOGIN_ROLE')
PY
}
trap cleanup EXIT

DSN_OWNER=$("$PYTHON" - <<PY
import psycopg
from psycopg.conninfo import make_conninfo
base="$SAFWAN_TEST_DATABASE_URL"
psycopg.connect(base, autocommit=True).execute('CREATE DATABASE "$DB"')
print(make_conninfo(base, dbname="$DB"))
PY
)
# 1) migrations as the OWNER role
( cd services/api && MIGRATION_DATABASE_URL="$DSN_OWNER" "$PYTHON" -m app.db.migrate )
# 2) a LOGIN role that is only a member of the restricted application role (what production should use)
DSN_RUNTIME=$("$PYTHON" - <<PY
import psycopg
from psycopg.conninfo import make_conninfo
c=psycopg.connect("$DSN_OWNER", autocommit=True)
c.execute("CREATE ROLE $LOGIN_ROLE LOGIN PASSWORD 'e2e' IN ROLE safwan_app NOSUPERUSER NOBYPASSRLS")
print(make_conninfo("$DSN_OWNER", user="$LOGIN_ROLE", password="e2e"))
PY
)

# 3) API in PRODUCTION mode (fail-closed defaults), runtime role, real nonce store
API="http://127.0.0.1:$API_PORT"; WEB="http://127.0.0.1:$WEB_PORT"
( cd services/api && exec env APP_ENV=production APP_DATABASE_URL="$DSN_RUNTIME" SERVICE_AUTH_SECRET="$SECRET" \
  "$PYTHON" -m uvicorn app.main:app --port "$API_PORT" --log-level warning ) & API_PID=$!; PIDS+=($API_PID)
# 4) web tier (BFF); restarted with different environments below
WEB_PID=""
start_web() {  # $1=BACKEND_URL or "" ; $2=SERVICE_AUTH_SECRET or ""
  [ -n "$WEB_PID" ] && { kill "$WEB_PID" 2>/dev/null || true; wait "$WEB_PID" 2>/dev/null || true; }
  ( cd apps/web && exec env -u BACKEND_URL -u SERVICE_AUTH_SECRET HEALTH_CACHE_MS="${WEB_CACHE_MS:-5000}" ${1:+BACKEND_URL="$1"} ${2:+SERVICE_AUTH_SECRET="$2"} \
    ./node_modules/.bin/next start -p "$WEB_PORT" ) >/tmp/e2e-web.log 2>&1 & WEB_PID=$!; PIDS+=($WEB_PID)
  for i in $(seq 1 40); do curl -s -o /dev/null "$WEB/api/health" && return 0; sleep 1; done
  echo "web did not start"; cat /tmp/e2e-web.log; return 1
}
for i in $(seq 1 40); do curl -fsS "$API/health" >/dev/null 2>&1 && break; sleep 1; done
WEB_CACHE_MS=0 start_web "$API" "$SECRET"   # cache OFF for the first phase: every request must be a real, freshly-signed probe
jget() { "$PYTHON" -c "import sys,json; d=json.load(sys.stdin); print(d$1)" ; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "── the signed hop works"
R=$(curl -s -w '\n%{http_code}' "$WEB/api/health"); check "GET /api/health -> 200" "$(echo "$R" | tail -1)" "200"
check "backend reported ok" "$(echo "$R" | head -1 | jget "['backend']")" "ok"
check "assistant truthfully off" "$(echo "$R" | head -1 | jget "['features']['assistant']")" "False"
check "no secret/URL in public response" "$(echo "$R" | head -1 | grep -c -e "$SECRET" -e "127.0.0.1")" "0"
check "responses are not cacheable" "$(curl -sI "$WEB/api/health" | tr -d '\r' | grep -i '^cache-control' | grep -ci 'no-store')" "1"
nonces() { "$PYTHON" -c "import psycopg; print(psycopg.connect('$DSN_OWNER').execute('select count(*) from service_nonces').fetchone()[0])"; }
N0=$(nonces)
check "10 consecutive calls all succeed (cache off)" "$(for i in $(seq 10); do code "$WEB/api/health"; echo; done | sort -u | tr -d '\n')" "200"
check "each of the 10 calls claimed a fresh nonce in PostgreSQL" "$(( $(nonces) - N0 ))" "10"

echo "── the PUBLIC route cannot be turned into a database load amplifier (cache on, the default)"
start_web "$API" "$SECRET"
N1=$(nonces)
check "burst of 40 concurrent public requests all succeed" "$(for i in $(seq 40); do printf '%s\n' "$(code "$WEB/api/health")" & done | sort | uniq -c | tr -s ' ' | tr -d '\n')" " 40 200"
check "...but cost at most ONE backend probe / nonce" "$(( $(nonces) - N1 <= 1 ? 1 : 0 ))" "1"

echo "── the API is closed to everything that is not a valid signed call"
check "direct unsigned /internal/v1/ping -> 401" "$(code "$API/internal/v1/ping")" "401"
check "direct /tools (user route) -> 503 in production" "$(code "$API/tools")" "503"
check "direct /tasks POST -> 503 in production" "$(code -X POST -H 'content-type: application/json' -d '{"instruction":"x","permission_mode":"review"}' "$API/tasks")" "503"
check "internal route absent from public OpenAPI" "$(curl -s "$API/openapi.json" | grep -c '/internal/')" "0"
check "/health stays public" "$(code "$API/health")" "200"
check "web has no proxy to the API (/backend/health -> 404)" "$(code "$WEB/backend/health")" "404"
check "POST /api/health not allowed" "$(code -X POST "$WEB/api/health")" "405"

echo "── replay is refused (captured signed request re-sent)"
read -r STATUS_1 STATUS_2 < <("$PYTHON" - <<PY
import sys, time, urllib.request, urllib.error
sys.path.insert(0, "services/api")
from app.service_auth import sign
secret="$SECRET".encode(); ts=int(time.time()); nonce="replayCheck0123456789AB"; target="/internal/v1/ping"
h={"x-svc-ts":str(ts),"x-svc-nonce":nonce,"x-svc-sig":sign(secret,"GET",target,ts,nonce,b"",None)}
def call():
    try: return urllib.request.urlopen(urllib.request.Request("$API"+target, headers=h)).status
    except urllib.error.HTTPError as e: return e.code
print(call(), call())
PY
)
check "first use of a signed request -> 200" "$STATUS_1" "200"
check "identical resend -> 401" "$STATUS_2" "401"

echo "── wrong secret on the web tier is rejected, and says so only coarsely"
start_web "$API" "a-different-secret-that-is-long-enough-0123456789"
R=$(curl -s -w '\n%{http_code}' "$WEB/api/health"); check "wrong secret -> 503" "$(echo "$R" | tail -1)" "503"
check "reason is 'rejected'" "$(echo "$R" | head -1 | jget "['backend']")" "rejected"

echo "── web without configuration fails closed"
start_web "" ""
R=$(curl -s -w '\n%{http_code}' "$WEB/api/health"); check "no BACKEND_URL/secret -> 503" "$(echo "$R" | tail -1)" "503"
check "reason is 'unconfigured'" "$(echo "$R" | head -1 | jget "['backend']")" "unconfigured"
start_web "$API" "short"
check "weak secret is refused client-side (unconfigured)" "$(curl -s "$WEB/api/health" | jget "['backend']")" "unconfigured"

echo "── backend down fails closed"
kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true
start_web "$API" "$SECRET"
R=$(curl -s -w '\n%{http_code}' "$WEB/api/health"); check "API stopped -> 503" "$(echo "$R" | tail -1)" "503"
check "reason is 'unreachable'" "$(echo "$R" | head -1 | jget "['backend']")" "unreachable"

echo; if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED"; exit 1; fi
