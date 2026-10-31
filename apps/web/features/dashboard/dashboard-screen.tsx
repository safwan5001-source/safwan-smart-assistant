"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Icon, { type IconName } from "@/components/icon";
import { Badge, Empty, LogoTile, Notice, Skeleton } from "@/components/ui";
import { aiReady, useAssistant } from "@/components/assistant-context";
import { OPEN_SEARCH_EVENT } from "@/components/app-shell";
import { useHydrated, useStore } from "@/lib/hooks";
import { activityStore, tasksStore, threadsStore } from "@/lib/stores";
import { listFiles } from "@/lib/files-db";
import { commandTitle } from "@/lib/commands";
import { dueState, formatDay, formatTime, formatToday, localDateKey } from "@/lib/format";

const greeting = (h: number) => (h < 12 ? "صباح الخير" : "مساء الخير");
const SHORTCUTS: { href: string; icon: IconName; title: string; sub: string }[] = [
  { href: "/chat", icon: "chat", title: "محادثة جديدة", sub: "اكتب ملاحظة أو أمراً سريعاً" },
  { href: "/tasks", icon: "tasks", title: "إضافة مهمة", sub: "رتّب أولوياتك" },
  { href: "/files", icon: "files", title: "ملفاتي", sub: "افتح مستنداتك المحفوظة" },
  { href: "/integrations", icon: "integrations", title: "التكاملات", sub: "حالة الخدمات وصلاحياتها" },
];
const STATUS_LABEL: Record<string, string> = { executed: "نُفّذ", denied: "مرفوض", approval_required: "بانتظار موافقة", invalid: "غير صالح", failed: "فشل" };

