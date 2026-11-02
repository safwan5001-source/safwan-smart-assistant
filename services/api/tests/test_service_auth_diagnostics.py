"""Why `/api/health` is 503 with `service auth unavailable: no valid SERVICE_AUTH_SECRET`, and how to tell the causes apart WITHOUT
ever printing the secret or its exact length.

Findings these tests pin (see docs/RUNBOOK-SERVICE-AUTH-503.md):
  * the message comes from ONE condition: the API's SERVICE_AUTH_SECRET is unset, empty/blank, or shorter than 32 bytes;
  * quotes, surrounding spaces or a trailing newline can NOT produce that message (they only lengthen the value); they would make the
    two services disagree and give `bad signature` (401) instead;
  * the old message gave no way to tell "unset" from "empty" from "too short"; the new one reports a category (boolean-grade) only.
"""
from __future__ import annotations

import logging
import time

import pytest
from fastapi.testclient import TestClient

import app.service_auth as sa
from app.main import app
from app.service_auth import MemoryNonceStore, sign

GOOD = "k3Jx9" * 8  # 40 chars, >= 32 bytes
SEC = "SERVICE_AUTH_SECRET"


@pytest.fixture(autouse=True)
def base_env(monkeypatch):
    monkeypatch.setenv("SERVICE_NONCE_STORE", "memory")
    for v in ("SERVICE_AUTH_SECRET_PREVIOUS", "BROWSER_SERVICE_TOKEN", "APP_DATABASE_URL", "DATABASE_URL"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())


def _ping(secret_for_signing: str | None = None):
    headers = {}
    if secret_for_signing is not None:
        ts, nonce = int(time.time()), "n" * 24
        headers = {"x-svc-ts": str(ts), "x-svc-nonce": nonce,
                   "x-svc-sig": sign(secret_for_signing.encode(), "GET", "/internal/v1/ping", ts, nonce, b"")}
    return TestClient(app).get("/internal/v1/ping", headers=headers)


# ── the three configurations that produce the production symptom, each with its own category ─────────────────────
@pytest.mark.parametrize(
    "value,status",
    [(None, "unset"), ("", "empty"), ("   ", "blank"), ("a" * 31, "below_minimum_length")],
    ids=["unset", "empty-string", "whitespace-only", "31-bytes"],
)
def test_the_observed_503_is_reproduced_by_an_unset_empty_or_short_secret(monkeypatch, caplog, value, status):
    if value is None:
        monkeypatch.delenv(SEC, raising=False)
    else:
        monkeypatch.setenv(SEC, value)
    with caplog.at_level(logging.WARNING):
        r = _ping()
    assert r.status_code == 503 and r.json()["detail"]["code"] == "service_auth_unconfigured"
    text = caplog.text
    assert "no valid SERVICE_AUTH_SECRET" in text, "same message operators grep for"
    assert f"status={status}" in text
    assert "bad signature" not in text


def test_a_valid_secret_does_not_produce_the_symptom(monkeypatch, caplog):
    monkeypatch.setenv(SEC, GOOD)
    with caplog.at_level(logging.WARNING):
        r = _ping()
    assert r.status_code == 401  # missing headers: a normal rejection, not "unavailable"
    assert "no valid SERVICE_AUTH_SECRET" not in caplog.text


# ── items 4 of the brief: quotes / spaces / newline cannot be the cause of THIS message ───────────────────────────
@pytest.mark.parametrize(
    "value",
    [f'"{GOOD}"', f"'{GOOD}'", f" {GOOD}", f"{GOOD} ", f"{GOOD}\n", f"{GOOD}\r\n", f"\t{GOOD}\t"],
    ids=["double-quotes", "single-quotes", "leading-space", "trailing-space", "trailing-LF", "trailing-CRLF", "tabs"],
)
def test_decorated_values_only_lengthen_the_secret_so_they_never_cause_the_503(monkeypatch, caplog, value):
    monkeypatch.setenv(SEC, value)
    assert sa.secret_status(SEC) == "ok"
    with caplog.at_level(logging.WARNING):
        r = _ping()
    assert r.status_code == 401 and "no valid SERVICE_AUTH_SECRET" not in caplog.text


def test_decorated_value_on_one_side_gives_bad_signature_not_unavailable(monkeypatch, caplog):
    """The symptom of a quote/newline mismatch between Web and API is a 401 'bad signature' (public health: 'rejected')."""
    monkeypatch.setenv(SEC, f"{GOOD}\n")          # what the API holds
    with caplog.at_level(logging.WARNING):
        r = _ping(secret_for_signing=GOOD)        # what the web tier signs with
    assert r.status_code == 401 and "bad signature" in caplog.text and "no valid SERVICE_AUTH_SECRET" not in caplog.text


@pytest.mark.parametrize(
    "value,flags",
    [
        (GOOD, dict(edge_whitespace=False, wrapped_in_quotes=False, contains_newline=False)),
        (f"{GOOD}\n", dict(edge_whitespace=True, wrapped_in_quotes=False, contains_newline=True)),
        (f'"{GOOD}"', dict(edge_whitespace=False, wrapped_in_quotes=True, contains_newline=False)),
        (f" '{GOOD}' ", dict(edge_whitespace=True, wrapped_in_quotes=False, contains_newline=False)),  # quotes not at the very edge
        ("a" * 10 + "\n", dict(edge_whitespace=True, wrapped_in_quotes=False, contains_newline=True)),
    ],
)
def test_shape_flags_are_booleans_only(monkeypatch, value, flags):
    monkeypatch.setenv(SEC, value)
    assert sa.secret_shape(SEC) == flags
    assert all(isinstance(v, bool) for v in sa.secret_shape(SEC).values())


# ── nothing secret or length-revealing is ever logged ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize("value", ["a" * 31, "Zq7" * 4, "X" * 20 + "\n"])
def test_diagnostics_never_contain_the_value_or_its_length(monkeypatch, caplog, value):
    import re

    monkeypatch.setenv(SEC, value)
    with caplog.at_level(logging.DEBUG):
        _ping()
        sa.log_service_auth_config()
    messages = " | ".join(r.getMessage() for r in caplog.records)
    assert messages, "something must have been logged"
    assert value not in messages and value.strip() not in messages
    assert value.strip()[:6] not in messages
    assert not re.search(rf"(?<!\d){len(value)}(?!\d)", messages), "the exact length must not be logged"


# ── startup self-check: lets an operator verify the variable BEFORE any traffic, booleans only ─────────────────────
def test_startup_line_reports_category_and_booleans(monkeypatch, caplog):
    monkeypatch.setenv(SEC, GOOD)
    monkeypatch.setenv("BROWSER_SERVICE_TOKEN", "t" * 40)
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        with TestClient(app):  # runs the lifespan
            pass
    line = [r.getMessage() for r in caplog.records if "service auth config" in r.getMessage()]
    assert line, "the application must log its service-auth configuration state at startup"
    msg = line[0]
    assert "secret=ok" in msg and "previous=unset" in msg and "collides_with_browser_token=False" in msg
    assert GOOD not in msg and "t" * 40 not in msg


def test_startup_line_flags_the_broken_state(monkeypatch, caplog):
    monkeypatch.setenv(SEC, "short")
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        with TestClient(app):
            pass
    msg = [r.getMessage() for r in caplog.records if "service auth config" in r.getMessage()][0]
    assert "secret=below_minimum_length" in msg and "short" not in msg.replace("below_minimum_length", "")
