from app.preview_readiness import inspect_preview_environment

def test_preview_resources_detected_without_leaking_values():
    env={"DATABASE_URL":"postgresql://secret:secret@example.net/db","BLOB_STORE_ID":"store_test",
         "BLOB_WEBHOOK_PUBLIC_KEY":"test-public-key"}
    result=inspect_preview_environment(env)
    assert result.database_configured and result.private_blob_configured
    assert result.missing_keys==()
    assert "secret" not in repr(result)

def test_missing_resources_are_fail_closed():
    result=inspect_preview_environment({})
    assert not result.database_configured
    assert not result.private_blob_configured
    assert set(result.missing_keys)=={"DATABASE_URL","BLOB_STORE_ID","BLOB_WEBHOOK_PUBLIC_KEY"}
