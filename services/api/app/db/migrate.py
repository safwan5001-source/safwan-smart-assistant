"""Minimal, auditable SQL migration runner.

- Files in `migrations/NNNN_name.sql`, applied in order, each inside one transaction.
- A SHA-256 checksum is recorded; an applied file that later changes is refused (append-only history).
- A session advisory lock serialises concurrent runners (e.g. two preview builds).
- Run with the OWNER role (`MIGRATION_DATABASE_URL`), never with the runtime role.

    python -m app.db.migrate
"""
from __future__ import annotations

import hashlib
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"
_NAME = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
_LOCK_KEY = 7_262_024_101  # arbitrary, app-specific


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Migration:
    version: str
    filename: str
    sql: str
    checksum: str


def discover(directory: Path = MIGRATIONS_DIR) -> list[Migration]:
    found: list[Migration] = []
    for path in sorted(directory.glob("*.sql")):
        match = _NAME.match(path.name)
        if not match:
            raise MigrationError(f"bad migration filename: {path.name}")
        sql = path.read_text(encoding="utf-8")
        found.append(Migration(match.group(1), path.name, sql, hashlib.sha256(sql.encode("utf-8")).hexdigest()))
    versions = [m.version for m in found]
    if len(versions) != len(set(versions)):
        raise MigrationError("duplicate migration version")
    if versions != [f"{i:04d}" for i in range(1, len(versions) + 1)]:
        raise MigrationError("migration versions must be contiguous from 0001")
    return found


def migrate(conn: psycopg.Connection, directory: Path = MIGRATIONS_DIR) -> list[str]:
    """Apply pending migrations; return the versions applied. `conn` must be autocommit."""
    migrations = discover(directory)
    conn.execute("SELECT pg_advisory_lock(%s)", (_LOCK_KEY,))
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " version text PRIMARY KEY, filename text NOT NULL, checksum text NOT NULL,"
            " applied_at timestamptz NOT NULL DEFAULT now())"
        )
        applied = {row[0]: row[1] for row in conn.execute("SELECT version, checksum FROM schema_migrations").fetchall()}
        unknown = set(applied) - {m.version for m in migrations}
        if unknown:
            raise MigrationError(f"database has migrations missing from this build: {sorted(unknown)}")
        done: list[str] = []
        for m in migrations:
            if m.version in applied:
                if applied[m.version] != m.checksum:
                    raise MigrationError(f"migration {m.filename} was modified after being applied")
                continue
            with conn.transaction():
                conn.execute(m.sql.encode("utf-8"))
                conn.execute(
                    "INSERT INTO schema_migrations (version, filename, checksum) VALUES (%s, %s, %s)",
                    (m.version, m.filename, m.checksum),
                )
            done.append(m.version)
        return done
    finally:
        conn.execute("SELECT pg_advisory_unlock(%s)", (_LOCK_KEY,))


def main() -> int:
    url = os.environ.get("MIGRATION_DATABASE_URL")
    if not url:
        print("MIGRATION_DATABASE_URL is required (owner role). Refusing to use DATABASE_URL.", file=sys.stderr)
        return 2
    try:
        with psycopg.connect(url, autocommit=True, connect_timeout=10) as conn:
            applied = migrate(conn)
    except (MigrationError, psycopg.Error) as exc:
        print(f"migration failed: {type(exc).__name__}", file=sys.stderr)  # no DSN/driver detail in output
        return 1
    print("applied: " + (", ".join(applied) if applied else "nothing (up to date)"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
