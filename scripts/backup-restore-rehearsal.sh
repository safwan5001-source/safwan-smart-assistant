#!/usr/bin/env bash
# Backup -> restore REHEARSAL between two DISPOSABLE PostgreSQL clusters. Proves, with real data, that a logical backup
# (pg_dump) restored into a FRESH cluster keeps everything the security design depends on: row-level security, FORCE flags,
# the exact runtime privilege set, the SECURITY DEFINER session lookup, session revocation, and migration checksums.
#
#   SOURCE_ADMIN_URL=postgresql://postgres:...@host:5433/postgres   (disposable superuser DSN, contains the data)
#   TARGET_ADMIN_URL=postgresql://postgres:...@host:5434/postgres   (a different, EMPTY cluster: no safwan_app role yet)
#   PG_BIN=/usr/lib/postgresql/18/bin  PYTHON=services/api/.venv/bin/python  bash scripts/backup-restore-rehearsal.sh
#
# Never point either URL at a real database. The same steps are the production restore runbook
# (docs/deploy/RAILWAY-PHASE3-DB-AUTH.md §6): create the roles first, restore with --no-owner, re-run the migrator (a no-op),
# recreate the runtime login, verify.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SOURCE_ADMIN_URL:?}"; : "${TARGET_ADMIN_URL:?}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/18/bin}"; PYTHON="${PYTHON:-services/api/.venv/bin/python}"
RAND="$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SRC_DB="safwan_bk_src_$RAND"; DST_DB="safwan_bk_dst_$RAND"; LOGIN="safwan_bk_login_$RAND"
DUMP="$(mktemp -d)/dump.pgc"; FAILS=0; CREATED_ROLE=0
pass() { echo "PASS  $1"; }; fail() { echo "FAIL  $1"; FAILS=$((FAILS+1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
py() { PYTHONPATH=services/api "$PYTHON" - "$@"; }
dsn() { py "$1" "$2" <<'PY'
import sys; from psycopg.conninfo import make_conninfo; print(make_conninfo(sys.argv[1], dbname=sys.argv[2]))
PY
}
cleanup() { py <<PY 2>/dev/null || true
import psycopg
for url, db in (("$SOURCE_ADMIN_URL", "$SRC_DB"), ("$TARGET_ADMIN_URL", "$DST_DB")):
    psycopg.connect(url, autocommit=True).execute(f'DROP DATABASE IF EXISTS "{db}" WITH (FORCE)')
c = psycopg.connect("$TARGET_ADMIN_URL", autocommit=True)
c.execute("DROP ROLE IF EXISTS $LOGIN")
if "$CREATED_ROLE" == "1":  # only the role THIS run created on the disposable target; never one that pre-existed
    c.execute("DROP ROLE IF EXISTS safwan_app")
PY
rm -rf "$(dirname "$DUMP")"; }
trap cleanup EXIT

echo "── 1) source: migrate and create real data (accounts, tenant rows, live + revoked sessions)"
SRC=$(py "$SOURCE_ADMIN_URL" "$SRC_DB" <<'PY'
import sys, psycopg; from psycopg.conninfo import make_conninfo
base, db = sys.argv[1], sys.argv[2]
psycopg.connect(base, autocommit=True).execute(f'CREATE DATABASE "{db}"')
print(make_conninfo(base, dbname=db))
PY
)
SECRETS=$(py "$SRC" <<'PY'
import sys, psycopg
from uuid import UUID
from app.db.migrate import migrate
from app.auth.sessions import create_session, revoke_session
dsn = sys.argv[1]
c = psycopg.connect(dsn, autocommit=True); migrate(c)
A, B = UUID("11111111-1111-4111-8111-111111111111"), UUID("22222222-2222-4222-8222-222222222222")
for acct, name in ((A, "A"), (B, "B")):
    c.execute("INSERT INTO accounts (id, display_name) VALUES (%s, %s)", (acct, name))
for i in range(5): c.execute("INSERT INTO sync_records (account_id, kind, id, body) VALUES (%s,'task',gen_random_uuid(),%s::jsonb)", (A, '{"n":%d}' % i))
for i in range(3): c.execute("INSERT INTO sync_records (account_id, kind, id) VALUES (%s,'task',gen_random_uuid())", (B,))
c.execute("INSERT INTO audit_log (account_id, event) VALUES (%s,'bk.test')", (A,))
live, _ = create_session(c, A); dead, _ = create_session(c, B)
assert revoke_session(c, B, dead)
print(live, dead)
PY
)
LIVE=${SECRETS% *}; DEAD=${SECRETS#* }

echo "── 2) logical backup (custom format, ACLs and policies included)"
"$PG_BIN/pg_dump" --format=custom --no-owner --dbname="$SRC" --file="$DUMP"
check "dump file is non-empty" "$([ -s "$DUMP" ] && echo yes || echo no)" "yes"

echo "── 3) restore into a FRESH cluster (it has no safwan_app role yet)"
DST_BASE_OK=$(py "$TARGET_ADMIN_URL" <<'PY'
import sys, psycopg
c = psycopg.connect(sys.argv[1], autocommit=True)
print(c.execute("SELECT count(*) FROM pg_roles WHERE rolname = 'safwan_app'").fetchone()[0])
PY
)
check "target cluster starts without the application role" "$DST_BASE_OK" "0"
py "$TARGET_ADMIN_URL" "$DST_DB" <<'PY'
import sys, psycopg
c = psycopg.connect(sys.argv[1], autocommit=True)
c.execute(f'CREATE DATABASE "{sys.argv[2]}"')
PY
DST=$(dsn "$TARGET_ADMIN_URL" "$DST_DB")
set +e; "$PG_BIN/pg_restore" --no-owner --exit-on-error --dbname="$DST" "$DUMP" >/tmp/bk-restore-1.log 2>&1; RC=$?; set -e
check "restore WITHOUT pre-creating the role is refused (so the order in the runbook matters)" "$([ $RC -ne 0 ] && echo refused || echo accepted)" "refused"
py "$TARGET_ADMIN_URL" "$DST_DB" <<'PY'
import sys, psycopg; from psycopg.conninfo import make_conninfo
psycopg.connect(sys.argv[1], autocommit=True).execute(f'DROP DATABASE "{sys.argv[2]}" WITH (FORCE)')
psycopg.connect(sys.argv[1], autocommit=True).execute(f'CREATE DATABASE "{sys.argv[2]}"')
# The runbook order: roles FIRST, with exactly the attributes migration 0001 demands.
psycopg.connect(sys.argv[1], autocommit=True).execute("CREATE ROLE safwan_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE")
PY
CREATED_ROLE=1
"$PG_BIN/pg_restore" --no-owner --exit-on-error --dbname="$DST" "$DUMP"
pass "restore succeeds once the role exists"

echo "── 4) the restored database is the same database, and still enforces the security design"
set +e
py "$DST" "$TARGET_ADMIN_URL" "$LOGIN" "$LIVE" "$DEAD" <<'PY'
import sys, psycopg
from uuid import UUID
from psycopg.conninfo import make_conninfo
from app.db.migrate import migrate
from app.db.connection import connect_runtime, OverPrivilegedRole
from app.auth.sessions import resolve_session, create_session
from app.db.scope import owner_transaction
dst, admin, login, live, dead = sys.argv[1:6]
A, B = UUID("11111111-1111-4111-8111-111111111111"), UUID("22222222-2222-4222-8222-222222222222")
ok = True
def check(name, cond):
    global ok; print(("PASS  " if cond else "FAIL  ") + name); ok &= bool(cond)

owner = psycopg.connect(dst, autocommit=True)
check("migrations are recorded and the runner is a no-op on the restored database", migrate(owner) == [])
check("row counts survived (accounts 2, sync_records 8, audit 1, sessions 2)",
      [owner.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("accounts", "sync_records", "audit_log", "sessions")] == [2, 8, 1, 2])
flags = {r[0]: (r[1], r[2]) for r in owner.execute("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'")}
check("RLS / FORCE flags are identical", flags == {"accounts": (True, False), "sessions": (True, False), "sync_records": (True, True),
                                                   "audit_log": (True, True), "service_nonces": (False, False), "schema_migrations": (False, False)})

psycopg.connect(admin, autocommit=True).execute(f"CREATE ROLE {login} LOGIN PASSWORD 'bk' IN ROLE safwan_app NOSUPERUSER NOBYPASSRLS")
rt = connect_runtime(make_conninfo(dst, user=login, password="bk"), production=True)
check("the recreated runtime login is accepted by the production guard", True)
try:
    connect_runtime(dst, production=True); check("the restoring superuser is refused as a runtime role", False)
except OverPrivilegedRole:
    check("the restoring superuser is refused as a runtime role", True)
check("a live session still resolves to its account", resolve_session(rt, live) == A)
check("a revoked session is STILL revoked after the restore", resolve_session(rt, dead) is None)
with owner_transaction(rt, A):
    check("account A sees only its own 5 rows", rt.execute("SELECT count(*) FROM sync_records").fetchone()[0] == 5)
with owner_transaction(rt, B):
    check("account B sees only its own 3 rows", rt.execute("SELECT count(*) FROM sync_records").fetchone()[0] == 3)
check("no scope => no rows", rt.execute("SELECT count(*) FROM sync_records").fetchone()[0] == 0)
privs = ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE")
got = {t: {p for p in privs if rt.execute("SELECT has_table_privilege(current_user,%s,%s)", (f"public.{t}", p)).fetchone()[0]}
       for t in ("accounts", "sessions", "sync_records", "audit_log", "service_nonces", "schema_migrations")}
check("runtime privilege set is exactly the intended one", got == {"accounts": {"SELECT"}, "sessions": {"SELECT", "INSERT"},
      "sync_records": {"SELECT", "INSERT", "UPDATE"}, "audit_log": {"SELECT", "INSERT"}, "service_nonces": set(), "schema_migrations": set()})
try:
    with owner_transaction(rt, B):  # B owns the revoked session; the trigger must survive the dump/restore
        rt.execute("UPDATE sessions SET revoked_at = NULL")
    check("revocation stays irreversible", False)
except psycopg.errors.CheckViolation:
    check("revocation stays irreversible", True)
sys.exit(0 if ok else 1)
PY
RC=$?; set -e
[ $RC -eq 0 ] && pass "all restored-database checks" || fail "restored-database checks"

echo; if [ "$FAILS" -eq 0 ]; then echo "REHEARSAL PASSED"; else echo "$FAILS CHECK(S) FAILED"; exit 1; fi
