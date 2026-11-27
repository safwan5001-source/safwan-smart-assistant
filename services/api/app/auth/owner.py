"""A1: one owner session for the whole app, opened by the owner code or by a passkey (Face ID / Touch ID).

    browser ──▶ BFF /api/auth/* ──HMAC──▶ /internal/v1/auth/* (this module) ──▶ PostgreSQL (sessions, passkeys under RLS)

- OWNER_ACCESS_CODE (API only, ≥ 32 chars) turns owner login on. Without it every route here answers 503 and nothing changes.
- Sessions come from the existing core (app/auth/sessions.py): 12 h, or 30 days when the owner chooses "remember this device".
  The session secret is returned once to the BFF, which keeps it in an HttpOnly cookie; only its SHA-256 is stored.
- Passkeys need the app's permanent public origin, BASHT_PUBLIC_ORIGIN (https://…): a passkey is bound to that domain, so they stay
  off until the owner fixes the domain. Registration requires a signed-in owner; login creates the SAME kind of session.
- WebAuthn challenges are sealed here (HMAC, 5 min) and single-use through the existing replay store, so there is no new state table.
- Security review fixes: the right code is ALWAYS accepted (compared first; failures are counted per client, so nobody can lock the
  owner out — M1); adding a passkey needs the owner code again (step-up — M3); a session is bound to the current owner code: its
  stored hash is keyed by a fingerprint of OWNER_ACCESS_CODE, so rotating the code ends every session at once (M3).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import threading
import time
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from ..audit import audit_log
from ..config import Settings, get_settings
from ..db.connection import DatabaseUnavailable, connect_runtime
from ..db.scope import owner_transaction, verified_account_id
from ..service_auth import (
    NonceStore,
    ServiceCall,
    get_nonce_store,
    require_service_call,
)
from .sessions import (
    create_session,
    list_sessions,
    resolve_session,
    revoke_all_sessions,
    revoke_session,
    revoke_session_by_id,
    touch_session,
)

log = logging.getLogger("safwan.auth")
router = APIRouter(prefix="/internal/v1/auth", include_in_schema=False)

CODE_VAR, ORIGIN_VAR = "OWNER_ACCESS_CODE", "BASHT_PUBLIC_ORIGIN"
MIN_CODE, MIN_DISTINCT = 32, 14
CHALLENGE_TTL = 300
# Wrong owner codes per CLIENT (the key the BFF sends: the edge-set client IP) per 15 min. The BFF also limits 5/min per client and
# refuses a throttled client before asking us. A client can only ever throttle itself: the right code is compared first and always
# accepted (review M1: a global refusal let anyone lock the owner out). The code is >= 32 chars, so guessing is not the threat.
FAILS_MAX, FAILS_WINDOW = 10, 900.0
FAILS_ALARM = 100      # failures across the instance per 15 min: logged as an alarm, never a refusal
MAX_CLIENTS = 5000     # bound on the per-client table (oldest entries go first)
RP_NAME = "باشت"

_fail_lock = threading.Lock()
_fails: dict[str, list[float]] = {}
_all_fails: list[float] = []


# ── configuration ─────────────────────────────────────────────────────────
def owner_code(env=os.environ) -> str | None:
    code = env.get(CODE_VAR) or ""
    return code if len(code.encode()) >= MIN_CODE and len(set(code)) >= MIN_DISTINCT else None


def public_origin(env=os.environ, *, production: bool = True) -> tuple[str, str] | None:
    """(origin, rp_id) from BASHT_PUBLIC_ORIGIN, or None (passkeys off). https only; http://localhost outside production (tests)."""
    raw = (env.get(ORIGIN_VAR) or "").strip().rstrip("/")
    u = urlparse(raw)
    if not raw or u.path or u.query or u.fragment or u.username or u.password or not u.hostname:
        return None
    local = u.hostname == "localhost" and u.scheme == "http" and not production
    if u.scheme != "https" and not local:
        return None
    return f"{u.scheme}://{u.netloc}", u.hostname


def config(settings: Settings, env=os.environ) -> dict[str, bool]:
    on = owner_code(env) is not None and bool(settings.database_url)
    return {"owner_auth": on, "passkeys": on and public_origin(env, production=settings.is_production) is not None}


def _require_on(settings: Settings) -> None:
    if not config(settings)["owner_auth"]:
        raise HTTPException(status_code=503, detail={"code": "owner_auth_unconfigured"})


def _rp(settings: Settings) -> tuple[str, str]:
    _require_on(settings)
    rp = public_origin(production=settings.is_production)
    if rp is None:
        raise HTTPException(status_code=503, detail={"code": "passkeys_unconfigured"})
    return rp


