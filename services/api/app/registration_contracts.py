"""Account registration input contracts, not yet an active public endpoint."""
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

class RegistrationRequest(BaseModel):
    model_config=ConfigDict(extra="forbid")
    email: EmailStr
    display_name: str = Field(min_length=1, max_length=100)

    @field_validator("display_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        stripped=value.strip()
        if not stripped or any(ord(c)<32 for c in stripped):
            raise ValueError("Invalid display name")
        return stripped

def normalize_email(email: str) -> str:
    """Basic canonical form; actual account uniqueness also enforced by database."""
    value=email.strip()
    if not value or "@" not in value:
        raise ValueError("Invalid email")
    return value.casefold()

class AccountPublic(BaseModel):
    id: str
    display_name: str
    email_verified: bool
