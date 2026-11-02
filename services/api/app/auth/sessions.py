"""Server-side session core (ported from Phase 5 after security review).

What changed versus Phase 5 (see docs/B1-SECURITY-REVIEW.md):
  * expiry is judged by the DATABASE clock inside `auth_resolve_session`, not by the app clock;
  * accounts and sessions are under row-level security; creation/revocation run in an owner scope;
  * TTL is 7 days by default and 30 days for "remember me" (was capped at 7 days);
  * the secret is never stored, only its SHA-256, and malformed secrets are rejected before any query.
There is deliberately NO HTTP endpoint here: login arrives with the passkey work in B2.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from datetime import datetime, timedelta
from uuid import UUID

import psycopg

from ..db.scope import owner_transaction, verified_account_id

SESSION_DEFAULT_TTL = timedelta(days=7)
SESSION_REMEMBER_TTL = timedelta(days=30)
_SECRET_RE = re.compile(r"[A-Za-z0-9_-]{43}")  # token_urlsafe(32) is exactly 43 chars


def issue_secret() -> str:
    return secrets.token_urlsafe(32)


def digest_secret(secret: str) -> bytes:
    if not isinstance(secret, str) or not _SECRET_RE.fullmatch(secret):
        raise ValueError("invalid session secret")
    return hashlib.sha256(secret.encode("ascii")).digest()


def create_session(conn: psycopg.Connection, account_id: UUID, *, remember: bool = False) -> tuple[str, datetime]:
    """Create a session for an account the CALLER has already authenticated. Returns (secret, expires_at)."""
    account_id = verified_account_id(account_id)
    ttl = SESSION_REMEMBER_TTL if remember else SESSION_DEFAULT_TTL
    secret = issue_secret()
    with owner_transaction(conn, account_id):
        active = conn.execute("SELECT 1 FROM accounts WHERE id = %s AND disabled_at IS NULL", (account_id,)).fetchone()
        if active is None:
            raise PermissionError("account unavailable")
        row = conn.execute(
            "INSERT INTO sessions (account_id, token_hash, remember, expires_at) "
            "VALUES (%s, %s, %s, now() + make_interval(secs => %s)) RETURNING expires_at",
            (account_id, digest_secret(secret), remember, int(ttl.total_seconds())),
        ).fetchone()
    assert row is not None
    return secret, row[0]


def resolve_session(conn: psycopg.Connection, secret: str | None) -> UUID | None:
    """Return the owning account id, or None for anything unknown, malformed, expired, revoked or disabled."""
    if not secret:
        return None
    try:
        token_hash = digest_secret(secret)
    except ValueError:
        return None
    row = conn.execute("SELECT auth_resolve_session(%s)", (token_hash,)).fetchone()
    return row[0] if row and row[0] is not None else None


def revoke_session(conn: psycopg.Connection, account_id: UUID, secret: str) -> bool:
    """Revoke one session. Scoped to `account_id`, so a token can never be revoked for another account."""
    try:
        token_hash = digest_secret(secret)
    except ValueError:
        return False
    with owner_transaction(conn, verified_account_id(account_id)):
        cur = conn.execute(
            "UPDATE sessions SET revoked_at = now() WHERE token_hash = %s AND revoked_at IS NULL", (token_hash,)
        )
        return cur.rowcount == 1


def revoke_all_sessions(conn: psycopg.Connection, account_id: UUID) -> int:
    with owner_transaction(conn, verified_account_id(account_id)):
        return conn.execute("UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL").rowcount
