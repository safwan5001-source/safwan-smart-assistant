"""BASHT bridge request signing ("basht-bridge-v1"), client side: shared vectors, and every engine call site signs (or not) alike."""
import base64
import hashlib
import io
import json
from pathlib import Path

import pytest

from app import basht_chat as bc
from app import basht_control as bctl
from app import basht_live as bl
from app import basht_media as bm
from app import basht_signing as bs

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "bridge-signing-vectors.json").read_text())
CURRENT, PREVIOUS = VECTORS["currentSecret"], VECTORS["previousSecret"]
TOKEN = "app-token-0123456789abcdef0123456789abcd"
URL = "https://engine.example"
H = {h.lower(): h for h in bs.HEADER_NAMES}


def _secret_for(case):
    return PREVIOUS if case["signedWith"] == "previous" else CURRENT


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_every_shared_vector_is_reproduced_byte_for_byte(case):
    body = base64.b64decode(case["bodyBase64"])
    h = bs.sign_headers(case["method"], case["target"], body, env={bs.ENV_VAR: _secret_for(case)},
                        now=lambda: case["timestamp"] + 0.9, nonce=case["nonce"])
    assert h == {"X-Basht-Timestamp": str(case["timestamp"]), "X-Basht-Nonce": case["nonce"],
                 "X-Basht-Content-SHA256": case["contentSha256"], "X-Basht-Signature": case["signature"]}
    assert bs.canonical(case["method"], case["target"], case["timestamp"], case["nonce"], case["contentSha256"]).decode() == case["canonical"]


def test_lowercase_method_is_canonicalised_and_none_body_hashes_as_empty():
    a = bs.sign_headers("get", "/app/v1/x", None, env={bs.ENV_VAR: CURRENT}, now=lambda: 5, nonce="n" * 24)
    b = bs.sign_headers("GET", "/app/v1/x", b"", env={bs.ENV_VAR: CURRENT}, now=lambda: 5, nonce="n" * 24)
    assert a == b and a["X-Basht-Content-SHA256"] == hashlib.sha256(b"").hexdigest()


@pytest.mark.parametrize("env", [{}, {bs.ENV_VAR: ""}, {bs.ENV_VAR: "   "}, {bs.ENV_VAR: "x" * 31}])
def test_unset_or_short_secret_means_no_headers(env):
    assert bs.sign_headers("POST", "/app/v1/send", b"{}", env=env) == {}


def test_secret_of_exactly_32_chars_signs_and_nonce_is_random_urlsafe_24():
    env = {bs.ENV_VAR: "s" * 32}
    a, b = bs.sign_headers("GET", "/app/v1/x", env=env), bs.sign_headers("GET", "/app/v1/x", env=env)
    assert a and a["X-Basht-Nonce"] != b["X-Basht-Nonce"]
    import re
    assert re.fullmatch(r"[A-Za-z0-9_-]{24}", a["X-Basht-Nonce"]) and a["X-Basht-Timestamp"].isdigit()


def test_header_values_never_contain_the_secret():
    h = bs.sign_headers("POST", "/app/v1/send", b'{"a":1}', env={bs.ENV_VAR: CURRENT})
    assert all(CURRENT not in v for v in h.values()) and len(h) == 4


# ── the five engine call sites ──────────────────────────────────────────────────────────────────────────────────────────────────
class _Res(io.BytesIO):
    headers = {"Content-Type": "application/json"}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def wire(monkeypatch):
    """Every request that would leave for the engine (all five call sites go through bc.urlopen)."""
    monkeypatch.setenv("BASHT_CORE_URL", URL)
    monkeypatch.setenv("BASHT_APP_TOKEN", TOKEN)
    monkeypatch.delenv(bs.ENV_VAR, raising=False)
    sent = []

    def fake(req, timeout):
        sent.append(req)
        return _Res(b'{"ok":true}')

    monkeypatch.setattr(bc, "urlopen", fake)
    return sent


def _hdrs(req):
    return {k.lower(): v for k, v in req.header_items()}


