"""A1: one owner session — owner code + passkeys (real PostgreSQL, a software WebAuthn authenticator with a real ES256 key)."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import time

import cbor2
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

import app.service_auth as sa
from app.auth import owner as ow
from app.main import app
from app.service_auth import MemoryNonceStore, sign

SECRET = "unit-test-secret-0123456789abcdef-0123456789abcdef"
CODE = "owner-code-0123456789-ABCDEFGHIJKLmnop"
ORIGIN = "http://localhost:3101"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class SoftKey:
    """A minimal platform authenticator (like Face ID): user present + verified, ES256, attestation "none"."""

    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cred_id = os.urandom(32)
        self.count = 0

    def _cose(self) -> bytes:
        n = self.key.public_key().public_numbers()
        return cbor2.dumps({1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")})

    def create(self, options: dict, origin: str = ORIGIN, uv: bool = True) -> dict:
        client = json.dumps({"type": "webauthn.create", "challenge": options["challenge"], "origin": origin}).encode()
        flags = 0x01 | (0x04 if uv else 0) | 0x40
        auth = (hashlib.sha256(options["rp"]["id"].encode()).digest() + bytes([flags]) + struct.pack(">I", self.count)
                + b"\x00" * 16 + struct.pack(">H", len(self.cred_id)) + self.cred_id + self._cose())
        att = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth})
        return {"id": b64u(self.cred_id), "rawId": b64u(self.cred_id), "type": "public-key",
                "response": {"clientDataJSON": b64u(client), "attestationObject": b64u(att)}}

    def get(self, options: dict, origin: str = ORIGIN, rp_id: str = "localhost", count: int | None = None) -> dict:
        self.count = self.count + 1 if count is None else count
        client = json.dumps({"type": "webauthn.get", "challenge": options["challenge"], "origin": origin}).encode()
        auth = hashlib.sha256(rp_id.encode()).digest() + bytes([0x05]) + struct.pack(">I", self.count)
        sig = self.key.sign(auth + hashlib.sha256(client).digest(), ec.ECDSA(hashes.SHA256()))
        return {"id": b64u(self.cred_id), "rawId": b64u(self.cred_id), "type": "public-key",
                "response": {"clientDataJSON": b64u(client), "authenticatorData": b64u(auth), "signature": b64u(sig)}}


@pytest.fixture
def env(monkeypatch, pg_runtime_dsn, pg_owner):
    for k, v in {"APP_ENV": "test", "SERVICE_AUTH_SECRET": SECRET, "SERVICE_NONCE_STORE": "memory",
                 "APP_DATABASE_URL": pg_runtime_dsn, "OWNER_ACCESS_CODE": CODE, "BASHT_PUBLIC_ORIGIN": ORIGIN}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(sa, "_memory_store", MemoryNonceStore())
    pg_owner.execute("TRUNCATE accounts CASCADE")
    ow.reset_limits()
    return pg_owner


@pytest.fixture
def client(env):
    return TestClient(app)


def call(client, path: str, body: dict | None = None):
    raw = json.dumps(body or {}).encode()
    ts, nonce = int(time.time()), f"nonce{time.monotonic_ns():020d}"[-24:]
    target = "/internal/v1/auth" + path
    h = {"x-svc-ts": str(ts), "x-svc-nonce": nonce, "x-svc-sig": sign(SECRET.encode(), "POST", target, ts, nonce, raw), "content-type": "application/json"}
    r = client.post(target, content=raw, headers=h)
    # a signed call never gets 401/403/429: on the internal hop those mean "signature refused" / "cannot serve" to the BFF
    assert r.status_code not in (401, 403, 429), (path, r.status_code)
    return r


def login(client, remember=False) -> str:
    r = call(client, "/login/code", {"code": CODE, "remember": remember})
    assert r.status_code == 200, r.text
    return r.json()["session"]


# ── owner code + session ──────────────────────────────────────────────────
def test_off_without_a_strong_owner_code(client, monkeypatch):
    monkeypatch.setenv("OWNER_ACCESS_CODE", "short")
    assert call(client, "/config").json() == {"owner_auth": False, "passkeys": False}
    assert call(client, "/login/code", {"code": "short"}).status_code == 503


def test_code_login_creates_the_single_owner_once_and_a_resolvable_session(client, env):
    assert call(client, "/config").json() == {"owner_auth": True, "passkeys": True}
    a = call(client, "/login/code", {"code": CODE}).json()
    b = call(client, "/login/code", {"code": CODE, "remember": True}).json()
    assert a["account_id"] == b["account_id"]
    assert env.execute("SELECT count(*) FROM accounts").fetchone()[0] == 1
    assert call(client, "/session", {"session": a["session"]}).json() == {"account_id": a["account_id"]}
    days = [float(r[0]) for r in env.execute("SELECT extract(epoch FROM expires_at - created_at) / 86400 FROM sessions ORDER BY expires_at")]
    assert days == [0.5, 30.0]
    assert "session" not in json.dumps(env.execute("SELECT token_hash FROM sessions LIMIT 1").fetchone()[0].hex())


def test_wrong_codes_are_refused_and_throttled_per_client(client):
    for _ in range(ow.FAILS_MAX):
        assert call(client, "/login/code", {"code": "x" * 40, "client": "203.0.113.9"}).json()["detail"]["code"] == "unauthorized"
    assert call(client, "/login/code", {"code": "y" * 40, "client": "203.0.113.9"}).json()["detail"]["code"] == "rate_limited"
    assert call(client, "/login/code", {"code": "y" * 40, "client": "198.51.100.1"}).json()["detail"]["code"] == "unauthorized"  # another client


def test_the_right_code_is_never_locked_out_by_other_clients_failures(client):
    """Review M1: anonymous wrong codes (from any number of clients, or with no client key) never refuse the owner's right code."""
    for i in range(ow.FAILS_ALARM + 5):
        call(client, "/login/code", {"code": "x" * 40, "client": f"203.0.113.{i % 3}"})
        call(client, "/login/code", {"code": "x" * 40})
    assert call(client, "/login/code", {"code": CODE, "client": "198.51.100.7"}).status_code == 200
    assert call(client, "/login/code", {"code": CODE, "client": "203.0.113.1"}).status_code == 200  # even the throttled client itself
    assert call(client, "/login/code", {"code": CODE}).status_code == 200


