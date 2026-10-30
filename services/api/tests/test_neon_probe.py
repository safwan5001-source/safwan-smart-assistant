import pytest
from app.neon_probe import probe_neon,tls_database_url

class Cursor:
    def __enter__(self):return self
    def __exit__(self,*args):return False
    def execute(self,sql):assert sql=="SELECT 1"
    def fetchone(self):return (1,)
class Conn:
    def __enter__(self):return self
    def __exit__(self,*args):return False
    def cursor(self):return Cursor()

def test_preview_probe_read_only_and_tls():
    def factory(url,connect_timeout):
        assert "sslmode=verify-full" in url
        assert connect_timeout==5
        return Conn()
    assert probe_neon(factory,{"VERCEL_ENV":"preview","DATABASE_URL":"postgresql://user:password@db.example.com/app?sslmode=require"})

def test_other_environments_denied_without_opening_connection():
    def forbidden(*args,**kwargs):raise AssertionError("Must not connect")
    with pytest.raises(PermissionError):
        probe_neon(forbidden,{"VERCEL_ENV":"production","DATABASE_URL":"postgresql://user:password@db.example.com/app"})

def test_missing_url_denied():
    with pytest.raises(RuntimeError):
        probe_neon(lambda *a,**k:None,{"VERCEL_ENV":"preview"})

def test_tls_policy():
    assert "sslmode=verify-full" in tls_database_url("postgresql://user:pass@db.example.com/app?sslmode=disable")
    with pytest.raises(ValueError):
        tls_database_url("https://invalid.example.com/")
