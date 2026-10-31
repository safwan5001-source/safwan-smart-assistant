"""Database-backed preview login throttling primitives; no public auth route.

The caller must provide a secret server-side key and use a transaction to
serialize attempts for a subject. Combine with IP/network protection before
launch; account buckets alone do not defend distributed enumeration.
"""
import hashlib
import hmac
from datetime import datetime, timezone

MAX_FAILURES = 5
WINDOW_SECONDS = 900
LOCK_SECONDS = 900

def subject_digest(normalized_email: str, server_key: bytes) -> bytes:
    if not isinstance(server_key, bytes) or len(server_key) < 32:
        raise ValueError("Strong server-side throttle key required")
    if not isinstance(normalized_email, str) or not normalized_email or len(normalized_email) > 320:
        raise ValueError("Invalid subject")
    return hmac.new(server_key, normalized_email.encode("utf-8"), hashlib.sha256).digest()

def attempt_permitted(connection, subject: bytes, now: datetime | None = None) -> bool:
    instant = now or datetime.now(timezone.utc)
    row = connection.execute(
        "SELECT failure_count, window_started_at, locked_until FROM login_attempt_buckets WHERE subject_key=%s FOR UPDATE",
        (subject,),
    ).fetchone()
    return row is None or row[2] is None or row[2] <= instant

def record_failed_attempt(connection, subject: bytes) -> None:
    """Call inside a transaction; PostgreSQL ON CONFLICT serializes writers."""
    connection.execute(
        """INSERT INTO login_attempt_buckets (subject_key, failure_count, window_started_at, locked_until)
           VALUES (%s,1,now(),NULL)
           ON CONFLICT (subject_key) DO UPDATE SET
             failure_count=CASE
               WHEN login_attempt_buckets.window_started_at <= now() - interval '15 minutes'
                 THEN 1 ELSE login_attempt_buckets.failure_count + 1 END,
             window_started_at=CASE
               WHEN login_attempt_buckets.window_started_at <= now() - interval '15 minutes'
                 THEN now() ELSE login_attempt_buckets.window_started_at END,
             locked_until=CASE
               WHEN login_attempt_buckets.window_started_at <= now() - interval '15 minutes' THEN NULL
               WHEN login_attempt_buckets.failure_count + 1 >= 5 THEN now() + interval '15 minutes'
               ELSE login_attempt_buckets.locked_until END""",
        (subject,),
    )

def reset_failures(connection, subject: bytes) -> None:
    connection.execute("DELETE FROM login_attempt_buckets WHERE subject_key=%s",(subject,))
