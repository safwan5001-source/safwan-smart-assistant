"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import Icon, { type IconName } from "@/components/icon";
import { Badge, LogoTile, Notice, PageHeader } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { aiReady, useAssistant } from "@/components/assistant-context";
import { useStore } from "@/lib/hooks";
import { compactStore, taskModePrefStore, tasksStore, themeStore, threadsStore, DEFAULT_ASSISTANT_MODE, type Theme, type TaskModePref } from "@/lib/stores";
import { MODE_LABEL } from "@/lib/permissions";
import { runCommand } from "@/lib/commands";
import { listFiles } from "@/lib/files-db";
import { formatSize } from "@/lib/format";
import NotificationSettings from "./notification-settings";

const THEMES: { id: Theme; label: string; icon: IconName }[] = [{ id: "system", label: "تلقائي", icon: "auto" }, { id: "light", label: "فاتح", icon: "sun" }, { id: "dark", label: "داكن", icon: "moon" }];

export default function SettingsScreen() {
  const { confirm, toast } = useDialogs();
  const { status, refresh } = useAssistant();
  const theme = useStore(themeStore), compact = useStore(compactStore), pref = useStore(taskModePrefStore);
  const [files, setFiles] = useState<{ count: number; bytes: number } | null>(null);
  useEffect(() => { let live = true; listFiles().then((f) => live && setFiles({ count: f.length, bytes: f.reduce((n, x) => n + x.size, 0) })).catch(() => undefined); return () => { live = false; }; }, []);

  const exportData = () => {
    const payload = { exportedAt: new Date().toISOString(), note: "تصدير محلي للمهام والمحادثات. لا يشمل الملفات.", tasks: tasksStore.getSnapshot(), chats: threadsStore.getSnapshot() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `safwan-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast("تم تجهيز ملف التصدير");
  };
  const erase = async () => {
    const ok = await confirm({ title: "مسح كل البيانات المحلية؟", message: "سيتم حذف المهام والمحادثات وسجل النشاط وجميع الملفات المحفوظة على هذا الجهاز نهائياً. لا يمكن التراجع.", confirmLabel: "مسح كل شيء", tone: "danger", requireText: "مسح" });
    if (!ok) return;
    const res = await runCommand("data.erase_all", {}, { approved: true });
    if (res.status !== "executed") toast("تعذر المسح", "error");
    else if (res.data.filesCleared) { setFiles({ count: 0, bytes: 0 }); toast(res.data.serverErased ? "تم مسح البيانات المحلية وبيانات الإشعارات على الخادم" : "تم مسح البيانات المحلية، لكن تعذر الوصول إلى خادم الإشعارات لحذف نسخته. أعد المحاولة لاحقاً.", res.data.serverErased ? "ok" : "error"); }
    else toast("مُسحت المهام والمحادثات، لكن تعذر الوصول إلى مكتبة الملفات فلم تُحذف.", "error");
  };

  return (
    <div className="page">
      <PageHeader eyebrow="الإعدادات" title="الإعدادات" description="تُحفظ إعدادات العرض على هذا الجهاز فقط." />

      <section className="card card-pad stack" aria-labelledby="look-h">
        <h2 id="look-h">المظهر</h2>
        <div className="seg" role="group" aria-label="المظهر">
          {THEMES.map((t) => <button key={t.id} aria-pressed={theme === t.id} onClick={() => themeStore.set(t.id)}><Icon name={t.icon} size={18} />{t.label}</button>)}
        </div>
        <div className="setting-row"><span><strong>عرض مدمج</strong><small>تقليل المسافات بين عناصر الواجهة</small></span>
          <label className="switch"><input type="checkbox" role="switch" checked={compact} onChange={(e) => compactStore.set(e.target.checked)} aria-label="عرض مدمج" /></label></div>
      </section>

      <NotificationSettings />
      <section className="card card-pad stack" aria-labelledby="perm-h">
        <div><h2 id="perm-h">نمط المهام الافتراضي</h2><p className="muted" style={{ fontSize: 14 }}>يحدد كيف يبدأ المساعد المهام الجديدة عند تفعيله. لا يمنح أي تصريح مسبق بتنفيذ عمليات مالية أو حساسة؛ هذه تطلب موافقة خاصة دائماً.</p></div>
        <div className="seg" role="group" aria-label="نمط المهام الافتراضي">
          {([["ask", "اسألني كل مرة"], ["review", "مراجعة أولاً"]] as [TaskModePref, string][]).map(([id, label]) => <button key={id} aria-pressed={pref === id} onClick={() => taskModePrefStore.set(id)}>{label}</button>)}
        </div>
        <small className="muted">الوضع الفعلي عند التفعيل: «{MODE_LABEL[DEFAULT_ASSISTANT_MODE(pref)].title}» — {MODE_LABEL[DEFAULT_ASSISTANT_MODE(pref)].hint}</small>
        <Link href="/integrations#policy-h" className="btn btn-sm" style={{ justifySelf: "start" }}>عرض مصفوفة الصلاحيات<Icon name="forward" size={16} /></Link>
      </section>

      <section className="card card-pad" aria-labelledby="sys-h">
        <div className="section-head"><h2 id="sys-h">حالة النظام</h2><button className="btn btn-sm" onClick={refresh}>إعادة الفحص</button></div>
        <div style={{ marginBlockStart: 6 }}>
          <div className="status-line"><span><strong>الخادم</strong><small>{status.server === "online" ? `الإصدار ${status.version}` : status.server === "checking" ? "جارٍ الفحص…" : "لا استجابة من /api/health"}</small></span>
            <Badge tone={status.server === "online" ? "ok" : status.server === "offline" ? "warn" : undefined}>{status.server === "online" ? "متصل" : status.server === "offline" ? "غير متصل" : "…"}</Badge></div>
          <div className="status-line"><span><strong>المساعد الذكي</strong><small>يتطلب مزوّد نماذج ومفاتيح على الخادم</small></span><Badge tone={aiReady(status) ? "ok" : undefined}>{aiReady(status) ? "مفعّل" : "غير مفعّل"}</Badge></div>
          <div className="status-line"><span><strong>الحساب والمصادقة</strong><small>لا حساب ولا مزامنة بعد</small></span><Badge>غير مهيأ</Badge></div>
          <div className="status-line"><span><strong>Windows السحابي</strong><small>التنفيذ على الكمبيوتر السحابي</small></span><Badge>غير متصل</Badge></div>
          <div className="status-line"><span><strong>الصوت المباشر</strong><small>الإملاء متاح حسب دعم المتصفح؛ الرد الصوتي غير مفعّل</small></span><Badge>جزئي</Badge></div>
        </div>
      </section>

      <section className="card card-pad stack" aria-labelledby="data-h">
        <div><h2 id="data-h">بياناتك على هذا الجهاز</h2>
          <p className="muted" style={{ fontSize: 14 }}>{files ? <><bdi className="num">{files.count} ملف ({formatSize(files.bytes)})</bdi> · </> : null}لا مزامنة ولا نسخ احتياطي. صدّر نسخة قبل مسح بيانات المتصفح.</p></div>
        <div className="row-wrap">
          <button className="btn" onClick={exportData}><Icon name="download" size={18} />تصدير المهام والمحادثات</button>
          <button className="btn btn-danger" onClick={() => void erase()}><Icon name="trash" size={18} />مسح كل البيانات</button>
        </div>
      </section>

      <section className="card card-pad row" aria-label="عن التطبيق">
        <LogoTile /><span><strong>مساعد صفوان الذكي</strong><small className="muted" style={{ display: "block" }}>نسخة تجريبية · الواجهة تعمل محلياً</small></span>
      </section>
      <Notice>الأسرار ومفاتيح الواجهات البرمجية لا توضع في هذا التطبيق أبداً؛ تُحفظ في بيئة الخادم فقط.</Notice>
    </div>
  );
}
