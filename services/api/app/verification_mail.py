"""Prepare safe verification emails. Delivery integration remains disabled."""
from urllib.parse import urlencode, urlsplit
from .auth_config import AuthConfiguration

def verification_link(origin: str, token: str) -> str:
    AuthConfiguration(public_origin=origin).validate()
    if not token or len(token) < 32 or any(c.isspace() for c in token):
        raise ValueError("Invalid verification token")
    return origin.rstrip("/") + "/verify-email?" + urlencode({"token":token})

def verification_message(origin: str, token: str) -> dict[str,str]:
    url=verification_link(origin,token)
    return {"subject":"تأكيد البريد الإلكتروني — مساعد صفوان الذكي",
            "text":"لتأكيد بريدك الإلكتروني افتح الرابط التالي خلال 30 دقيقة:\\n"+url+"\\nإذا لم تطلب إنشاء حساب، تجاهل الرسالة."}
