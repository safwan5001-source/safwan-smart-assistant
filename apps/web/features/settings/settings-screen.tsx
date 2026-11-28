"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import Icon, { type IconName } from "@/components/icon";
import { BrandMark, Notice, PageHeader } from "@/components/ui";
import { BRAND, BRAND_ASSETS } from "@/lib/brand";
import { useDialogs } from "@/components/dialogs";
import { useStore } from "@/lib/hooks";
import { compactStore, taskModePrefStore, tasksStore, themeStore, threadsStore, DEFAULT_ASSISTANT_MODE, type Theme, type TaskModePref } from "@/lib/stores";
import { MODE_LABEL } from "@/lib/permissions";
import { runCommand } from "@/lib/commands";
import { listFiles } from "@/lib/files-db";
import DevicePhotos from "./device-photos";
import { eraseSummary } from "@/lib/sign-out";
import { formatSize } from "@/lib/format";
import NotificationSettings from "./notification-settings";
import ClaudeSettings from "./claude-settings";
import SecuritySettings from "./security-settings";
import SystemStatus from "./system-status";

const THEMES: { id: Theme; label: string; icon: IconName }[] = [{ id: "system", label: "تلقائي", icon: "auto" }, { id: "light", label: "فاتح", icon: "sun" }, { id: "dark", label: "داكن", icon: "moon" }];

export default function SettingsScreen() {
  const { confirm, toast } = useDialogs();
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
    else {
      if (res.data.filesCleared) setFiles({ count: 0, bytes: 0 });
      const summary = eraseSummary(res.data); // never "done" while anything stayed: files, device photos, the push server
      toast(summary.text, summary.ok ? "ok" : "error");
    }
  };

  return (
    <div className="page">
      <PageHeader icon="settings" eyebrow="الإعدادات" title="الإعدادات" description="تُحفظ إعدادات العرض على هذا الجهاز فقط." />

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

      <SecuritySettings />

      <SystemStatus />

      <section className="card card-pad stack" aria-labelledby="data-h">
        <div><h2 id="data-h">بياناتك على هذا الجهاز</h2>
          <p className="muted" style={{ fontSize: 14 }}>{files ? <><bdi className="num">{files.count} ملف ({formatSize(files.bytes)})</bdi> · </> : null}لا مزامنة ولا نسخ احتياطي. صدّر نسخة قبل مسح بيانات المتصفح.</p></div>
        <div className="row-wrap">
          <button className="btn" onClick={exportData}><Icon name="download" size={18} />تصدير المهام والمحادثات</button>
          <button className="btn btn-danger" onClick={() => void erase()}><Icon name="trash" size={18} />مسح كل البيانات</button>
        </div>
      </section>

      <DevicePhotos />

      <section className="about" aria-label="عن التطبيق">
        <BrandMark size="lg" />
        <span className="stack" style={{ gap: 4 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={BRAND_ASSETS.wordmarkWhite} alt={BRAND.full} style={{ height: 30, width: "auto" }} />
          <small>{BRAND.tagline} · نسخة تجريبية · الواجهة تعمل على هذا الجهاز</small>
          <small>إن ثبّتّ التطبيق على الشاشة الرئيسية قبل التحديث، احذفه وأضِفه من جديد ليظهر اسم «باشت» وأيقونته الجديدة.</small>
        </span>
      </section>
      {/* The old direct-Claude path is no indicator of anything BASHT does: it lives here, labelled legacy, and feeds no badge anywhere else. */}
      <details className="ctl-details legacy-integrations">
        <summary><strong>حول ← التكاملات القديمة</strong></summary>
        <ClaudeSettings />
      </details>
      <Notice>الأسرار ومفاتيح الواجهات البرمجية لا توضع في هذا التطبيق أبداً؛ تُحفظ في بيئة الخادم فقط.</Notice>
    </div>
  );
}
