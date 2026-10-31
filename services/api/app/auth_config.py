"""Security configuration checks for future account authentication.

Importing this module never enables login or creates sessions.
"""
from dataclasses import dataclass
from urllib.parse import urlsplit

@dataclass(frozen=True)
class AuthConfiguration:
    public_origin: str
    session_cookie_name: str = "safwan_session"
    session_ttl_seconds: int = 86400
    secure_cookies: bool = True

    def validate(self, production: bool = True) -> None:
        origin = urlsplit(self.public_origin)
        if not origin.hostname or origin.username or origin.password or origin.path not in ("", "/") or origin.query or origin.fragment:
            raise ValueError("PUBLIC_ORIGIN must be a bare origin")
        if production and (origin.scheme != "https" or not self.secure_cookies):
            raise ValueError("Production authentication requires HTTPS and Secure cookies")
        if origin.scheme not in ("https", "http"):
            raise ValueError("Unsupported origin scheme")
        if not self.session_cookie_name.isidentifier():
            raise ValueError("Invalid cookie name")
        if not (300 <= self.session_ttl_seconds <= 604800):
            raise ValueError("Session lifetime outside allowed range")

def cookie_policy(config: AuthConfiguration) -> dict[str, object]:
    """Settings contract only; no actual session token is issued."""
    config.validate()
    return {"httponly": True, "secure": True, "samesite": "lax",
            "path": "/", "max_age": config.session_ttl_seconds}