def _db(settings: Settings) -> psycopg.Connection:
    try:
        return connect_runtime(settings.database_url, production=settings.is_production, application_name="safwan-auth")
    except DatabaseUnavailable:
        raise HTTPException(status_code=503, detail={"code": "unavailable"}) from None


# ── sealed, single-use WebAuthn challenges ────────────────────────────────
def _seal_key(settings: Settings) -> bytes:
    secret = (settings.service_auth_secret or "").encode()
    if not secret:
        raise HTTPException(status_code=503, detail={"code": "unavailable"})
    return hmac.new(secret, b"basht-webauthn-challenge-v1", hashlib.sha256).digest()


def seal_challenge(settings: Settings, challenge: bytes, purpose: str, account: UUID | None, now: float | None = None) -> str:
    body = json.dumps({"c": bytes_to_base64url(challenge), "p": purpose, "a": str(account) if account else None,
                       "e": int((now or time.time()) + CHALLENGE_TTL)}, separators=(",", ":")).encode()
    payload = base64.urlsafe_b64encode(body).rstrip(b"=").decode()
    mac = hmac.new(_seal_key(settings), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{mac}"


def open_challenge(settings: Settings, token: str, purpose: str, store: NonceStore | None, now: float | None = None) -> tuple[bytes, str | None]:
    bad = HTTPException(status_code=400, detail={"code": "challenge_invalid"})
    try:
        payload, mac = token.split(".", 1)
        want = hmac.new(_seal_key(settings), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(want, mac):
            raise bad
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except HTTPException:
        raise
    except Exception:
        raise bad from None
    if data.get("p") != purpose or int(data.get("e", 0)) < int(now or time.time()):
        raise bad
    if store is None or not store.claim("webauthn:" + data["c"], CHALLENGE_TTL):  # each challenge works once
        raise bad
    return base64url_to_bytes(data["c"]), data.get("a")


# ── helpers ───────────────────────────────────────────────────────────────
def refuse(code: str) -> HTTPException:
    """A domain refusal (wrong code, unknown session, throttled, owner disabled). Always 400 + a code: on the internal hop the
    BFF reserves 401/403 for "our signature was refused" and 429/5xx for "the API cannot serve", so those statuses must never
    carry an owner-level answer. The BFF turns the code back into 401/403/429 for the browser."""
    return HTTPException(status_code=400, detail={"code": code})


def _session_account(conn: psycopg.Connection, session: str) -> UUID:
    account = resolve_session(conn, session, pepper=session_pepper())
    if account is None:
        raise refuse("unauthorized")
    return account


def _issued(secret: str, expires_at, account: UUID) -> dict[str, Any]:
    return {"session": secret, "expires_at": expires_at.isoformat(), "account_id": str(account)}


def _code_ok(code: str) -> bool:
    want = owner_code() or ""
    # compare digests: constant time and independent of the real code's length
    return bool(want) and hmac.compare_digest(hashlib.sha256(code.encode()).digest(), hashlib.sha256(want.encode()).digest())


def _failed(client: str, now: float) -> bool:
    """Record a wrong code; True when this client is now over its budget (the refusal then says rate_limited)."""
    with _fail_lock:
        _all_fails[:] = [t for t in _all_fails if now - t < FAILS_WINDOW]
        _all_fails.append(now)
        if len(_all_fails) == FAILS_ALARM:
            log.warning("owner code: %d wrong codes across the instance in 15 min", FAILS_ALARM)
        if not client:
            return False
        recent = [t for t in _fails.pop(client, []) if now - t < FAILS_WINDOW] + [now]
        _fails[client] = recent  # re-inserted last: the dict's order is oldest-activity-first
        while len(_fails) > MAX_CLIENTS:
            del _fails[next(iter(_fails))]
        return len(recent) > FAILS_MAX


def _check_code(code: str, client: str | None, now: float, refusal: str = "unauthorized") -> None:
    """The right code always passes; a wrong one is counted against its client only."""
    if _code_ok(code):
        return
    over = _failed((client or "")[:64], now)
    raise refuse("rate_limited" if over else refusal)


def session_pepper() -> bytes:
    """Key of the stored session hash: a fingerprint of the CURRENT owner code. Rotating OWNER_ACCESS_CODE changes it, so every
    session issued under the old code stops resolving (review M3). Never stored; derived from the code on every call."""
    return hmac.new((owner_code() or "").encode(), b"basht-owner-session-v1", hashlib.sha256).digest()


def reset_limits() -> None:
    with _fail_lock:
        _fails.clear()
        _all_fails.clear()


# ── request bodies ────────────────────────────────────────────────────────
class CodeLogin(BaseModel):
    code: str = Field(min_length=1, max_length=256)
    remember: bool = False
    device: str | None = Field(default=None, max_length=120)
    client: str | None = Field(default=None, max_length=64)  # the BFF's client key (edge IP): failures are counted per client


class SessionBody(BaseModel):
    session: str = Field(min_length=1, max_length=128)


class PasskeyDelete(SessionBody):
    id: UUID


class SessionRevoke(SessionBody):
    id: UUID


class RegisterOptions(SessionBody):
    """Step-up: adding a passkey needs the owner code again, not just a session (a stolen session must not plant a lasting key)."""
    code: str = Field(min_length=1, max_length=256)
    client: str | None = Field(default=None, max_length=64)


class RegisterVerify(SessionBody):
    challenge: str = Field(min_length=10, max_length=2048)
    credential: dict[str, Any]
    name: str = Field(default="هذا الجهاز", min_length=1, max_length=60)


class LoginVerify(BaseModel):
    challenge: str = Field(min_length=10, max_length=2048)
    credential: dict[str, Any]
    remember: bool = False
    device: str | None = Field(default=None, max_length=120)


# ── routes ────────────────────────────────────────────────────────────────
@router.post("/config")
def auth_config(settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    return config(settings)


@router.post("/login/code")
def login_code(body: CodeLogin, settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    _require_on(settings)
    try:
        _check_code(body.code, body.client, time.monotonic())
    except HTTPException:
        audit_log.record("auth.login", method="code", status="denied")
        raise
    with _db(settings) as conn:
        owner = conn.execute("SELECT auth_ensure_owner()").fetchone()[0]
        if owner is None:
            raise refuse("owner_disabled")
        secret, expires = create_session(conn, owner, remember=body.remember, device=body.device, pepper=session_pepper())
    audit_log.record("auth.login", method="code", status="ok", remember=body.remember)
    return _issued(secret, expires, owner)


@router.post("/session")
def session(body: SessionBody, settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    _require_on(settings)
    with _db(settings) as conn:
        account = _session_account(conn, body.session)
        touch_session(conn, account, body.session, pepper=session_pepper())
        return {"account_id": str(account)}


@router.post("/logout")
def logout(body: SessionBody, settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    _require_on(settings)
    with _db(settings) as conn:
        account = resolve_session(conn, body.session, pepper=session_pepper())
        if account is not None:
            revoke_session(conn, account, body.session, pepper=session_pepper())
    audit_log.record("auth.logout", scope="device")
    return {"ok": True}


@router.post("/logout-all")
def logout_all(body: SessionBody, settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    _require_on(settings)
    with _db(settings) as conn:
        n = revoke_all_sessions(conn, _session_account(conn, body.session))
    audit_log.record("auth.logout", scope="all", sessions=n)
    return {"ok": True, "revoked": n}


@router.post("/sessions/list")
def sessions_list(body: SessionBody, settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    _require_on(settings)
    with _db(settings) as conn:
        return {"sessions": list_sessions(conn, _session_account(conn, body.session), body.session, pepper=session_pepper())}


@router.post("/sessions/revoke")
def sessions_revoke(body: SessionRevoke, settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    _require_on(settings)
    with _db(settings) as conn:
        current = revoke_session_by_id(conn, _session_account(conn, body.session), body.id, body.session, pepper=session_pepper())
        if current is None:
            raise refuse("not_found")
    audit_log.record("auth.logout", scope="session")
    return {"ok": True, "current": current}


@router.post("/passkeys/list")
def passkeys_list(body: SessionBody, settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    _require_on(settings)
    with _db(settings) as conn:
        account = _session_account(conn, body.session)
        with owner_transaction(conn, verified_account_id(account)):
            rows = conn.execute("SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY created_at").fetchall()
    return {"passkeys": [{"id": str(r[0]), "name": r[1], "created_at": r[2].isoformat(), "last_used_at": r[3].isoformat() if r[3] else None} for r in rows]}


@router.post("/passkeys/delete")
def passkeys_delete(body: PasskeyDelete, settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    _require_on(settings)
    with _db(settings) as conn:
        account = _session_account(conn, body.session)
        with owner_transaction(conn, verified_account_id(account)):
            gone = conn.execute("DELETE FROM passkeys WHERE id = %s", (body.id,)).rowcount
    if not gone:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    audit_log.record("auth.passkey", action="delete")
    return {"ok": True}


@router.post("/passkeys/delete-all")
def passkeys_delete_all(body: SessionBody, settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    """Remove every passkey of the account (review M3: "sign out everywhere" ends sessions but keeps passkeys; this removes them)."""
    _require_on(settings)
    with _db(settings) as conn:
        account = _session_account(conn, body.session)
        with owner_transaction(conn, verified_account_id(account)):
            n = conn.execute("DELETE FROM passkeys").rowcount
    audit_log.record("auth.passkey", action="delete_all", removed=n)
    return {"ok": True, "removed": n}


@router.post("/passkeys/register/options")
def register_options(body: RegisterOptions, settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    _, rp_id = _rp(settings)
    with _db(settings) as conn:
        account = _session_account(conn, body.session)
        try:
            _check_code(body.code, body.client, time.monotonic(), refusal="reauth_failed")  # step-up (M3)
        except HTTPException:
            audit_log.record("auth.passkey", action="register", status="reauth_denied")
            raise
        with owner_transaction(conn, verified_account_id(account)):
            existing = [bytes(r[0]) for r in conn.execute("SELECT credential_id FROM passkeys").fetchall()]
    opts = generate_registration_options(
        rp_id=rp_id, rp_name=RP_NAME, user_id=account.bytes, user_name="owner", user_display_name="مالك باشت",
        exclude_credentials=[PublicKeyCredentialDescriptor(id=c) for c in existing],
        authenticator_selection=AuthenticatorSelectionCriteria(resident_key=ResidentKeyRequirement.REQUIRED,
                                                                user_verification=UserVerificationRequirement.REQUIRED),
        timeout=60_000,
    )
    return {"options": json.loads(options_to_json(opts)), "challenge": seal_challenge(settings, opts.challenge, "register", account)}


@router.post("/passkeys/register/verify")
def register_verify(body: RegisterVerify, settings: Settings = Depends(get_settings), store: NonceStore | None = Depends(get_nonce_store),
                    _: ServiceCall = Depends(require_service_call)):
    origin, rp_id = _rp(settings)
    with _db(settings) as conn:
        account = _session_account(conn, body.session)
        challenge, sealed_for = open_challenge(settings, body.challenge, "register", store)
        if sealed_for != str(account):  # a challenge issued to another session cannot register a key here
            raise HTTPException(status_code=400, detail={"code": "challenge_invalid"})
        try:
            v = verify_registration_response(credential=body.credential, expected_challenge=challenge, expected_origin=origin,
                                             expected_rp_id=rp_id, require_user_verification=True)
        except Exception:
            audit_log.record("auth.passkey", action="register", status="rejected")
            raise HTTPException(status_code=400, detail={"code": "passkey_rejected"}) from None
        try:
            with owner_transaction(conn, verified_account_id(account)):
                conn.execute("INSERT INTO passkeys (account_id, credential_id, public_key, sign_count, name) VALUES (%s, %s, %s, %s, %s)",
                             (account, v.credential_id, v.credential_public_key, v.sign_count, body.name.strip()))
        except psycopg.errors.UniqueViolation:
            raise HTTPException(status_code=409, detail={"code": "passkey_exists"}) from None
    audit_log.record("auth.passkey", action="register", status="ok")
    return {"ok": True}


@router.post("/passkeys/login/options")
def login_options(settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    _, rp_id = _rp(settings)
    opts = generate_authentication_options(rp_id=rp_id, user_verification=UserVerificationRequirement.REQUIRED, timeout=60_000)
    return {"options": json.loads(options_to_json(opts)), "challenge": seal_challenge(settings, opts.challenge, "login", None)}


@router.post("/passkeys/login/verify")
def login_verify(body: LoginVerify, settings: Settings = Depends(get_settings), store: NonceStore | None = Depends(get_nonce_store),
                 _: ServiceCall = Depends(require_service_call)):
    origin, rp_id = _rp(settings)
    challenge, _sealed = open_challenge(settings, body.challenge, "login", store)
    denied = refuse("unauthorized")
    try:
        credential_id = base64url_to_bytes(str(body.credential.get("rawId") or body.credential.get("id") or ""))
    except Exception:
        raise denied from None
    with _db(settings) as conn:
        row = conn.execute("SELECT account_id, public_key, sign_count FROM auth_passkey_lookup(%s)", (credential_id,)).fetchone()
        if row is None:
            audit_log.record("auth.login", method="passkey", status="unknown_key")
            raise denied
        account, public_key, count = row
        try:
            v = verify_authentication_response(credential=body.credential, expected_challenge=challenge, expected_rp_id=rp_id,
                                               expected_origin=origin, credential_public_key=bytes(public_key),
                                               credential_current_sign_count=count, require_user_verification=True)
        except Exception:
            audit_log.record("auth.login", method="passkey", status="rejected")
            raise denied from None
        conn.execute("SELECT auth_passkey_used(%s, %s)", (credential_id, v.new_sign_count))
        secret, expires = create_session(conn, account, remember=body.remember, device=body.device, pepper=session_pepper())
    audit_log.record("auth.login", method="passkey", status="ok", remember=body.remember)
    return _issued(secret, expires, account)