def test_the_failure_table_is_bounded(client, monkeypatch):
    monkeypatch.setattr(ow, "MAX_CLIENTS", 3)
    for i in range(10):
        call(client, "/login/code", {"code": "x" * 40, "client": f"c{i}"})
    assert list(ow._fails) == ["c7", "c8", "c9"]


def test_rotating_the_owner_code_ends_every_session(client, monkeypatch):
    """Review M3: sessions are bound to the code (the stored hash is keyed by its fingerprint)."""
    a, b = login(client), login(client, remember=True)
    assert call(client, "/session", {"session": a}).status_code == 200
    monkeypatch.setenv("OWNER_ACCESS_CODE", CODE[::-1] + "-rotated")
    for s in (a, b):
        assert call(client, "/session", {"session": s}).json()["detail"]["code"] == "unauthorized"
    r = call(client, "/login/code", {"code": CODE[::-1] + "-rotated"})
    assert call(client, "/session", {"session": r.json()["session"]}).status_code == 200


def test_a_disabled_owner_is_never_resurrected(client, env):
    sid = login(client)
    env.execute("UPDATE accounts SET disabled_at = now()")
    assert call(client, "/session", {"session": sid}).json()["detail"]["code"] == "unauthorized"
    assert call(client, "/login/code", {"code": CODE}).json()["detail"]["code"] == "owner_disabled"
    assert env.execute("SELECT count(*) FROM accounts").fetchone()[0] == 1


def test_logout_and_logout_everywhere(client):
    a, b = login(client), login(client)
    assert call(client, "/logout", {"session": a}).status_code == 200
    assert call(client, "/session", {"session": a}).json()["detail"]["code"] == "unauthorized"
    assert call(client, "/session", {"session": b}).status_code == 200
    c = login(client)
    assert call(client, "/logout-all", {"session": c}).json()["revoked"] >= 2
    for s in (b, c):
        assert call(client, "/session", {"session": s}).json()["detail"]["code"] == "unauthorized"


def test_unsigned_calls_never_reach_auth(client):
    assert client.post("/internal/v1/auth/login/code", json={"code": CODE}).status_code == 401


# ── passkeys (Face ID) ────────────────────────────────────────────────────
def register(client, sid: str, key: SoftKey, name: str = "iPhone") -> dict:
    o = call(client, "/passkeys/register/options", {"session": sid, "code": CODE}).json()
    assert o["options"]["authenticatorSelection"]["userVerification"] == "required"
    assert o["options"]["authenticatorSelection"]["residentKey"] == "required"
    return call(client, "/passkeys/register/verify", {"session": sid, "challenge": o["challenge"], "credential": key.create(o["options"]), "name": name})


def test_passkey_registration_then_face_id_login_opens_the_same_owner_session(client, env):
    sid = login(client)
    key = SoftKey()
    assert register(client, sid, key).status_code == 200
    listed = call(client, "/passkeys/list", {"session": sid}).json()["passkeys"]
    assert [p["name"] for p in listed] == ["iPhone"]
    o = call(client, "/passkeys/login/options").json()
    r = call(client, "/passkeys/login/verify", {"challenge": o["challenge"], "credential": key.get(o["options"]), "remember": True})
    assert r.status_code == 200, r.text
    me = call(client, "/session", {"session": r.json()["session"]}).json()
    assert me["account_id"] == call(client, "/session", {"session": sid}).json()["account_id"]
    assert env.execute("SELECT sign_count FROM passkeys").fetchone()[0] == 1


