"""Preview-only mutation protections for a future cookie-based auth flow."""
import hashlib
import hmac
from urllib.parse import urlsplit
from fastapi import HTTPException, Request

def csrf_proof(session_secret: str) -> str:
    """Proof tied to an unguessable session secret; never expose that secret."""
    return hmac.new(session_secret.encode("utf-8"), b"safwan:logout:csrf:v1", hashlib.sha256).hexdigest()

def require_safe_mutation(request: Request, session_secret: str, public_origin: str) -> None:
    origin = request.headers.get("origin")
    target = urlsplit(public_origin)
    actual = urlsplit(origin or "")
    if not origin or actual.scheme != "https" or actual.netloc != target.netloc or target.scheme != "https" or actual.path or actual.query or actual.fragment:
        raise HTTPException(status_code=403, detail="Forbidden")
    if request.headers.get("sec-fetch-site") not in (None, "same-origin"):
        raise HTTPException(status_code=403, detail="Forbidden")
    supplied = request.headers.get("x-csrf-token", "")
    if not hmac.compare_digest(supplied, csrf_proof(session_secret)):
        raise HTTPException(status_code=403, detail="Forbidden")
