"""Untrusted header/secret syntax must be rejected with the uniform 401 (or ValueError), never an unhandled exception.

Regression for: `str.isdigit()` is True for Latin-1 superscripts such as '²' (byte 0xB2), so `int()` then raised ValueError and an
unauthenticated request got HTTP 500 instead of the uniform authentication failure. `re.match(...$)` also accepted a trailing newline.
"""
import asyncio
import logging

import pytest

from app import service_auth
from app.auth.sessions import digest_secret
from app.main import app

NONCE, SIG = b"A" * 22, b"0" * 64


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("SERVICE_AUTH_SECRET", "k" * 40)
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")


def asgi_status(headers: list[tuple[bytes, bytes]]) -> int:
    """Drive the ASGI app with RAW header bytes (an HTTP client library would re-encode them and hide the bug)."""
    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "path": "/internal/v1/ping",
             "raw_path": b"/internal/v1/ping", "query_string": b"", "headers": headers, "server": ("t", 80), "client": ("c", 1), "scheme": "http"}
    asyncio.run(app(scope, receive, send))
    return next(m["status"] for m in sent if m["type"] == "http.response.start")


def hdrs(ts: bytes, nonce: bytes = NONCE, sig: bytes = SIG):
    return [(b"host", b"t"), (b"x-svc-ts", ts), (b"x-svc-nonce", nonce), (b"x-svc-sig", sig)]


@pytest.mark.parametrize("ts", [b"\xb2", b"\xb3", b"\xb9", b"12\xb2", b"1700000000\xb2"])
def test_non_ascii_digit_timestamps_get_the_uniform_401_not_a_500(ts, caplog):
    with caplog.at_level(logging.WARNING, logger="safwan.service_auth"):
        assert asgi_status(hdrs(ts)) == 401
    assert "malformed headers" in caplog.text


@pytest.mark.parametrize("ts", [b"", b"abc", b"-1", b"1.5", b"1" * 13])
def test_other_malformed_timestamps_are_rejected(ts):
    assert asgi_status(hdrs(ts)) == 401


def test_trailing_newline_is_not_accepted_in_nonce_or_signature(caplog):
    with caplog.at_level(logging.WARNING, logger="safwan.service_auth"):
        assert asgi_status(hdrs(b"1700000000", nonce=NONCE + b"\n")) == 401
        assert asgi_status(hdrs(b"1700000000", sig=SIG + b"\n")) == 401
    assert caplog.text.count("malformed headers") == 2


def test_ascii_timestamp_still_reaches_the_signature_check(caplog):
    with caplog.at_level(logging.WARNING, logger="safwan.service_auth"):
        assert asgi_status(hdrs(b"1700000000")) == 401
    assert "malformed headers" not in caplog.text  # rejected later (timestamp window / signature), proving the syntax check passed


def test_session_secret_with_trailing_newline_is_rejected():
    with pytest.raises(ValueError):
        digest_secret("A" * 43 + "\n")
    assert len(digest_secret("A" * 43)) == 32


def test_the_timestamp_pattern_is_ascii_digits_only():
    assert service_auth._TS_RE.fullmatch("1700000000")
    for bad in ("²", "١٢٣", "12 ", "1\n", ""):
        assert service_auth._TS_RE.fullmatch(bad) is None