def test_passkeys_off_until_the_permanent_domain_is_set(client, monkeypatch):
    monkeypatch.delenv("BASHT_PUBLIC_ORIGIN")
    sid = login(client)
    assert call(client, "/config").json() == {"owner_auth": True, "passkeys": False}
    assert call(client, "/passkeys/register/options", {"session": sid, "code": CODE}).status_code == 503
    monkeypatch.setenv("BASHT_PUBLIC_ORIGIN", "http://evil.example")  # https only (localhost http is a non-production test path)
    assert call(client, "/config").json()["passkeys"] is False


def test_registration_needs_a_session_and_user_verification(client):
    assert call(client, "/passkeys/register/options", {"session": "x" * 43, "code": CODE}).json()["detail"]["code"] == "unauthorized"
    sid = login(client)
    o = call(client, "/passkeys/register/options", {"session": sid, "code": CODE}).json()
    bad = SoftKey().create(o["options"], uv=False)  # no Face ID / passcode check on the device
    assert call(client, "/passkeys/register/verify", {"session": sid, "challenge": o["challenge"], "credential": bad}).status_code == 400


def test_challenges_are_single_use_purpose_bound_and_origin_checked(client):
    sid, key = login(client), SoftKey()
    assert register(client, sid, key).status_code == 200
    o = call(client, "/passkeys/login/options").json()
    cred = key.get(o["options"])
    assert call(client, "/passkeys/login/verify", {"challenge": o["challenge"], "credential": cred}).status_code == 200
    assert call(client, "/passkeys/login/verify", {"challenge": o["challenge"], "credential": cred}).status_code == 400  # replay
    reg = call(client, "/passkeys/register/options", {"session": sid, "code": CODE}).json()  # a registration challenge cannot log in
    assert call(client, "/passkeys/login/verify", {"challenge": reg["challenge"], "credential": key.get(reg["options"])}).status_code == 400
    o2 = call(client, "/passkeys/login/options").json()
    phish = key.get(o2["options"], origin="https://basht-login.example")  # a look-alike site
    assert call(client, "/passkeys/login/verify", {"challenge": o2["challenge"], "credential": phish}).json()["detail"]["code"] == "unauthorized"
    o3 = call(client, "/passkeys/login/options").json()
    assert call(client, "/passkeys/login/verify", {"challenge": o3["challenge"] + "x", "credential": key.get(o3["options"])}).status_code == 400


def test_unknown_or_cloned_keys_are_refused(client):
    sid, key = login(client), SoftKey()
    assert register(client, sid, key).status_code == 200
    o = call(client, "/passkeys/login/options").json()
    assert call(client, "/passkeys/login/verify", {"challenge": o["challenge"], "credential": SoftKey().get(o["options"])}).json()["detail"]["code"] == "unauthorized"
    o = call(client, "/passkeys/login/options").json()
    assert call(client, "/passkeys/login/verify", {"challenge": o["challenge"], "credential": key.get(o["options"], count=5)}).status_code == 200
    o = call(client, "/passkeys/login/options").json()  # a counter going backwards = a cloned authenticator
    assert call(client, "/passkeys/login/verify", {"challenge": o["challenge"], "credential": key.get(o["options"], count=3)}).json()["detail"]["code"] == "unauthorized"


def test_adding_a_passkey_needs_the_owner_code_again(client):
    """Review M3 (step-up): a session alone (e.g. a stolen cookie) cannot enrol a lasting passkey."""
    sid = login(client)
    assert call(client, "/passkeys/register/options", {"session": sid}).status_code == 422  # no code at all
    for _ in range(ow.FAILS_MAX):
        assert call(client, "/passkeys/register/options", {"session": sid, "code": "x" * 40, "client": "c1"}).json()["detail"]["code"] == "reauth_failed"
    assert call(client, "/passkeys/register/options", {"session": sid, "code": "x" * 40, "client": "c1"}).json()["detail"]["code"] == "rate_limited"
    assert "options" in call(client, "/passkeys/register/options", {"session": sid, "code": CODE, "client": "c1"}).json()


def test_remove_all_passkeys(client):
    sid = login(client)
    for _ in range(2):
        assert register(client, sid, SoftKey()).status_code == 200
    assert call(client, "/passkeys/delete-all", {"session": "x" * 43}).json()["detail"]["code"] == "unauthorized"
    assert call(client, "/passkeys/delete-all", {"session": sid}).json() == {"ok": True, "removed": 2}
    assert call(client, "/passkeys/list", {"session": sid}).json()["passkeys"] == []


