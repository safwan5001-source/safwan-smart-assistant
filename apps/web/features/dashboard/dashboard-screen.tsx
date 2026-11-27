"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import Icon, { type IconName } from "@/components/icon";
import { AgentOrb, Notice, Skeleton, StatusPill, type RunStatus } from "@/components/ui";
import { useAssistant } from "@/components/assistant-context";
import { OPEN_SEARCH_EVENT } from "@/components/app-shell";
import { useHydrated, useStore } from "@/lib/hooks";
import { activityStore, noticesStore, remindersStore, tasksStore, threadsStore } from "@/lib/stores";
import { alertAt, describeSchedule, type Reminder } from "@/lib/reminders";
import { remindersDueToday } from "@/lib/command-center";
import { unreadCount } from "@/lib/notifications";
import { INTEGRATIONS } from "@/lib/integrations";
import { listFiles } from "@/lib/files-db";
import { commandTitle } from "@/lib/commands";
import { dueState, formatDay, formatTime, formatToday, localDateKey } from "@/lib/format";
import { AGENT_STATE_TEXT, agentState, useAgentActivity } from "@/lib/agent-activity";
import { BRAND } from "@/lib/brand";
import type { Task } from "@/lib/domain";
import { HQ_ENABLED } from "@/lib/hq/flag";
import HqEntryCard from "@/features/hq/hq-entry-card";

const greeting = (h: number) => (h < 12 ? "صباح الخير" : "مساء الخير");
const QUICK: { href?: string; search?: true; icon: IconName; label: string; tone?: "ai" | "gold" }[] = [
  { href: "/chat", icon: "chat", label: "محادثة" },
  { href: "/tasks", icon: "tasks", label: "مهمة" },
  { href: "/reminders", icon: "clock", label: "تذكير", tone: "gold" },
  { href: "/files", icon: "upload", label: "ملف" },
  { href: "/calls", icon: "wave", label: "صوت", tone: "ai" },
  { search: true, icon: "search", label: "بحث" },
];
/** Activity log → Design System status set. These are past outcomes recorded on this device, never projected ones. */
const ACTIVITY: Record<string, { s: RunStatus; label: string }> = {
  executed: { s: "done", label: "نُفّذ" }, approval_required: { s: "awaiting_approval", label: "طلب موافقة" },
  denied: { s: "cancelled", label: "مرفوض" }, invalid: { s: "failed", label: "غير صالح" }, failed: { s: "failed", label: "تعذّر" },
};

type Next = { icon: IconName; title: string; sub: string; href?: string; action?: () => void };

