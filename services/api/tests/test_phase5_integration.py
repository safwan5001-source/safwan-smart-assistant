from uuid import uuid4
from app.account_service import register_in_transaction, confirm_in_transaction
from app.registration_contracts import RegistrationRequest
from app.sync_repository import update_record, tombstone_record
from app.verification_mail import verification_link

class Cursor:
    def __init__(self,has_row=True): self.has_row=has_row; self.rowcount=1 if has_row else 0
    def fetchone(self): return (1,) if self.has_row else None
class Transaction:
    def __init__(self,db):self.db=db
    def __enter__(self):self.db.calls.append("begin")
    def __exit__(self,typ,val,tb):self.db.calls.append("rollback" if typ else "commit")
class DB:
    def __init__(self,has_row=True):self.calls=[];self.has_row=has_row
    def transaction(self):return Transaction(self)
    def execute(self,sql,params):self.calls.append((sql,params));return Cursor(self.has_row)

def test_registration_atomic():
    db=DB()
    owner,token=register_in_transaction(db,RegistrationRequest(email="test@example.com",display_name="Test"))
    assert db.calls[0]=="begin" and db.calls[-1]=="commit"
    assert len(db.calls)==4
    assert token not in str(db.calls)

def test_confirmation_atomic():
    db=DB();assert confirm_in_transaction(db,uuid4(),"x"*48)
    assert db.calls[0]=="begin" and db.calls[-1]=="commit"

def test_sync_update_scoped_and_conflict():
    owner=uuid4();rid=uuid4()
    db=DB(False)
    assert not update_record(db,owner,"task",rid,1,'{"title":"x"}')
    assert db.calls[0]=="begin" and db.calls[-1]=="commit"
    assert db.calls[1][1]==(str(owner),)
    assert db.calls[2][1][1]==str(owner)
    db2=DB(True)
    assert tombstone_record(db2,owner,"task",rid,1)
    assert "revision=revision+1" in db2.calls[2][0]

def test_mail_url_query_escapes():
    url=verification_link("https://assistant.example.com","x"*40+"+&=")
    assert "https://" in url and "%2B%26%3D" in url
