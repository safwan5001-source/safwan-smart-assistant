"""Request-body ceilings for the private /internal/* surface, enforced BEFORE the application can buffer anything.

Why: FastAPI reads and validates a declared body before it resolves dependencies or runs the handler body, so an authentication
check written inside a handler (or a dependency) cannot stop an unauthenticated caller from making the process buffer an arbitrarily
large body (independent review IR-A1: ~300 MiB sent without credentials pushed the API to ~1.3 GB RSS).

This is NOT an authentication layer and exempts nothing: it only ever REJECTS (413). Credentials are still checked by each route's
own mechanism (service signature on /internal/v1/*, bearer token on /internal/browser/*).

How: a declared Content-Length above the cap is answered 413 without invoking the application. A body without (or lying about) its
length is counted as it streams; the moment the cap is exceeded a 413 is sent and the application is told the client disconnected, so
it never receives the oversized body and the handler never runs. At most one chunk beyond the cap is ever read.
"""
from __future__ import annotations

import json
import re

_DIGITS = re.compile(rb"[0-9]{1,12}")  # ASCII only: bytes.isdigit() is already ASCII, but be explicit and bound the length
_BODY = json.dumps({"detail": {"code": "payload_too_large"}}).encode()
_HEADERS = [(b"content-type", b"application/json"), (b"content-length", str(len(_BODY)).encode()), (b"connection", b"close")]


class BodyLimitMiddleware:
    """Pure ASGI (no BaseHTTPMiddleware: it would buffer streamed bodies itself).

    `limits` is a list of (path prefix, max bytes); the longest matching prefix wins. Paths with no match are untouched."""

    def __init__(self, app, limits: list[tuple[str, int]]) -> None:
        self.app = app
        self.limits = sorted(limits, key=lambda item: len(item[0]), reverse=True)

    def _limit_for(self, path: str) -> int | None:
        for prefix, cap in self.limits:
            if path.startswith(prefix):
                return cap
        return None

    def _cap_for(self, scope) -> int | None:
        """Cap for this request. Under `uvicorn --root-path /api` the server puts the prefix INTO scope["path"] while Starlette's router
        strips it before matching, so the path is tried both as given and with root_path removed; the stricter cap wins (re-review IR-R1)."""
        path = scope.get("path", "")
        candidates = [path]
        root = scope.get("root_path") or ""
        if root and path.startswith(root):
            candidates.append(path[len(root):])
        caps = [c for c in (self._limit_for(p) for p in candidates) if c is not None]
        return min(caps) if caps else None

    async def __call__(self, scope, receive, send):
        cap = self._cap_for(scope) if scope["type"] == "http" else None
        if cap is None:
            await self.app(scope, receive, send)
            return

        async def reject():
            await send({"type": "http.response.start", "status": 413, "headers": _HEADERS})
            await send({"type": "http.response.body", "body": _BODY})

        for name, value in scope.get("headers", []):
            if name == b"content-length":
                if _DIGITS.fullmatch(value) and int(value) > cap:
                    await reject()
                    return
                break

        total = 0
        started = False  # the application already began a response: too late to replace it
        rejected = False

        async def limited_receive():
            nonlocal total, rejected
            if rejected:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > cap:
                    rejected = True
                    if not started:
                        await reject()
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message):
            nonlocal started
            if rejected:
                return  # our 413 is already on the wire: swallow whatever the application says after the disconnect
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            # After we rejected, the application sees a client disconnect and may raise (e.g. starlette ClientDisconnect out of a
            # dependency that was reading the body). The client already has its 413; do not turn it into a traceback per request
            # (re-review IR-R2: unauthenticated log amplification). Anything raised when we did NOT reject propagates unchanged.
            if not rejected:
                raise
