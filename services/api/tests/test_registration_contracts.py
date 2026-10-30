import pytest
from pydantic import ValidationError
from app.registration_contracts import RegistrationRequest, normalize_email

def test_registration_contract():
    req=RegistrationRequest(email="USER@example.com",display_name="  Safwan  ")
    assert req.display_name=="Safwan"
    assert normalize_email(str(req.email))=="user@example.com"

def test_reject_control_characters_and_blank_name():
    for name in ["   ","bad\nname"]:
        with pytest.raises(ValidationError):
            RegistrationRequest(email="user@example.com",display_name=name)

def test_reject_unexpected_identity_fields():
    with pytest.raises(ValidationError):
        RegistrationRequest(email="user@example.com",display_name="test",is_admin=True)
