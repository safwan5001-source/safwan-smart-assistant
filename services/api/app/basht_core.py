"""BASHT Core Integration, step C1: BASHT's status, read from the engine's EXISTING public health endpoint.

`GET {BASHT_CORE_URL}/healthz` on the OpenClaw wrapper (openclaw-railway-template, src/server.js) answers
`{"ok": true, "gateway": "ready" | "starting" | "unconfigured"}` with no authentication. Nothing is changed on the engine,
no credential is used or stored, and only a coarse state leaves this module:

  unconfigured - BASHT_CORE_URL is not set (the app behaves exactly as before)
  connected    - the engine's gateway is ready
  starting     - the engine is up, its gateway is starting
  offline      - anything else: unreachable, timeout, non-HTTPS URL, unexpected answer (fail closed)

One probe per CACHE_SECONDS per process (the public /health of both tiers is polled), 3 s timeout, 4 KiB answer cap.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Callable, Literal, Mapping
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

CoreState = Literal["unconfigured", "connected", "starting", "offline"]
ENV_VAR = "BASHT_CORE_URL"
CACHE_SECONDS = 60.0
TIMEOUT_SECONDS = 3.0
MAX_BYTES = 4096

_lock = threading.Lock()
_cache: dict[str, tuple[float, CoreState]] = {}


def _probe(base: str) -> CoreState:
    url = urlparse(base)
    if url.scheme != "https" or not url.netloc or url.username or url.password:
        return "offline"
    req = Request(base.rstrip("/") + "/healthz", headers={"Accept": "application/json", "User-Agent": "basht-app/1"})
    try:
        with urlopen(req, timeout=TIMEOUT_SECONDS) as res:  # noqa: S310 - https only, checked above
            if res.status != 200:
                return "offline"
            data = json.loads(res.read(MAX_BYTES + 1)[:MAX_BYTES])
    except (URLError, TimeoutError, OSError, ValueError):
        return "offline"
    if not isinstance(data, dict) or data.get("ok") is not True:
        return "offline"
    return {"ready": "connected", "starting": "starting"}.get(data.get("gateway"), "offline")  # type: ignore[return-value]


def core_state(environ: Mapping[str, str], now: Callable[[], float] = time.monotonic,
               probe: Callable[[str], CoreState] = _probe) -> CoreState:
    base = (environ.get(ENV_VAR) or "").strip()
    if not base:
        return "unconfigured"
    with _lock:
        hit = _cache.get(base)
        if hit and now() - hit[0] < CACHE_SECONDS:
            return hit[1]
    state = probe(base)
    with _lock:
        _cache[base] = (now(), state)
    return state


def reset_cache() -> None:
    """Test seam."""
    with _lock:
        _cache.clear()
