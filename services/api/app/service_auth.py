"""Service-to-service authentication for the BFF -> API hop (HMAC-SHA256, replay-protected, fail-closed).

Why: a Vercel Service Binding makes the API *reachable* from the web service but does not
authenticate the caller (Vercel docs). Every call into /internal/* must therefore prove, per request:
  * it came from a holder of SERVICE_AUTH_SECRET            -> signature
  * it is fresh                                              -> timestamp within +-60s
  * it was not captured and re-sent                          -> single-use nonce (PostgreSQL, shared by all instances)
  * method, path+query, body and acting account are exactly what was signed -> canonical string

The wire contract is pinned by shared/service-signature-vectors.json, verified by pytest and vitest.
All authentication failures return the SAME 401 body (no oracle); the precise reason is only logged.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from fastapi import Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .config import Settings, get_settings
from .db.connection import DatabaseUnavailable, connect_runtime

log = logging.getLogger("safwan.service_auth")

SKEW_SECONDS = 60
NONCE_TTL_SECONDS = 180          # must outlive the accepted timestamp window (2 x skew)
MAX_BODY_BYTES = 1_048_576
MIN_SECRET_BYTES = 32
CONTEXT = "safwan-svc-v1"
H_TS, H_NONCE, H_SIG, H_ACCT = "x-svc-ts", "x-svc-nonce", "x-svc-sig", "x-svc-acct"
_NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{22,64}$")
_SIG_RE = re.compile(r"^[0-9a-f]{64}$")


def body_sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical(method: str, target: str, ts: int, nonce: str, body_hash: str, account: str | None) -> bytes:
    return "\n".join([CONTEXT, method.upper(), target, str(ts), nonce, body_hash, account or "-"]).encode("utf-8")


def sign(secret: bytes, method: str, target: str, ts: int, nonce: str, body: bytes, account: str | None = None) -> str:
    return hmac.new(secret, canonical(method, target, ts, nonce, body_sha256(body), account), hashlib.sha256).hexdigest()


# ── nonce stores ────────────────────────────────────────────────────────────
class NonceStore(Protocol):
    def claim(self, nonce: str, ttl_seconds: int) -> bool: ...


class MemoryNonceStore:
    """Single-process only (tests / local dev). Never selectable in production."""

    def __init__(self, max_entries: int = 10_000) -> None:
        self._seen: dict[bytes, float] = {}
        self._lock = threading.Lock()
        self._max = max_entries

    def claim(self, nonce: str, ttl_seconds: int) -> bool:
        key, now = hashlib.sha256(nonce.encode()).digest(), time.monotonic()
        with self._lock:
            if len(self._seen) >= self._max:
                self._seen = {k: v for k, v in self._seen.items() if v > now}
                if len(self._seen) >= self._max:
                    raise DatabaseUnavailable("nonce store full")  # fail closed rather than forget nonces
            if self._seen.get(key, 0) > now:
                return False
            self._seen[key] = now + ttl_seconds
            return True


class PostgresNonceStore:
    def __init__(self, url: str, *, production: bool = True) -> None:
        self._url = url
        self._production = production

    def claim(self, nonce: str, ttl_seconds: int) -> bool:
        with connect_runtime(self._url, production=self._production, application_name="safwan-svc-auth", timeout=3) as conn:
            row = conn.execute(
                "SELECT auth_claim_nonce(%s, %s)", (hashlib.sha256(nonce.encode()).digest(), ttl_seconds)
            ).fetchone()
        return bool(row and row[0])


_memory_store = MemoryNonceStore()


def get_nonce_store(settings: Settings = Depends(get_settings)) -> NonceStore | None:
    if settings.service_nonce_store == "memory" and not settings.is_production:
        return _memory_store
    return PostgresNonceStore(settings.database_url, production=settings.is_production) if settings.database_url else None


# ── the dependency ──────────────────────────────────────────────────────────
@dataclass(frozen=True)
class ServiceCall:
    account_id: UUID | None


def _deny(reason: str) -> HTTPException:
    log.warning("service auth denied: %s", reason)  # never log headers, signatures or secrets
    return HTTPException(status_code=401, detail={"code": "service_auth_failed"})


def _unavailable(reason: str, code: str) -> HTTPException:
    log.error("service auth unavailable: %s", reason)
    return HTTPException(status_code=503, detail={"code": code})


def _secrets(settings: Settings) -> list[bytes]:
    out = [s.encode("utf-8") for s in (settings.service_auth_secret, settings.service_auth_secret_previous) if s]
    return [s for s in out if len(s) >= MIN_SECRET_BYTES]


async def _read_body_limited(request: Request) -> bytes:
    """Read the body incrementally and stop as soon as the limit is exceeded. `request.body()` would buffer an entire
    chunked upload (no Content-Length) before any size check, letting an unsigned caller exhaust worker memory."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail={"code": "payload_too_large"})
        chunks.append(chunk)
    body = b"".join(chunks)
    request._body = body  # type: ignore[attr-defined]  # let the route handler read it again (Starlette's own cache slot)
    return body


async def require_service_call(
    request: Request,
    settings: Settings = Depends(get_settings),
    store: NonceStore | None = Depends(get_nonce_store),
) -> ServiceCall:
    keys = _secrets(settings)
    if not keys or not settings.service_auth_secret or len(settings.service_auth_secret.encode()) < MIN_SECRET_BYTES:
        raise _unavailable("no valid SERVICE_AUTH_SECRET", "service_auth_unconfigured")
    if store is None:
        raise _unavailable("no nonce store (APP_DATABASE_URL missing)", "service_auth_unavailable")

    h = request.headers
    ts_raw, nonce, sig, acct = h.get(H_TS), h.get(H_NONCE), h.get(H_SIG), h.get(H_ACCT)
    if not ts_raw or not nonce or not sig:
        raise _deny("missing headers")
    if not ts_raw.isdigit() or len(ts_raw) > 12 or not _NONCE_RE.match(nonce) or not _SIG_RE.match(sig):
        raise _deny("malformed headers")
    ts = int(ts_raw)
    if abs(time.time() - ts) > SKEW_SECONDS:
        raise _deny("timestamp outside window")
    account: UUID | None = None
    if acct is not None:
        try:
            account = UUID(acct)
        except ValueError:
            raise _deny("malformed account") from None
        if account.int == 0 or str(account) != acct.lower():
            raise _deny("malformed account")

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail={"code": "payload_too_large"})
    body = await _read_body_limited(request)

    target = request.url.path + (("?" + request.url.query) if request.url.query else "")
    message = canonical(request.method, target, ts, nonce, body_sha256(body), acct.lower() if acct else None)
    # Compare against every configured key without short-circuiting (rotation window).
    matched = False
    for key in keys:
        expected = hmac.new(key, message, hashlib.sha256).hexdigest()
        matched |= hmac.compare_digest(expected, sig)
    if not matched:
        raise _deny("bad signature")

    # Only authenticated requests may consume nonce storage (no unauthenticated write amplification).
    try:
        # psycopg is synchronous: never run it on the event loop (a slow DB must not stall unrelated requests).
        fresh = await run_in_threadpool(store.claim, nonce, NONCE_TTL_SECONDS)
    except (DatabaseUnavailable, Exception) as exc:  # noqa: BLE001 - any store failure must fail closed
        raise _unavailable(f"nonce store error: {type(exc).__name__}", "service_auth_unavailable") from None
    if not fresh:
        raise _deny("replayed nonce")
    return ServiceCall(account_id=account)
