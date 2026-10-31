"""Internal password credential primitives, not a public login endpoint.

Argon2id PHC strings hold randomly salted password hashes. Never persist or
log clear-text passwords. Production requires rate limiting and recovery flows.
"""
from uuid import UUID
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError, VerificationError

# Fixed dummy verifier: unknown accounts perform Argon2id work too.
# Never derive this from a runtime user password.
_DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=2$6yqlymHpnO9/CrY7tZQ0KQ$r6uJn8J8ZVcKdxqaFP/rkvqjw8kRn22qYy1OWYF5PVw"

_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2, hash_len=32, salt_len=16)

def hash_password(password: str) -> str:
    if not isinstance(password, str) or not (12 <= len(password) <= 1024):
        raise ValueError("Password length must be 12–1024 characters")
    return _hasher.hash(password)

def verify_password(password: str, encoded: str | None) -> bool:
    if not isinstance(password, str) or not isinstance(encoded, str):
        return False
    if len(password) > 1024 or not encoded.startswith("$argon2id$"):
        return False
    try:
        return _hasher.verify(encoded, password)
    except (InvalidHashError, VerifyMismatchError, VerificationError, ValueError):
        return False

def lookup_password_account(connection, email_normalized: str, password: str) -> UUID | None:
    """Return only a verified, active account after password verification.

    A public caller must also enforce rate limits, generic responses and
    enumeration protections before exposing this repository primitive.
    """
    if not isinstance(email_normalized, str) or not email_normalized or len(email_normalized) > 320:
        return None
    if not isinstance(password, str) or len(password) > 1024:
        return None
    row = connection.execute(
        """SELECT a.id, c.password_hash FROM accounts a
           JOIN account_password_credentials c ON c.account_id = a.id
           WHERE a.email_normalized = %s AND a.email_verified_at IS NOT NULL
             AND a.deleted_at IS NULL LIMIT 1""",
        (email_normalized,),
    ).fetchone()
    if row is None:
        verify_password(password, _DUMMY_HASH)
        return None
    if not verify_password(password, row[1]):
        return None
    return row[0]
