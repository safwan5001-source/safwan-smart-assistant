"""Read-only environment preflight for Phase 5 Preview resources.

Never logs, prints or returns the values of database credentials.
This module does not establish connections or apply schema changes.
"""
from dataclasses import dataclass
from collections.abc import Mapping

@dataclass(frozen=True)
class PreviewReadiness:
    database_configured: bool
    private_blob_configured: bool
    missing_keys: tuple[str, ...]

def inspect_preview_environment(env: Mapping[str, str]) -> PreviewReadiness:
    missing = []
    if not env.get("DATABASE_URL"):
        missing.append("DATABASE_URL")
    if not env.get("BLOB_STORE_ID"):
        missing.append("BLOB_STORE_ID")
    if not env.get("BLOB_WEBHOOK_PUBLIC_KEY"):
        missing.append("BLOB_WEBHOOK_PUBLIC_KEY")
    return PreviewReadiness(
        database_configured="DATABASE_URL" not in missing,
        private_blob_configured=all(k not in missing for k in ("BLOB_STORE_ID","BLOB_WEBHOOK_PUBLIC_KEY")),
        missing_keys=tuple(missing),
    )
