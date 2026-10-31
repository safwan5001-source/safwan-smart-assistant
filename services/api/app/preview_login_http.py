"""Preview-only password login. No public production authentication is enabled."""
import os
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, EmailStr, Field, ValidationError
from .auth_config import AuthConfiguration, cookie_policy
from .login_throttle import attempt_permitted, record_failed_attempt, reset_failures, subject_digest
from .password_credentials import lookup_password_account
from .registration_contracts import normalize_email
from .session_issuer import create_session
from .preview_session_http import preview_enabled
from urllib.parse import urlsplit

router = APIRouter()

class PreviewLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)

def require_login_origin(request: Request, public_origin: str) -> None:
    """Same-origin HTTPS only; reject cross-site form submissions."""
    actual = urlsplit(request.headers.get("origin") or "")
    expected = urlsplit(public_origin)
    if (expected.scheme != "https" or actual.scheme != expected.scheme
        or actual.netloc != expected.netloc or actual.path or actual.query or actual.fragment
        or request.headers.get("sec-fetch-site") not in (None, "same-origin")):
        raise HTTPException(status_code=403, detail="Forbidden")

@router.post("/auth/login", include_in_schema=False)
async def preview_login(request: Request):
    if not preview_enabled():
        raise HTTPException(status_code=404, detail="Not found")
    origin = os.getenv("PUBLIC_ORIGIN")
    database_url = os.getenv("DATABASE_URL")
    key = os.getenv("LOGIN_THROTTLE_HMAC_KEY")
    if not origin or not database_url or not key:
        raise HTTPException(status_code=503, detail="Preview authentication unavailable")
    try:
        config = AuthConfiguration(public_origin=origin)
        config.validate(production=True)
        subject = subject_digest(normalize_email(str(payload.email)), key.encode("utf-8"))
    except (ValueError, UnicodeError):
        raise HTTPException(status_code=503, detail="Preview authentication unavailable") from None
    require_login_origin(request, origin)
    try:
        payload = PreviewLoginRequest.model_validate(await request.json())
    except (ValueError, ValidationError):
        raise HTTPException(status_code=422, detail="Invalid login request") from None
    try:
        import psycopg
        with psycopg.connect(database_url, connect_timeout=3) as connection:
            with connection.transaction():
                if not attempt_permitted(connection, subject):
                    raise HTTPException(status_code=429, detail="Too many attempts")
                owner = lookup_password_account(connection, normalize_email(str(payload.email)), payload.password)
                if owner is None:
                    record_failed_attempt(connection, subject)
                else:
                    reset_failures(connection, subject)
                    token = create_session(connection, owner, config.session_ttl_seconds)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Preview authentication unavailable") from None
    if owner is None:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    response = JSONResponse({"status": "authenticated"}, headers={"Cache-Control": "no-store"})
    response.set_cookie(config.session_cookie_name, token, **cookie_policy(config))
    return response
