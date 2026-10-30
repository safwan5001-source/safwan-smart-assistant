"""Internal read-only PostgreSQL connectivity probe.

No HTTP endpoint is exposed. Run only in an authorized Preview worker.
Do not log connection URLs, query errors, account data, or secrets.
"""
import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

def tls_database_url(url: str) -> str:
    from .database_settings import DatabaseSettings
    # Fail closed on malformed settings; normalize TLS without exposing credentials.
    parts=urlsplit(url)
    items=[(k,v) for k,v in parse_qsl(parts.query,keep_blank_values=True) if k!="sslmode"]
    items.append(("sslmode","verify-full"))
    safe=urlunsplit((parts.scheme,parts.netloc,parts.path,urlencode(items),parts.fragment))
    DatabaseSettings(safe).validate(production=True)
    return safe

def probe_neon(connection_factory, env=None) -> bool:
    """Requires injected connection_factory compatible with psycopg.connect."""
    variables=os.environ if env is None else env
    if variables.get("VERCEL_ENV")!="preview":
        raise PermissionError("Preview-only database probe")
    raw=variables.get("DATABASE_URL")
    if not raw:
        raise RuntimeError("Preview database not configured")
    # Bounded connection; only SELECT 1, no schema writes.
    with connection_factory(tls_database_url(raw),connect_timeout=5) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            return cur.fetchone()==(1,)