export default function DashboardScreen() {
  const hydrated = useHydrated();
  const router = useRouter();
  const reminders = useStore(remindersStore), tasks = useStore(tasksStore), threads = useStore(threadsStore), activity = useStore(activityStore), notices = useStore(noticesStore);
  const { status, refresh } = useAssistant();
  const state = agentState(status, useAgentActivity());
  const st = AGENT_STATE_TEXT[state];
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [ask, setAsk] = useState("");
  useEffect(() => { let live = true; listFiles().then((f) => live && setFileCount(f.length)).catch(() => live && setFileCount(null)); return () => { live = false; }; }, []);

  const now = useMemo(() => (hydrated ? new Date() : null), [hydrated]);
  const today = localDateKey();
  const pending = tasks.filter((t) => !t.done);
  const overdue = pending.filter((t) => dueState(t.due, today) === "overdue");
  const dueToday = pending.filter((t) => dueState(t.due, today) === "today");
  const fired = reminders.filter((r) => r.status === "fired");
  const unread = unreadCount(notices);
  const remindersToday = now ? remindersDueToday(reminders, now.getTime()).length : 0;
  const upcomingTasks = [...pending].filter((t) => dueState(t.due, today) !== "overdue")
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.created - a.created).slice(0, 4);
  const upcomingReminders = reminders.filter((r: Reminder) => r.status === "active").sort((a, b) => (alertAt(a) ?? a.dueAt) - (alertAt(b) ?? b.dueAt)).slice(0, 3);
  const plannedIntegrations = INTEGRATIONS.length;
  const connectedIntegrations = INTEGRATIONS.filter((i) => i.status === "connected").length;

  // One suggested next step, derived only from what is on this device and the live connection status.
  const next: Next = fired[0] ? { icon: "bell", title: fired[0].title, sub: "تذكير وصل وينتظر إجراءك", href: "/reminders" }
    : overdue[0] ? { icon: "alert", title: overdue[0].title, sub: "مهمة متأخرة — ابدأ بها", href: "/tasks" }
    : dueToday[0] ? { icon: "target", title: dueToday[0].title, sub: "مستحقة اليوم", href: "/tasks" }
    : status.server === "offline" ? { icon: "repeat", title: "أعد فحص الاتصال بالخادم", sub: "ما على جهازك يعمل كالمعتاد", action: refresh }
    : status.server === "online" && !status.assistant ? { icon: "spark", title: "فعّل Claude ليبدأ باشت التنفيذ", sub: "من الإعدادات ← Claude", href: "/settings" }
    : { icon: "chat", title: "ابدأ محادثة جديدة مع باشت", sub: "اكتب ما تريد إنجازه", href: "/chat" };

  const submitAsk = (e: FormEvent) => {
    e.preventDefault();
    const text = ask.trim();
    router.push(text ? "/chat?draft=" + encodeURIComponent(text) : "/chat");
  };

  const nextBody = (
    <>
      <span className="ico"><Icon name={next.icon} size={18} /></span>
      <span className="grow"><small>الخطوة التالية المقترحة</small><strong>{next.title}</strong></span>
      <Icon name="forward" size={18} />
    </>
  );

  return (
    <div className="page">
      <h1 className="sr-only">مركز قيادة {BRAND.nameAr}</h1>
      <section className="cc-hero" aria-labelledby="hello">
        <div className="cc-top">
          <AgentOrb state={state} size="lg" />
          <div className="grow">
            <span className="cc-date num">{now ? formatToday(now) : " "}</span>
            <h2 id="hello" className="cc-hello">{now ? greeting(now.getHours()) : "أهلاً"}، {BRAND.ownerName}</h2>
            <span className="cc-state" data-tone={st.tone} role="status"><i className="state-dot" aria-hidden="true" />{BRAND.nameAr} · {st.label}</span>
          </div>
        </div>
        <form className="cc-ask" onSubmit={submitAsk} role="search" aria-label={"اطلب من " + BRAND.nameAr}>
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="اطلب من باشت… مثلًا: /مهمة مراجعة الفواتير" aria-label="اكتب طلبك لباشت" enterKeyHint="go" maxLength={500} />
          <button className="icon-btn send-btn" type="submit" aria-label="متابعة في المحادثة"><Icon name="send" size={20} style={{ transform: "scaleX(-1)" }} /></button>
        </form>
        {hydrated && (next.href
          ? <Link href={next.href} className="cc-next">{nextBody}</Link>
          : <button type="button" className="cc-next" onClick={next.action} style={{ textAlign: "start" }}>{nextBody}</button>)}
      </section>

      <nav className="quick" aria-label="إجراءات سريعة">
        {QUICK.map((q) => {
          const body = <><span className={"ico " + (q.tone ?? "")}><Icon name={q.icon} size={21} /></span>{q.label}</>;
          return q.search
            ? <button key={q.label} type="button" onClick={() => window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))}>{body}</button>
            : <Link key={q.label} href={q.href!}>{body}</Link>;
        })}
      </nav>

      {HQ_ENABLED && <HqEntryCard />}

      <section aria-labelledby="today-h" className="stack">
        <div className="section-head"><h2 id="today-h"><Icon name="calendar" size={18} />ملخص اليوم</h2></div>
        <div className="grid grid-2 grid-md-4">
          {!hydrated ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={96} />) : (<>
            <Link href="/tasks" className="stat"><span><Icon name="target" size={15} />مستحقة اليوم</span><strong>{dueToday.length}</strong><small>من {pending.length} مهمة مفتوحة</small></Link>
            <Link href="/tasks" className={"stat" + (overdue.length ? " alert" : "")}><span><Icon name="alert" size={15} />متأخرة</span><strong>{overdue.length}</strong><small>{overdue.length ? "تحتاج اهتمامك" : "لا شيء متأخر"}</small></Link>
            <Link href="/reminders" className="stat"><span><Icon name="clock" size={15} />تذكيرات اليوم</span><strong>{remindersToday}</strong><small>{fired.length ? `${fired.length} بانتظار إجراء` : "موعدها اليوم حتى منتصف الليل"}</small></Link>
            <Link href="/files" className="stat"><span><Icon name="files" size={15} />الملفات</span><strong>{fileCount ?? "—"}</strong><small>{threads.filter((t) => !t.archived).length} محادثة على هذا الجهاز</small></Link>
          </>)}
        </div>
      </section>

      <section aria-labelledby="attn-h" className="stack">
        <div className="section-head"><h2 id="attn-h"><Icon name="hourglass" size={18} />بانتظارك</h2></div>
        {!hydrated ? <Skeleton h={60} /> : (fired.length || overdue.length || unread) ? (
          <div className="attn">
            {fired.slice(0, 3).map((r) => (
              <Link key={r.id} href="/reminders" className={"attn-item " + (r.priority === "critical" ? "danger" : "")}>
                <span className="ico"><Icon name="bell" size={19} /></span>
                <span className="grow"><strong>{r.title}</strong><small className="num">{describeSchedule(r)}</small></span>
                <StatusPill status="awaiting_approval" label="بانتظار إجراء" />
              </Link>
            ))}
            {overdue.slice(0, 3).map((t: Task) => (
              <Link key={t.id} href="/tasks" className="attn-item danger">
                <span className="ico"><Icon name="tasks" size={19} /></span>
                <span className="grow"><strong>{t.title}</strong><small>متأخرة · {t.due ? formatDay(t.due) : ""}</small></span>
                <Icon name="forward" size={18} style={{ color: "var(--muted)" }} />
              </Link>
            ))}
            {unread > 0 && (
              <Link href="/notifications" className="attn-item info">
                <span className="ico"><Icon name="inbox" size={19} /></span>
                <span className="grow"><strong className="num">{unread} إشعار غير مقروء</strong><small>صندوق الإشعارات</small></span>
                <Icon name="forward" size={18} style={{ color: "var(--muted)" }} />
              </Link>
            )}
          </div>
        ) : (
          <div className="calm" role="status"><Icon name="check-circle" size={22} /><span><strong style={{ display: "block" }}>لا شيء ينتظرك الآن</strong><small className="muted">لا تذكيرات تنتظر إجراءً ولا مهام متأخرة.</small></span></div>
        )}
      </section>

      <div className="grid grid-lg-3" style={{ alignItems: "start" }}>
        <section className="card card-pad span-lg-2" aria-labelledby="next-h">
          <div className="section-head"><h2 id="next-h"><Icon name="activity" size={18} />التالي في جدولك</h2><Link href="/tasks" className="btn-link">كل المهام<Icon name="forward" size={16} /></Link></div>
          {!hydrated ? <div className="stack" style={{ marginBlockStart: 12 }}><Skeleton h={44} /><Skeleton h={44} /></div>
            : upcomingTasks.length || upcomingReminders.length ? (
              <ul className="timeline" style={{ marginBlockStart: 6 }}>
                {upcomingReminders.map((r) => (
                  <li key={r.id}>
                    <span className="grow"><span className="title">{r.title}</span><small className="muted num">{describeSchedule(r)}</small></span>
                    <span className="badge gold"><Icon name="clock" size={13} />تذكير</span>
                  </li>
                ))}
                {upcomingTasks.map((t) => { const d = dueState(t.due, today); return (
                  <li key={t.id}>
                    <span className="grow"><span className="title">{t.title}</span>{t.due && <small className="muted">{d === "today" ? "اليوم · " : ""}{formatDay(t.due)}</small>}</span>
                    {t.priority === "high" ? <span className="badge danger">عالية</span> : <span className="badge accent"><Icon name="tasks" size={13} />مهمة</span>}
                  </li>); })}
              </ul>
            ) : (
              <div className="empty" style={{ padding: "22px 12px" }}>
                <span className="empty-icon"><Icon name="check" size={24} /></span>
                <p>جدولك فارغ. قل لباشت «ذكرني بكرة الساعة 9 …» أو أضف مهمة.</p>
                <Link href="/tasks" className="btn btn-primary btn-sm"><Icon name="plus" size={16} />أضف مهمة</Link>
              </div>
            )}
        </section>

        <section className="card card-pad" aria-labelledby="conn-h">
          <div className="section-head"><h2 id="conn-h"><Icon name="link" size={18} />الاتصالات</h2><button className="btn-link" onClick={refresh} aria-label="إعادة فحص الخادم">إعادة الفحص</button></div>
          <div className="conn" style={{ marginBlockStart: 4 }}>
            <div className="conn-row"><span className="ico"><Icon name="server" size={18} /></span><span className="grow"><strong>الخادم</strong><small className="num">{status.server === "online" ? `الإصدار ${status.version}` : "فحص /api/health"}</small></span>
              {status.server === "checking" ? <StatusPill status="running" label="يفحص" /> : status.server === "online" ? <StatusPill status="verified" label="متصل" /> : <StatusPill status="failed" label="غير متصل" />}</div>
            <div className="conn-row"><span className="ico"><Icon name="spark" size={18} /></span><span className="grow"><strong>Claude</strong><small>{status.server === "online" && status.assistant ? "مُهيّأ على الخادم" : "لا يوجد مزوّد نماذج مفعّل"}</small></span>
              {status.server === "online" && status.assistant ? <StatusPill status="verified" label="مفعّل" /> : <StatusPill status="draft" label="غير مفعّل" />}</div>
            <Link href="/integrations" className="conn-row"><span className="ico"><Icon name="integrations" size={18} /></span><span className="grow"><strong>التكاملات</strong><small className="num">{connectedIntegrations} متصلة من {plannedIntegrations} مخطط لها</small></span><span className="badge">قيد التخطيط</span></Link>
            <div className="conn-row"><span className="ico"><Icon name="repeat" size={18} /></span><span className="grow"><strong>المزامنة</strong><small>بين الأجهزة</small></span><span className="badge">غير متاحة</span></div>
          </div>
        </section>
      </div>

      <section className="card card-pad" aria-labelledby="act-h">
        <div className="section-head"><h2 id="act-h"><Icon name="check-circle" size={18} />ما أُنجز مؤخرًا</h2><small className="muted">على هذا الجهاز · آخر 100</small></div>
        {!hydrated ? <div style={{ marginBlockStart: 12 }}><Skeleton h={40} /></div> : activity.length ? (
          <ul className="timeline" style={{ marginBlockStart: 6 }}>
            {activity.slice(0, 5).map((a) => { const m = ACTIVITY[a.status] ?? { s: "draft" as RunStatus, label: a.status }; return (
              <li key={a.id}>
                <span className="grow"><span className="title">{commandTitle(a.command)}</span><small className="muted num">{formatTime(a.ts)}</small></span>
                <StatusPill status={m.s} label={m.label} />
              </li>); })}
          </ul>
        ) : <p className="muted" style={{ marginBlockStart: 8, fontSize: 14 }}>لا نشاط بعد. ستظهر هنا كل عملية ينفّذها باشت أو تنفّذها أنت داخل التطبيق، بنتيجتها الفعلية.</p>}
      </section>

      <Notice>المحادثات والمهام والملفات محفوظة على هذا الجهاز فقط، بلا مزامنة أو نسخة احتياطية بعد. لا تحفظ بيانات حساسة حتى يُفعَّل الحساب والتشفير.</Notice>
    </div>
  );
}
