from app.neon_probe import probe_neon

def test_preview_probe_not_callable_without_preview_context():
    import pytest
    with pytest.raises(PermissionError):
        probe_neon(lambda *a, **k: None, {"VERCEL_ENV":"production","DATABASE_URL":"postgresql://user:pass@host/db"})