export default function DashboardScreen() {
  const hydrated = useHydrated();
  const tasks = useStore(tasksStore), threads = useStore(threadsStore), activity = useStore(activityStore);
  const { status, refresh } = useAssistant();
  const [fileCount, setFileCount] = useState<number | null>(null);
  useEffect(() => { let live = true; listFiles().then((f) => live && setFileCount(f.length)).catch(() => live && setFileCount(null)); return () => { live = false; }; }, []);

  const now = useMemo(() => (hydrated ? new Date() : null), [hydrated]);
  const today = localDateKey();
  const pending = tasks.filter((t) => !t.done);
  const overdue = pending.filter((t) => dueState(t.due, today) === "overdue").length;
  const dueToday = pending.filter((t) => dueState(t.due, today) === "today").length;
  const next = [...pending].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.created - a.created).slice(0, 4);
  const ai = aiReady(status);

  return (
    <div className="page">
      <section className="hero" aria-labelledby="hello">
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="muted num" style={{ fontSize: 13, fontWeight: 600 }}>{now ? formatToday(now) : " "}</span>
          <h1 id="hello">{now ? greeting(now.getHours()) : "أهلاً"}، صفوان</h1>
          <p>محادثاتك ومهامك وملفاتك في مكان واحد. كل ما تراه محفوظ على هذا الجهاز؛ المساعد الذكي وتنفيذ الأوامر على الخادم لم يُفعَّلا بعد.</p>
          <div className="row-wrap" style={{ marginBlockStart: 14 }}>
            <Link href="/chat" className="btn btn-primary"><Icon name="chat" size={18} />ابدأ محادثة</Link>
            <button className="btn" onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}><Icon name="search" size={18} />بحث شامل</button>
          </div>
        </div>
        <LogoTile size="lg" />
      </section>

      <section aria-label="ملخص" className="grid grid-2 grid-md-4">
        {!hydrated ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={92} />) : (<>
          <Link href="/tasks" className="stat"><span>المهام المتبقية</span><strong>{pending.length}</strong><small>{dueToday ? `${dueToday} تستحق اليوم` : "للمتابعة"}</small></Link>
          <Link href="/tasks" className="stat"><span>متأخرة</span><strong style={overdue ? { color: "var(--danger)" } : undefined}>{overdue}</strong><small>{overdue ? "تحتاج اهتماماً" : "لا شيء متأخر"}</small></Link>
          <Link href="/chat" className="stat"><span>المحادثات</span><strong>{threads.filter((t) => !t.archived).length}</strong><small>على هذا الجهاز</small></Link>
          <Link href="/files" className="stat"><span>الملفات</span><strong>{fileCount ?? "—"}</strong><small>مكتبة محلية</small></Link>
        </>)}
      </section>

      <div className="grid grid-lg-3" style={{ alignItems: "start" }}>
        <section className="card card-pad" style={{ gridColumn: "span 2" }} aria-labelledby="next-h">
          <div className="section-head"><h2 id="next-h">مهام للمتابعة</h2><Link href="/tasks" className="btn btn-ghost btn-sm" style={{ color: "var(--accent)" }}>عرض الكل<Icon name="forward" size={16} /></Link></div>
          {!hydrated ? <div className="stack" style={{ marginBlockStart: 12 }}><Skeleton h={44} /><Skeleton h={44} /></div>
            : next.length ? (
              <ul className="list">
                {next.map((t) => { const d = dueState(t.due, today); return (
                  <li key={t.id}>
                    <Icon name="tasks" size={20} style={{ color: "var(--accent)" }} />
                    <span className="grow"><span className="title">{t.title}</span></span>
                    {t.priority === "high" && <Badge tone="danger">عالية</Badge>}
                    {t.due && <Badge tone={d === "overdue" ? "danger" : d === "today" ? "warn" : undefined}>{d === "overdue" ? "متأخرة · " : d === "today" ? "اليوم · " : ""}{formatDay(t.due)}</Badge>}
                  </li>); })}
              </ul>
            ) : <Empty icon="check" title="لا مهام معلقة" action={<Link href="/tasks" className="btn btn-primary btn-sm">أضف مهمة</Link>}>أنجزت كل شيء، أو لم تبدأ بعد.</Empty>}
        </section>

        <section className="card card-pad" aria-labelledby="status-h">
          <div className="section-head"><h2 id="status-h">حالة النظام</h2><button className="btn btn-ghost btn-sm" onClick={refresh} aria-label="إعادة فحص الخادم">إعادة الفحص</button></div>
          <div style={{ marginBlockStart: 6 }}>
            <div className="status-line"><span><strong>الخادم</strong><small>{status.server === "online" ? `الإصدار ${status.version}` : "فحص /backend/health"}</small></span>
              {status.server === "checking" ? <Badge>جارٍ الفحص</Badge> : status.server === "online" ? <Badge tone="ok">متصل</Badge> : <Badge tone="warn">غير متصل</Badge>}</div>
            <div className="status-line"><span><strong>المساعد الذكي</strong><small>{ai ? "مُهيّأ على الخادم" : "لا يوجد مزوّد نماذج مفعّل"}</small></span>{ai ? <Badge tone="ok">مفعّل</Badge> : <Badge>غير مفعّل</Badge>}</div>
            <div className="status-line"><span><strong>التكاملات</strong><small>لا خدمة متصلة بعد</small></span><Badge>0 متصلة</Badge></div>
            <div className="status-line"><span><strong>المزامنة</strong><small>بين الأجهزة</small></span><Badge>غير متاحة</Badge></div>
          </div>
        </section>
      </div>

      <section aria-labelledby="quick-h" className="stack">
        <div className="section-head"><h2 id="quick-h">وصول سريع</h2></div>
        <div className="grid grid-md-2 grid-lg-3">
          {SHORTCUTS.map((s) => (
            <Link key={s.href} href={s.href} className="shortcut">
              <span className="ico"><Icon name={s.icon} size={22} /></span>
              <span style={{ flex: 1 }}><strong>{s.title}</strong><small>{s.sub}</small></span>
              <Icon name="forward" size={18} style={{ color: "var(--muted)" }} />
            </Link>
          ))}
        </div>
      </section>

      <section className="card card-pad" aria-labelledby="act-h">
        <div className="section-head"><h2 id="act-h">آخر النشاط</h2><small className="muted">محلي · آخر 100 عملية</small></div>
        {!hydrated ? <div style={{ marginBlockStart: 12 }}><Skeleton h={40} /></div> : activity.length ? (
          <ul className="list">
            {activity.slice(0, 5).map((a) => (
              <li key={a.id}>
                <span className="grow"><span className="title">{commandTitle(a.command)}</span><small className="muted num">{formatTime(a.ts)}</small></span>
                <Badge tone={a.status === "executed" ? "ok" : a.status === "denied" || a.status === "failed" ? "danger" : "warn"}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
              </li>
            ))}
          </ul>
        ) : <p className="muted" style={{ marginBlockStart: 8 }}>لا نشاط بعد. ستظهر هنا العمليات التي تنفذها داخل التطبيق.</p>}
      </section>

      <Notice>الرسائل والمهام والملفات غير متزامنة بين الأجهزة ولا توجد نسخة احتياطية. لا تحفظ بيانات حساسة هنا حتى يُفعَّل الحساب والتشفير.</Notice>
    </div>
  );
}
