"""Read-only, preview-gated HTTP session probe.

Not a login endpoint. No account endpoints are enabled by default, and no
session tokens are returned. A separate reviewed release is needed for auth.
"""
import os
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from .session_repository import lookup_authenticated_account, revoke_session
from .preview_csrf import csrf_proof, require_safe_mutation

router = APIRouter()

def preview_enabled() -> bool:
    return os.getenv("VERCEL_ENV") == "preview" and os.getenv("SESSION_HTTP_PREVIEW_ENABLED") == "1"

@router.get("/auth/me", include_in_schema=False)
def preview_current_account(request: Request):
    if not preview_enabled():
        raise HTTPException(status_code=404, detail="Not found")
    token = request.cookies.get("safwan_session")
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise HTTPException(status_code=503, detail="Preview authentication unavailable")
    try:
        import psycopg
        with psycopg.connect(database_url, connect_timeout=3) as connection:
            owner = lookup_authenticated_account(connection, token)
    except Exception:
        raise HTTPException(status_code=503, detail="Preview authentication unavailable") from None
    if owner is None:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return JSONResponse({"account_id": str(owner), "csrf_token": csrf_proof(token)}, headers={"Cache-Control": "no-store"})

@router.post("/auth/logout", include_in_schema=False)
def preview_logout(request: Request):
    if not preview_enabled():
        raise HTTPException(status_code=404, detail="Not found")
    token = request.cookies.get("safwan_session")
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    public_origin = os.getenv("PUBLIC_ORIGIN")
    if not public_origin:
        raise HTTPException(status_code=503, detail="Preview authentication unavailable")
    require_safe_mutation(request, token, public_origin)
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise HTTPException(status_code=503, detail="Preview authentication unavailable")
    try:
        import psycopg
        with psycopg.connect(database_url, connect_timeout=3) as connection:
            owner = lookup_authenticated_account(connection, token)
            if owner is None:
                raise HTTPException(status_code=401, detail="Unauthorized")
            revoke_session(connection, token)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Preview authentication unavailable") from None
    response = JSONResponse({"status": "logged_out"}, headers={"Cache-Control": "no-store"})
    response.delete_cookie("safwan_session", path="/", secure=True, httponly=True, samesite="lax")
    return response
