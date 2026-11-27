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


def test_wrong_codes_are_refused_and_throttled(client):
    for _ in range(ow.FAILS_MAX):
        assert call(client, "/login/code", {"code": "x" * 40}).json()["detail"]["code"] == "unauthorized"
    assert call(client, "/login/code", {"code": CODE}).json()["detail"]["code"] == "rate_limited"  # even the right code waits out the window


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
    o = call(client, "/passkeys/register/options", {"session": sid}).json()
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
    assert call(client, "/passkeys/register/options", {"session": sid}).status_code == 503
    monkeypatch.setenv("BASHT_PUBLIC_ORIGIN", "http://evil.example")  # https only (localhost http is a non-production test path)
    assert call(client, "/config").json()["passkeys"] is False


def test_registration_needs_a_session_and_user_verification(client):
    assert call(client, "/passkeys/register/options", {"session": "x" * 43}).json()["detail"]["code"] == "unauthorized"
    sid = login(client)
    o = call(client, "/passkeys/register/options", {"session": sid}).json()
    bad = SoftKey().create(o["options"], uv=False)  # no Face ID / passcode check on the device
    assert call(client, "/passkeys/register/verify", {"session": sid, "challenge": o["challenge"], "credential": bad}).status_code == 400


def test_challenges_are_single_use_purpose_bound_and_origin_checked(client):
    sid, key = login(client), SoftKey()
    assert register(client, sid, key).status_code == 200
    o = call(client, "/passkeys/login/options").json()
    cred = key.get(o["options"])
    assert call(client, "/passkeys/login/verify", {"challenge": o["challenge"], "credential": cred}).status_code == 200
    assert call(client, "/passkeys/login/verify", {"challenge": o["challenge"], "credential": cred}).status_code == 400  # replay
    reg = call(client, "/passkeys/register/options", {"session": sid}).json()  # a registration challenge cannot log in
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