QUERY = "/history?key=agent%3Amain%3Aapp%3Aowner&limit=50"
AUDIO = bytes(range(256)) * 8
SITES = {
    "chat._call GET (query)": (lambda: bc._call("GET", QUERY), "GET", QUERY, b""),
    "chat._call POST (json)": (lambda: bc._call("POST", "/send", {"message": "مرحبا"}), "POST", "/send", json.dumps({"message": "مرحبا"}).encode()),
    "chat._voice_call (raw audio)": (lambda: bc._voice_call("/transcribe", AUDIO, "audio/webm", timeout=5, max_bytes=1024), "POST", "/transcribe", AUDIO),
    "control._call": (lambda: bctl._call("POST", "/automations/runs", {"limit": 5}), "POST", "/automations/runs", json.dumps({"limit": 5}).encode()),
    "live._live": (lambda: bl._live("GET", "/events?after=3&wait=5"), "GET", "/events?after=3&wait=5", b""),
    "media._engine": (lambda: bm._engine("GET", "/search?q=%D9%85", timeout=5), "GET", "/search?q=%D9%85", b""),
}


@pytest.mark.parametrize("name", list(SITES))
def test_every_call_site_signs_what_it_sends_when_the_secret_is_set(wire, monkeypatch, name):
    run, method, path, body = SITES[name]
    monkeypatch.setenv(bs.ENV_VAR, CURRENT)
    run()
    req = wire[0]
    h = _hdrs(req)
    target = "/app/v1" + path
    assert req.full_url == URL + target and req.selector == target
    assert h["authorization"] == f"Bearer {TOKEN}"  # the existing token header is untouched
    assert h["x-basht-content-sha256"] == hashlib.sha256(body).hexdigest()
    ts, nonce = int(h["x-basht-timestamp"]), h["x-basht-nonce"]
    expect = bs.sign_headers(method, target, body, env={bs.ENV_VAR: CURRENT}, now=lambda: ts, nonce=nonce)
    assert h["x-basht-signature"] == expect["X-Basht-Signature"] and h["x-basht-signature"].startswith("v1=")
    assert all(CURRENT not in v for v in h.values()) and CURRENT not in req.full_url


@pytest.mark.parametrize("name", list(SITES))
def test_every_call_site_sends_no_signature_headers_when_unset_or_short(wire, monkeypatch, name):
    run = SITES[name][0]
    run()
    monkeypatch.setenv(bs.ENV_VAR, "too-short")
    run()
    for req in wire:
        assert not [k for k in _hdrs(req) if k.startswith("x-basht-")]
        assert _hdrs(req)["authorization"] == f"Bearer {TOKEN}"


def test_the_seam_signs_a_bridge_request_that_was_built_without_the_helper(monkeypatch):
    """Backstop: even a future call site that forgets `engine_request` cannot leave unsigned."""
    from urllib.request import Request
    seen = []
    monkeypatch.setenv(bs.ENV_VAR, CURRENT)
    monkeypatch.setattr(bc._opener, "open", lambda req, timeout: seen.append(req) or _Res(b"{}"))
    bc.urlopen(Request(URL + "/app/v1/status?x=1", method="GET"), timeout=1)
    bc.urlopen(Request(URL + "/healthz", method="GET"), timeout=1)  # not the bridge: left alone
    pre = bs.engine_request(URL, "/new", method="POST", data=b"{}", headers={}, env={bs.ENV_VAR: CURRENT})
    sig = pre.get_header("X-basht-signature")
    bc.urlopen(pre, timeout=1)  # already signed: not signed twice
    assert _hdrs(seen[0])["x-basht-signature"].startswith("v1=") and not [k for k in _hdrs(seen[1]) if k.startswith("x-basht-")]
    assert seen[2].get_header("X-basht-signature") == sig


def test_custom_env_is_honoured_by_call(monkeypatch, wire):
    bc._call("POST", "/send", {"message": "x"}, env={"BASHT_CORE_URL": URL, "BASHT_APP_TOKEN": TOKEN, bs.ENV_VAR: PREVIOUS})
    assert _hdrs(wire[0])["x-basht-signature"].startswith("v1=")
