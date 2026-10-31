from uuid import UUID
from app.registration_contracts import RegistrationRequest
from app.account_registration import register_pending_account

class FakeDB:
    def __init__(self): self.calls=[]
    def execute(self,sql,params): self.calls.append((sql,params))

def test_registration_creates_account_and_hashed_verification_token():
    db=FakeDB()
    request=RegistrationRequest(email="USER@example.com", display_name=" Safwan ")
    account_id,secret=register_pending_account(db,request)
    assert UUID(account_id)
    assert len(db.calls)==2
    assert db.calls[0][1][1]=="user@example.com"
    assert db.calls[0][1][2]=="Safwan"
    assert str(db.calls[1][1][1])==account_id
    assert secret not in str(db.calls)
