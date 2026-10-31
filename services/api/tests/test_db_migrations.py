import hashlib
from pathlib import Path

import psycopg
import pytest

from app.db.migrate import MIGRATIONS_DIR, MigrationError, discover, migrate
from tests import pg_support


def test_discover_real_migrations_are_contiguous_and_checksummed():
    found = discover()
    assert [m.version for m in found][:2] == ["0001", "0002"]
    for m in found:
        assert m.checksum == hashlib.sha256((MIGRATIONS_DIR / m.filename).read_bytes()).hexdigest()


def test_discover_rejects_gaps_bad_names_and_duplicates(tmp_path: Path):
    (tmp_path / "0001_a.sql").write_text("SELECT 1;")
    (tmp_path / "0003_c.sql").write_text("SELECT 1;")
    with pytest.raises(MigrationError, match="contiguous"):
        discover(tmp_path)
    (tmp_path / "0003_c.sql").unlink()
    (tmp_path / "bad name.sql").write_text("SELECT 1;")
    with pytest.raises(MigrationError, match="bad migration filename"):
        discover(tmp_path)


def test_migrations_apply_once_and_are_idempotent():
    gen = pg_support.fresh_database(pg_support.admin_url())
    dsn = next(gen)
    try:
        with psycopg.connect(dsn, autocommit=True) as conn:
            assert migrate(conn)[:2] == ["0001", "0002"]
            assert migrate(conn) == []
            rows = conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
            assert [r[0] for r in rows][:2] == ["0001", "0002"]
    finally:
        next(gen, None)


def test_modified_applied_migration_is_refused():
    gen = pg_support.fresh_database(pg_support.admin_url())
    dsn = next(gen)
    try:
        with psycopg.connect(dsn, autocommit=True) as conn:
            migrate(conn)
            conn.execute("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '0001'")
            with pytest.raises(MigrationError, match="modified after being applied"):
                migrate(conn)
    finally:
        next(gen, None)


def test_database_ahead_of_build_is_refused():
    gen = pg_support.fresh_database(pg_support.admin_url())
    dsn = next(gen)
    try:
        with psycopg.connect(dsn, autocommit=True) as conn:
            migrate(conn)
            conn.execute("INSERT INTO schema_migrations (version, filename, checksum) VALUES ('9999', 'x.sql', 'x')")
            with pytest.raises(MigrationError, match="missing from this build"):
                migrate(conn)
    finally:
        next(gen, None)


def test_failed_migration_rolls_back_completely(tmp_path: Path):
    (tmp_path / "0001_ok.sql").write_text("CREATE TABLE t_ok (id int);")
    (tmp_path / "0002_bad.sql").write_text("CREATE TABLE t_half (id int); SELECT 1/0;")
    gen = pg_support.fresh_database(pg_support.admin_url())
    dsn = next(gen)
    try:
        with psycopg.connect(dsn, autocommit=True) as conn:
            with pytest.raises(psycopg.errors.DivisionByZero):
                migrate(conn, tmp_path)
            assert conn.execute("SELECT to_regclass('t_ok')").fetchone()[0] is not None  # 0001 stays applied
            assert conn.execute("SELECT to_regclass('t_half')").fetchone()[0] is None     # 0002 left no trace
            assert [r[0] for r in conn.execute("SELECT version FROM schema_migrations").fetchall()] == ["0001"]
    finally:
        next(gen, None)


def test_schema_security_properties(pg_owner):
    q = lambda sql: pg_owner.execute(sql).fetchall()  # noqa: E731
    role = q("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'safwan_app'")
    assert role == [(False, False, False)]  # not a superuser, cannot bypass RLS, cannot log in itself
    rls = dict(q("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('accounts','sessions','sync_records','audit_log')"))
    assert rls == {"accounts": True, "sessions": True, "sync_records": True, "audit_log": True}
    forced = dict(q("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('sync_records','audit_log')"))
    assert forced == {"sync_records": True, "audit_log": True}
    # SECURITY DEFINER functions pin their search_path (no schema-shadowing hijack).
    defs = q("SELECT proname, proconfig FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace ORDER BY 1")
    assert [d[0] for d in defs] == ["auth_claim_nonce", "auth_resolve_session"]
    assert all(d[1] and any(c.startswith("search_path=pg_catalog") and c.endswith("pg_temp") for c in d[1]) for d in defs)
    # PUBLIC has no execute right on them.
    pub = q("SELECT has_function_privilege('public', 'auth_resolve_session(bytea)', 'execute'),"
            " has_function_privilege('public', 'auth_claim_nonce(bytea,integer)', 'execute')")
    assert pub == [(False, False)]
