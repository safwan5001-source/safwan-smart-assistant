"""Fail-closed database configuration. Never opens a connection by itself."""
from dataclasses import dataclass
from urllib.parse import urlsplit

@dataclass(frozen=True)
class DatabaseSettings:
    url: str
    require_tls: bool = True

    def validate(self, production: bool = True) -> None:
        parts = urlsplit(self.url)
        if parts.scheme not in ("postgresql", "postgres"):
            raise ValueError("PostgreSQL connection required")
        if not parts.hostname or not parts.path or parts.path == "/":
            raise ValueError("Database host and name required")
        if parts.fragment:
            raise ValueError("Database URL fragments are forbidden")
        if production and not self.require_tls:
            raise ValueError("Production requires encrypted database transport")
        if production and not any(item == "sslmode=verify-full" for item in parts.query.split("&")):
            raise ValueError("Production requires sslmode=verify-full")
