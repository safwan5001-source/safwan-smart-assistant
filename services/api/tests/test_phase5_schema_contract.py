"""Guard against silently losing the schema columns consumed by auth flows."""
from pathlib import Path

SCHEMA=Path(__file__).resolve().parents[1] / "schema" / "phase5_preview_consolidated.sql"
def test_preview_schema_contains_required_auth_fields():
    sql=SCHEMA.read_text()
    for field in ("CREATE TABLE accounts", "display_name text", "email_verified_at timestamptz",
                  "CREATE TABLE email_verification_tokens", "consumed_at timestamptz",
                  "CREATE TABLE sessions", "CREATE TABLE sync_records",
                  "FORCE ROW LEVEL SECURITY", "CREATE POLICY account_records"):
        assert field in sql
def test_preview_schema_explicitly_not_deployed():
    assert "NOT automatically executed" in SCHEMA.read_text()
