import pytest
from app.database_settings import DatabaseSettings

def test_accept_verified_tls_database_url():
    DatabaseSettings("postgresql://app:secret@db.example.com/assistant?sslmode=verify-full").validate()

@pytest.mark.parametrize("url", [
    "sqlite:///local.db",
    "postgresql://db.example.com/",
    "postgresql:///assistant",
    "postgresql://db.example.com/assistant?sslmode=disable",
    "postgresql://db.example.com/assistant?sslmode=require",
])
def test_production_db_settings_fail_closed(url):
    with pytest.raises(ValueError):
        DatabaseSettings(url).validate()

def test_no_cleartext_production_override():
    with pytest.raises(ValueError):
        DatabaseSettings("postgresql://db.example.com/app?sslmode=verify-full",require_tls=False).validate()
