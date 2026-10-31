from __future__ import annotations

from ..permissions import Risk
from .base import AuthKind, IntegrationSpec, ScopeSpec

R, W, S = Risk.read, Risk.write, Risk.sensitive

CATALOG: tuple[IntegrationSpec, ...] = (
    IntegrationSpec("github", "GitHub", "development", "المستودعات وطلبات الدمج والتحقق من البناء.", AuthKind.oauth2,
                    (ScopeSpec("pr.read", "قراءة طلبات الدمج", R), ScopeSpec("pr.merge", "دمج طلب", S))),
    IntegrationSpec("vercel", "Vercel", "hosting", "متابعة النشر والبيئات.", AuthKind.api_key,
                    (ScopeSpec("deployments.read", "قراءة عمليات النشر", R), ScopeSpec("deployments.create", "إنشاء نشر", S))),
    IntegrationSpec("railway", "Railway", "hosting", "خدمات التطبيق وقواعد البيانات.", AuthKind.api_key,
                    (ScopeSpec("services.read", "قراءة الخدمات", R),)),
    IntegrationSpec("gmail", "Gmail", "email", "قراءة الرسائل ومتابعة العمل.", AuthKind.oauth2,
                    (ScopeSpec("mail.read", "قراءة البريد", R), ScopeSpec("mail.send", "إرسال بريد", S))),
    IntegrationSpec("google_drive", "Google Drive", "files", "الوصول إلى المستندات والملفات السحابية.", AuthKind.oauth2,
                    (ScopeSpec("files.read", "قراءة الملفات", R), ScopeSpec("files.write", "حفظ الملفات", W))),
    IntegrationSpec("google_calendar", "Google Calendar", "scheduling", "المواعيد والتنبيهات.", AuthKind.oauth2,
                    (ScopeSpec("events.read", "قراءة المواعيد", R), ScopeSpec("events.write", "إنشاء مواعيد", W))),
    IntegrationSpec("daftra", "دفترة", "accounting", "إدخال الفواتير والتحقق من مراجعها عبر الواجهة.", AuthKind.session,
                    (ScopeSpec("invoices.read", "قراءة الفواتير", R), ScopeSpec("invoices.create", "إنشاء فاتورة", W))),
    IntegrationSpec("windows_worker", "Windows السحابي", "automation", "تنفيذ المهام على الكمبيوتر السحابي بالشاشة والماوس.", AuthKind.session,
                    (ScopeSpec("screen.capture", "التقاط الشاشة", R), ScopeSpec("input.control", "التحكم بالإدخال", W))),
)

_BY_ID = {spec.id: spec for spec in CATALOG}


def get_integration(integration_id: str) -> IntegrationSpec | None:
    return _BY_ID.get(integration_id)