def test_a_deleted_passkey_no_longer_opens_a_session(client):
    sid, key = login(client), SoftKey()
    register(client, sid, key)
    pid = call(client, "/passkeys/list", {"session": sid}).json()["passkeys"][0]["id"]
    assert call(client, "/passkeys/delete", {"session": sid, "id": pid}).status_code == 200
    o = call(client, "/passkeys/login/options").json()
    assert call(client, "/passkeys/login/verify", {"challenge": o["challenge"], "credential": key.get(o["options"])}).json()["detail"]["code"] == "unauthorized"


def test_passkeys_are_isolated_per_account_under_rls(env, pg_app):
    from tests.pg_support import ACCOUNT_A, ACCOUNT_B, make_account
    make_account(env, ACCOUNT_A, "A"); make_account(env, ACCOUNT_B, "B")
    env.execute("INSERT INTO passkeys (account_id, credential_id, public_key, name) VALUES (%s, %s, %s, 'a')", (ACCOUNT_A, os.urandom(32), os.urandom(64)))
    pg_app.execute("SELECT set_config('app.account_id', %s, false)", (str(ACCOUNT_B),))
    assert pg_app.execute("SELECT count(*) FROM passkeys").fetchone()[0] == 0
    with pytest.raises(Exception):
        pg_app.execute("UPDATE passkeys SET sign_count = 99")  # counters move only through auth_passkey_used


# ── login gate: devices & sessions ────────────────────────────────────────
def test_sessions_list_names_devices_marks_this_one_and_ends_one(client, env):
    a = call(client, "/login/code", {"code": CODE, "device": "آيفون · Safari\n\x00"}).json()["session"]
    b = call(client, "/login/code", {"code": CODE, "remember": True, "device": "ماك · Chrome"}).json()["session"]
    rows = call(client, "/sessions/list", {"session": a}).json()["sessions"]
    assert {r["device"] for r in rows} == {"آيفون · Safari", "ماك · Chrome"}   # control characters stripped
    me = next(r for r in rows if r["current"])
    other = next(r for r in rows if not r["current"])
    assert me["device"] == "آيفون · Safari" and other["remember"] is True and "token" not in json.dumps(rows)
    assert call(client, "/sessions/revoke", {"session": a, "id": other["id"]}).json() == {"ok": True, "current": False}
    assert call(client, "/session", {"session": b}).json()["detail"]["code"] == "unauthorized"
    assert [r["current"] for r in call(client, "/sessions/list", {"session": a}).json()["sessions"]] == [True]
    # already ended / unknown id → not_found; a session can't be listed or ended without a valid one
    assert call(client, "/sessions/revoke", {"session": a, "id": other["id"]}).json()["detail"]["code"] == "not_found"
    assert call(client, "/sessions/list", {"session": "x" * 43}).json()["detail"]["code"] == "unauthorized"
    # ending your own session from the list says so (the BFF then clears this device's cookie without a second lookup)
    assert call(client, "/sessions/revoke", {"session": a, "id": me["id"]}).json() == {"ok": True, "current": True}
    assert call(client, "/session", {"session": a}).json()["detail"]["code"] == "unauthorized"


def test_session_lookup_records_activity_at_most_every_five_minutes(client, env):
    sid = login(client)
    assert env.execute("SELECT last_seen_at FROM sessions").fetchone()[0] is None
    call(client, "/session", {"session": sid})
    first = env.execute("SELECT last_seen_at FROM sessions").fetchone()[0]
    call(client, "/session", {"session": sid})
    assert first is not None and env.execute("SELECT last_seen_at FROM sessions").fetchone()[0] == first
    env.execute("UPDATE sessions SET last_seen_at = now() - interval '6 minutes'")
    call(client, "/session", {"session": sid})
    assert env.execute("SELECT last_seen_at > now() - interval '1 minute' FROM sessions").fetchone()[0] is True


def test_another_accounts_session_id_cannot_be_ended(client, env):
    sid = login(client)
    other = env.execute("INSERT INTO accounts (display_name) VALUES ('x') RETURNING id").fetchone()[0]
    env.execute("INSERT INTO sessions (account_id, token_hash, expires_at) VALUES (%s, %s, now() + interval '1 hour')", (other, b"\x01" * 32))
    foreign = env.execute("SELECT id FROM sessions WHERE account_id = %s", (other,)).fetchone()[0]
    assert call(client, "/sessions/revoke", {"session": sid, "id": str(foreign)}).json()["detail"]["code"] == "not_found"
    assert env.execute("SELECT revoked_at FROM sessions WHERE id = %s", (foreign,)).fetchone()[0] is None
