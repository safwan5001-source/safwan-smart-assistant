import pytest
from fastapi.testclient import TestClient

from app.audit import audit_log
from app.main import app


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    """Tests run as a non-production environment with no experimental auth unless a test opts in."""
    monkeypatch.setenv("APP_ENV", "test")
    for var in ("ENABLE_DEV_AUTH", "DEV_AUTH_TOKEN", "ASSISTANT_PROVIDER", "VERCEL_ENV"):
        monkeypatch.delenv(var, raising=False)
    audit_log.clear()


@pytest.fixture
def client():
    return TestClient(app)


# ── PostgreSQL fixtures (real database; see tests/pg_support.py) ─────────────
import psycopg  # noqa: E402

from tests import pg_support  # noqa: E402


@pytest.fixture(scope="session")
def pg_dsn():
    base = pg_support.admin_url()
    gen = pg_support.fresh_database(base)
    dsn = next(gen)
    conn = pg_support.migrated_conn(dsn)
    conn.close()
    yield dsn
    next(gen, None)


@pytest.fixture
def pg_owner(pg_dsn):
    """Superuser/owner connection: arranges data and inspects state, bypassing RLS on purpose."""
    conn = psycopg.connect(pg_dsn, autocommit=True)
    conn.execute("TRUNCATE accounts, service_nonces CASCADE")
    yield conn
    conn.close()


@pytest.fixture
def pg_app(pg_dsn, pg_owner):
    """Connection acting as the restricted application role (RLS applies)."""
    conn = pg_support.runtime_connection(pg_dsn)
    yield conn
    conn.close()


@pytest.fixture(scope="session")
def pg_runtime_dsn(pg_dsn):
    """A LOGIN role that is merely a member of safwan_app: what production should connect as."""
    from psycopg.conninfo import make_conninfo

    with psycopg.connect(pg_dsn, autocommit=True) as c:
        c.execute(
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='safwan_login') THEN "
            "CREATE ROLE safwan_login LOGIN PASSWORD 'ci-only' IN ROLE safwan_app NOSUPERUSER NOBYPASSRLS; END IF; END $$"
        )
    return make_conninfo(pg_dsn, user="safwan_login", password="ci-only")
