"""BASHT Core Integration C1: the engine's public /healthz → one coarse state, fail closed, cached, no credentials."""
import io
import json
from unittest.mock import patch

from app import basht_core as bc


class _Res(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200):
        super().__init__(body)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _with(body, status=200):
    return patch.object(bc, "urlopen", lambda req, timeout: _Res(json.dumps(body).encode() if not isinstance(body, bytes) else body, status))


def test_unconfigured_without_url():
    bc.reset_cache()
    assert bc.core_state({}) == "unconfigured"
    assert bc.core_state({"BASHT_CORE_URL": "  "}) == "unconfigured"


def test_maps_the_engine_health():
    for body, want in [({"ok": True, "gateway": "ready"}, "connected"), ({"ok": True, "gateway": "starting"}, "starting"),
                       ({"ok": True, "gateway": "unconfigured"}, "offline"), ({"ok": False, "gateway": "ready"}, "offline"),
                       ({"gateway": "ready"}, "offline"), (["ready"], "offline"), (b"<html>", "offline")]:
        with _with(body):
            assert bc._probe("https://engine.example") == want, body
    with _with({"ok": True, "gateway": "ready"}, status=503):
        assert bc._probe("https://engine.example") == "offline"


def test_refuses_non_https_and_credentials_in_the_url():
    called = []
    with patch.object(bc, "urlopen", lambda *a, **k: called.append(1)):
        for url in ("http://engine.example", "ftp://x", "https://user:pw@engine.example", "engine.example"):
            assert bc._probe(url) == "offline"
    assert called == []


def test_network_failure_is_offline():
    def boom(req, timeout):
        raise TimeoutError

    with patch.object(bc, "urlopen", boom):
        assert bc._probe("https://engine.example") == "offline"


def test_calls_healthz_only_and_caches_for_a_minute():
    bc.reset_cache()
    seen, t = [], [0.0]

    def probe(base):
        seen.append(base)
        return "connected"

    env = {"BASHT_CORE_URL": "https://engine.example/"}
    assert bc.core_state(env, now=lambda: t[0], probe=probe) == "connected"
    t[0] = 59
    assert bc.core_state(env, now=lambda: t[0], probe=probe) == "connected"
    assert len(seen) == 1
    t[0] = 61
    bc.core_state(env, now=lambda: t[0], probe=probe)
    assert len(seen) == 2
    paths = []
    with patch.object(bc, "urlopen", lambda req, timeout: paths.append((req.full_url, timeout)) or _Res(b'{"ok":true,"gateway":"ready"}')):
        bc._probe("https://engine.example/")
    assert paths == [("https://engine.example/healthz", bc.TIMEOUT_SECONDS)]
