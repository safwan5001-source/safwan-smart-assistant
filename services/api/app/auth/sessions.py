"""Server-side session core (ported from Phase 5 after security review).

What changed versus Phase 5 (see docs/B1-SECURITY-REVIEW.md):
  * expiry is judged by the DATABASE clock inside `auth_resolve_session`, not by the app clock;
  * accounts and sessions are under row-level security; creation/revocation run in an owner scope;
  * TTL is 12 hours by default and 30 days when the owner chooses "remember this device" (A1);
  * the secret is never stored, only its SHA-256, and malformed secrets are rejected before any query;
  * an optional `pepper` keys that hash (HMAC-SHA256): owner sessions use a fingerprint of the owner code, so rotating the code
    makes every older session unresolvable (security review M3). Same 32-byte column, no schema change.
HTTP entry points (owner code, passkeys) live in app/auth/owner.py (A1).
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta
from uuid import UUID

import psycopg

from ..db.scope import owner_transaction, verified_account_id

SESSION_DEFAULT_TTL = timedelta(hours=12)
SESSION_REMEMBER_TTL = timedelta(days=30)
_SECRET_RE = re.compile(r"[A-Za-z0-9_-]{43}")  # token_urlsafe(32) is exactly 43 chars


def issue_secret() -> str:
    return secrets.token_urlsafe(32)


def digest_secret(secret: str, pepper: bytes | None = None) -> bytes:
    if not isinstance(secret, str) or not _SECRET_RE.fullmatch(secret):
        raise ValueError("invalid session secret")
    if pepper:
        return hmac.new(pepper, secret.encode("ascii"), hashlib.sha256).digest()
    return hashlib.sha256(secret.encode("ascii")).digest()


def create_session(conn: psycopg.Connection, account_id: UUID, *, remember: bool = False, device: str | None = None,
                   pepper: bytes | None = None) -> tuple[str, datetime]:
    """Create a session for an account the CALLER has already authenticated. Returns (secret, expires_at).
    `device` is a short display name of the device (never used for any decision)."""
    account_id = verified_account_id(account_id)
    device = _device_label(device)
    ttl = SESSION_REMEMBER_TTL if remember else SESSION_DEFAULT_TTL
    secret = issue_secret()
    with owner_transaction(conn, account_id):
        active = conn.execute("SELECT 1 FROM accounts WHERE id = %s AND disabled_at IS NULL", (account_id,)).fetchone()
        if active is None:
            raise PermissionError("account unavailable")
        row = conn.execute(
            "INSERT INTO sessions (account_id, token_hash, remember, expires_at, device_label) "
            "VALUES (%s, %s, %s, now() + make_interval(secs => %s), %s) RETURNING expires_at",
            (account_id, digest_secret(secret, pepper), remember, int(ttl.total_seconds()), device),
        ).fetchone()
    assert row is not None
    return secret, row[0]


def resolve_session(conn: psycopg.Connection, secret: str | None, *, pepper: bytes | None = None) -> UUID | None:
    """Return the owning account id, or None for anything unknown, malformed, expired, revoked or disabled."""
    if not secret:
        return None
    try:
        token_hash = digest_secret(secret, pepper)
    except ValueError:
        return None
    row = conn.execute("SELECT auth_resolve_session(%s)", (token_hash,)).fetchone()
    return row[0] if row and row[0] is not None else None


def revoke_session(conn: psycopg.Connection, account_id: UUID, secret: str, *, pepper: bytes | None = None) -> bool:
    """Revoke one session. Scoped to `account_id`, so a token can never be revoked for another account."""
    try:
        token_hash = digest_secret(secret, pepper)
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


def _device_label(v: str | None) -> str | None:
    if not isinstance(v, str):
        return None
    t = " ".join("".join(ch for ch in v if ch.isprintable()).split())[:80]
    return t or None


def list_sessions(conn: psycopg.Connection, account_id: UUID, current_secret: str, *, pepper: bytes | None = None) -> list[dict]:
    """The account's live sessions (not revoked, not expired), most recently used first; `current` marks the caller's own."""
    current = digest_secret(current_secret, pepper)
    with owner_transaction(conn, verified_account_id(account_id)):
        rows = conn.execute(
            "SELECT id, device_label, remember, created_at, last_seen_at, expires_at, token_hash = %s "
            "FROM sessions WHERE revoked_at IS NULL AND expires_at > now() "
            "ORDER BY coalesce(last_seen_at, created_at) DESC LIMIT 50", (current,)).fetchall()
    return [{"id": str(r[0]), "device": r[1], "remember": r[2], "created_at": r[3].isoformat(),
             "last_seen_at": r[4].isoformat() if r[4] else None, "expires_at": r[5].isoformat(), "current": r[6]} for r in rows]


def revoke_session_by_id(conn: psycopg.Connection, account_id: UUID, session_id: UUID, current_secret: str, *,
                         pepper: bytes | None = None) -> bool | None:
    """End one session of this account by its id (from list_sessions). Another account's id matches nothing (RLS).
    Returns None when nothing was ended, else whether it was the caller's OWN session (so the caller signs out too)."""
    current = digest_secret(current_secret, pepper)
    with owner_transaction(conn, verified_account_id(account_id)):
        row = conn.execute("UPDATE sessions SET revoked_at = now() WHERE id = %s AND revoked_at IS NULL RETURNING token_hash = %s",
                           (session_id, current)).fetchone()
    return None if row is None else bool(row[0])


def touch_session(conn: psycopg.Connection, account_id: UUID, secret: str, *, pepper: bytes | None = None) -> None:
    """Record activity, at most every 5 minutes per session (the BFF already caches lookups for 15 s)."""
    with owner_transaction(conn, verified_account_id(account_id)):
        conn.execute("UPDATE sessions SET last_seen_at = now() WHERE token_hash = %s "
                     "AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')", (digest_secret(secret, pepper),))
