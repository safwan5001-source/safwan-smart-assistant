"""Built-in tools. Only `system.time` is implemented; the rest are declared so the
catalogue, permission classes and UI can be built against them, but they cannot run
until a connector exists and has been verified."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..permissions import Risk
from .registry import ToolRegistry, ToolSpec


def _system_time(_: dict[str, Any]) -> dict[str, Any]:
    return {"utc": datetime.now(timezone.utc).isoformat()}


def register_builtin(reg: ToolRegistry) -> None:
    reg.register(ToolSpec("system.time", "الوقت الحالي", "يعيد وقت الخادم بالتوقيت العالمي.", Risk.read, _system_time))
    planned = [
        ("files.read", "قراءة ملف", "قراءة محتوى ملف من مصدر متصل.", Risk.read, "google_drive"),
        ("files.write", "حفظ ملف", "إنشاء أو تعديل ملف في مصدر متصل.", Risk.write, "google_drive"),
        ("email.read", "قراءة البريد", "قراءة رسائل البريد.", Risk.read, "gmail"),
        ("email.send", "إرسال بريد", "إرسال رسالة بريد باسم المستخدم.", Risk.sensitive, "gmail"),
        ("calendar.read", "قراءة المواعيد", "عرض المواعيد القادمة.", Risk.read, "google_calendar"),
        ("calendar.create_event", "إنشاء موعد", "إضافة موعد إلى التقويم.", Risk.write, "google_calendar"),
        ("github.pr.read", "قراءة طلبات الدمج", "عرض طلبات الدمج وحالة التحقق.", Risk.read, "github"),
        ("github.pr.merge", "دمج طلب", "دمج طلب سحب في الفرع الرئيسي.", Risk.sensitive, "github"),
        ("daftra.invoice.create", "إنشاء فاتورة في دفترة", "إدخال فاتورة وحفظها.", Risk.write, "daftra"),
        ("payments.transfer", "تحويل مالي", "تحويل أموال بين حسابات.", Risk.sensitive, None),
        ("windows.run_action", "تنفيذ على Windows", "تحكم بالمتصفح أو البرامج على الكمبيوتر السحابي.", Risk.write, "windows_worker"),
    ]
    for tool_id, title, desc, risk, integration in planned:
        reg.register(ToolSpec(tool_id, title, desc, risk, None, integration))
