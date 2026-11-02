"""Service-to-service authentication for the BFF -> API hop (HMAC-SHA256, replay-protected, fail-closed).

Why: a private network (Railway `*.railway.internal`) or a Vercel Service Binding only makes the API *reachable* from the web
service; neither authenticates the caller, and anything else in the same project/network could also reach it.
Every call into /internal/* must therefore prove, per request:
  * it came from a holder of SERVICE_AUTH_SECRET            -> signature
  * it is fresh                                              -> timestamp within +-60s
  * it was not captured and re-sent                          -> single-use nonce (PostgreSQL, shared by all instances)
  * method, path+query, body and acting account are exactly what was signed -> canonical string

The wire contract is pinned by shared/service-signature-vectors.json, verified by pytest and vitest.
All authentication failures return the SAME 401 body (no oracle); the precise reason is only logged.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from fastapi import Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .browser_token import collides_with_service_secret
from .config import Settings, get_settings
from .db.connection import DatabaseUnavailable, connect_runtime

log = logging.getLogger("safwan.service_auth")

SKEW_SECONDS = 60
NONCE_TTL_SECONDS = 180          # must outlive the accepted timestamp window (2 x skew)
MAX_BODY_BYTES = 1_048_576
BODY_READ_DEADLINE_SECONDS = 10.0   # a slow-loris body must not keep an authentication attempt open
MIN_SECRET_BYTES = 32
CONTEXT = "safwan-svc-v1"
H_TS, H_NONCE, H_SIG, H_ACCT = "x-svc-ts", "x-svc-nonce", "x-svc-sig", "x-svc-acct"
_NONCE_RE = re.compile(r"[A-Za-z0-9_-]{22,64}")  # used with fullmatch: `$` would also accept a trailing newline
_SIG_RE = re.compile(r"[0-9a-f]{64}")
_CL_RE = re.compile(r"[0-9]{1,12}")  # Content-Length: ASCII digits only ('²'.isdigit() is True and int() would then raise)
_TS_RE = re.compile(r"[0-9]{1,12}")  # ASCII only: str.isdigit() is True for e.g. '²', and int() then raises


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


# ── configuration diagnostics: a CATEGORY and booleans, never the value and never its exact length ───────────────────
# Why: "no valid SERVICE_AUTH_SECRET" used to cover three different operator mistakes (unset / empty / shorter than the minimum), so a
# production 503 could not be narrowed down without reading a Sealed value that nobody can read. Quotes, spaces or a newline do NOT
# produce that message (they only lengthen the value; they make the two services disagree -> `bad signature`), so they are reported
# as separate flags.
def secret_status(name: str) -> str:
    raw = os.environ.get(name)
    if raw is None:
        return "unset"
    if raw == "":
        return "empty"
    if raw.strip() == "":
        return "blank"
    if len(raw.encode("utf-8")) < MIN_SECRET_BYTES:
        return "below_minimum_length"
    return "ok"


def secret_shape(name: str) -> dict[str, bool]:
    raw = os.environ.get(name) or ""
    return {
        "edge_whitespace": raw != raw.strip(),
        "wrapped_in_quotes": len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'`",
        "contains_newline": "\n" in raw or "\r" in raw,
    }


def _describe(name: str) -> str:
    shape = secret_shape(name)
    return f"status={secret_status(name)} " + " ".join(f"{k}={v}" for k, v in shape.items())


def log_service_auth_config() -> None:
    """One line at startup so an operator can verify the variables before any traffic. Category + booleans only."""
    logging.getLogger("uvicorn.error").info(
        "service auth config: secret=%s previous=%s collides_with_browser_token=%s",
        secret_status("SERVICE_AUTH_SECRET"), secret_status("SERVICE_AUTH_SECRET_PREVIOUS"), collides_with_service_secret(),
    )


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
        raise _unavailable(f"no valid SERVICE_AUTH_SECRET ({_describe('SERVICE_AUTH_SECRET')})", "service_auth_unconfigured")
    # The browser worker holds BROWSER_SERVICE_TOKEN and renders untrusted content: if it equalled a signing secret it could forge
    # BFF calls (independent review IR-A3). Fail closed instead of letting the two mechanisms become interchangeable.
    if collides_with_service_secret():
        raise _unavailable("SERVICE_AUTH_SECRET equals BROWSER_SERVICE_TOKEN", "service_auth_unconfigured")
    if store is None:
        raise _unavailable("no nonce store (APP_DATABASE_URL missing)", "service_auth_unavailable")

    h = request.headers
    # A repeated service header is ambiguous (this code reads the first value, some proxies the last). Never guess which copy
    # was signed: refuse. The BFF never sends duplicates, so a duplicate is always either a bug or an injection attempt.
    if any(len(h.getlist(name)) > 1 for name in (H_TS, H_NONCE, H_SIG, H_ACCT)):
        raise _deny("duplicate header")
    ts_raw, nonce, sig, acct = h.get(H_TS), h.get(H_NONCE), h.get(H_SIG), h.get(H_ACCT)
    if not ts_raw or not nonce or not sig:
        raise _deny("missing headers")
    if not _TS_RE.fullmatch(ts_raw) or not _NONCE_RE.fullmatch(nonce) or not _SIG_RE.fullmatch(sig):
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
    if declared and _CL_RE.fullmatch(declared) and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail={"code": "payload_too_large"})
    try:
        async with asyncio.timeout(BODY_READ_DEADLINE_SECONDS):
            body = await _read_body_limited(request)
    except TimeoutError:
        raise HTTPException(status_code=408, detail={"code": "request_timeout"}) from None

    target = request.url.path + (("?" + request.url.query) if request.url.query else "")
    message = canonical(request.method, target, ts, nonce, body_sha256(body), acct.lower() if acct else None)
    # Compare against every configured key without short-circuiting (rotation window).
    matched = False
    for key in keys:
        expected = hmac.new(key, message, hashlib.sha256).hexdigest()
        matched |= hmac.compare_digest(expected, sig)
    if not matched:
        raise _deny("bad signature")

    # Freshness must hold at the moment the nonce is claimed, not only when the headers arrived: otherwise a captured request
    # whose body is delivered slowly could outlive the nonce's retention (NONCE_TTL > 2 x SKEW) and be accepted twice.
    if abs(time.time() - ts) > SKEW_SECONDS:
        raise _deny("timestamp outside window at claim time")
    # Only authenticated requests may consume nonce storage (no unauthenticated write amplification).
    try:
        # psycopg is synchronous: never run it on the event loop (a slow DB must not stall unrelated requests).
        fresh = await run_in_threadpool(store.claim, nonce, NONCE_TTL_SECONDS)
    except (DatabaseUnavailable, Exception) as exc:  # noqa: BLE001 - any store failure must fail closed
        raise _unavailable(f"nonce store error: {type(exc).__name__}", "service_auth_unavailable") from None
    if not fresh:
        raise _deny("replayed nonce")
    return ServiceCall(account_id=account)
