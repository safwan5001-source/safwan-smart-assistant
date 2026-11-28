"""BASHT bridge request signing ("basht-bridge-v1"), client side.

Every call from this service to the engine's app bridge (`{BASHT_CORE_URL}/app/v1/*`) may carry four extra headers that prove
the request came from the holder of BASHT_BRIDGE_SIGNING_SECRET and was not altered or replayed:

    X-Basht-Timestamp       integer seconds
    X-Basht-Nonce           24 url-safe random characters
    X-Basht-Content-SHA256  hex sha256 of the exact body bytes (of b"" when there is none)
    X-Basht-Signature       "v1=" + hex(HMAC-SHA256(secret, canonical))

    canonical = "\\n".join(["basht-bridge-v1", METHOD, target, timestamp, nonce, content_sha256])
    target    = the request-target exactly as sent on the wire: "/app/v1" + path, INCLUDING the query string.

The secret is optional. Unset, or shorter than MIN_SECRET characters, the call is sent unsigned (an engine that does not require
signatures accepts it as before; an engine that does require them answers 401 and the app reports it as unavailable).
The secret is never logged, audited, put in an error or placed in a header value (only its HMAC leaves this module).
Wire contract: tests/fixtures/bridge-signing-vectors.json (shared with the engine's verifier).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from typing import Callable, Mapping
from urllib.request import Request

ENV_VAR = "BASHT_BRIDGE_SIGNING_SECRET"
MIN_SECRET = 32
SPEC = "basht-bridge-v1"
API_PREFIX = "/app/v1"
H_TS, H_NONCE, H_SHA, H_SIG = "X-Basht-Timestamp", "X-Basht-Nonce", "X-Basht-Content-SHA256", "X-Basht-Signature"
HEADER_NAMES = (H_TS, H_NONCE, H_SHA, H_SIG)


def _secret(env: Mapping[str, str]) -> bytes | None:
    s = (env.get(ENV_VAR) or "").strip()
    return s.encode("utf-8") if len(s) >= MIN_SECRET else None


def canonical(method: str, target: str, timestamp: int, nonce: str, content_sha256: str) -> bytes:
    return "\n".join([SPEC, method.upper(), target, str(timestamp), nonce, content_sha256]).encode("utf-8")


def sign_headers(method: str, target: str, body: bytes | None = None, *, env: Mapping[str, str] = os.environ,
                 now: Callable[[], float] = time.time, nonce: str | None = None) -> dict[str, str]:
    """The four signature headers for one request, or {} when signing is not configured. `target` is the request-target as sent."""
    key = _secret(env)
    if key is None:
        return {}
    ts = int(now())
    n = nonce if nonce is not None else secrets.token_urlsafe(18)  # 18 random bytes -> 24 url-safe characters
    digest = hashlib.sha256(body or b"").hexdigest()
    sig = hmac.new(key, canonical(method, target, ts, n, digest), hashlib.sha256).hexdigest()
    return {H_TS: str(ts), H_NONCE: n, H_SHA: digest, H_SIG: f"v1={sig}"}


def engine_request(base: str, path: str, *, method: str, data: bytes | None, headers: dict[str, str],
                   env: Mapping[str, str] = os.environ) -> Request:
    """THE way to build a request to the engine's app bridge: URL, headers and (when configured) the signature in one place.
    `path` is appended to `{base}/app/v1` exactly as given (query string included); what is signed is the built request's own target."""
    req = Request(f"{base}{API_PREFIX}{path}", data=data, method=method, headers=headers)
    # sign the request-target actually put on the wire (path + query of the constructed URL), so it stays right even if
    # BASHT_CORE_URL carries a path prefix; never re-derived from `path`
    for k, v in sign_headers(method, req.selector, data, env=env).items():
        req.add_header(k, v)
    return req


def ensure_signed(req: Request, env: Mapping[str, str] = os.environ) -> Request:
    """Backstop at the single network seam: a request to the bridge that was built without `engine_request` is signed here."""
    if req.has_header(H_SIG.capitalize()):  # urllib stores header names capitalized
        return req
    target = req.selector  # path + query exactly as put on the wire
    if not target.startswith(API_PREFIX + "/"):
        return req
    for k, v in sign_headers(req.get_method(), target, req.data if isinstance(req.data, (bytes, bytearray)) else None, env=env).items():
        req.add_header(k, v)
    return req


