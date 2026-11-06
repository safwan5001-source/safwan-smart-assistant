"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Icon, { type IconName } from "@/components/icon";
import { Badge, Empty, ListSkeleton, Notice, PageHeader } from "@/components/ui";
import { useDialogs } from "@/components/dialogs";
import { useHydrated, useStore, useStoreError } from "@/lib/hooks";
import { noticesStore } from "@/lib/stores";
import { runCommand } from "@/lib/commands";
import {
  NOTICE_PRIORITIES, NOTICE_PRIORITY_LABEL, NOTICE_TYPES, TYPE_LABEL, filterNotices, unreadCount,
  type Notice as Item, type NoticePriority, type NoticeType, type Tab,
} from "@/lib/notifications";

const TYPE_ICON: Record<NoticeType, IconName> = { reminder: "clock", task: "tasks", assistant: "spark", system: "info", security: "shield" };
const TONE: Record<NoticePriority, "danger" | "warn" | "info" | undefined> = { critical: "danger", high: "warn", normal: undefined, low: undefined };
const ago = (ts: number, now: number) => {
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return "الآن";
  if (m < 60) return `قبل ${m} دقيقة`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "قبل ساعة" : h === 2 ? "قبل ساعتين" : `قبل ${h} ساعات`;
  return new Intl.DateTimeFormat("ar-SA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ts);
};

export default function NotificationsScreen() {
  const hydrated = useHydrated();
  const router = useRouter();
  const list = useStore(noticesStore);
  const err = useStoreError(noticesStore);
  const { confirm, toast } = useDialogs();
  const [tab, setTab] = useState<Tab>("inbox");
  const [type, setType] = useState<NoticeType | "all">("all");
  const [priority, setPriority] = useState<NoticePriority | "all">("all");
  const [query, setQuery] = useState("");
  const now = useMemo(() => (hydrated ? Date.now() : 0), [hydrated, list]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => filterNotices(list, { tab, type, priority, query }), [list, tab, type, priority, query]);
  const unread = unreadCount(list);
  const archivedCount = list.filter((n) => n.archived).length;
  const inboxCount = list.filter((n) => !n.archived).length;

  const open = async (n: Item) => {
    const res = await runCommand("notifications.open", { id: n.id });
    if (res.status === "executed" && res.data) router.push(res.data);
  };
  const markAll = async () => { const r = await runCommand("notifications.mark_all_read", {}); if (r.status === "executed") toast(r.data ? `عُلّمت ${r.data} إشعاراً كمقروء` : "لا إشعارات غير مقروءة"); };
  const clearArchived = async () => {
    if (!(await confirm({ title: "حذف الإشعارات المؤرشفة؟", message: `سيتم حذف ${archivedCount} إشعاراً مؤرشفاً نهائياً.`, confirmLabel: "حذف", tone: "danger" }))) return;
    await runCommand("notifications.clear_archived", {}, { approved: true }); toast("تم الحذف");
  };

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "inbox", label: "الوارد", count: inboxCount }, { id: "unread", label: "غير المقروءة", count: unread }, { id: "archived", label: "المؤرشفة", count: archivedCount },
  ];
  return (
    <div className="page">
      <PageHeader icon="bell" eyebrow="الإشعارات" title="مركز الإشعارات" description="كل تنبيه وصلك يُحفظ هنا على هذا الجهاز، حتى لو فاتك صوته."
        actions={<button className="btn" onClick={() => void markAll()} disabled={!unread}><Icon name="check" size={18} />تعليم الكل كمقروء</button>} />
      {err && <Notice tone="warn" role="alert">{err}</Notice>}
      <div className="stack">
        <div className="search"><Icon name="search" size={18} />
          <input className="input" type="search" aria-label="البحث في الإشعارات" placeholder="ابحث في الإشعارات" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="chips" role="group" aria-label="أقسام الإشعارات">
          {tabs.map((t) => <button key={t.id} className="chip" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}<span className="count num">{t.count}</span></button>)}
        </div>
        <div className="grid grid-2">
          <label className="field"><span className="sr-only">النوع</span>
            <select className="select" aria-label="تصفية حسب النوع" value={type} onChange={(e) => setType(e.target.value as NoticeType | "all")}>
              <option value="all">كل الأنواع</option>{NOTICE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
          <label className="field"><span className="sr-only">الأهمية</span>
            <select className="select" aria-label="تصفية حسب الأهمية" value={priority} onChange={(e) => setPriority(e.target.value as NoticePriority | "all")}>
              <option value="all">كل المستويات</option>{NOTICE_PRIORITIES.map((p) => <option key={p} value={p}>{NOTICE_PRIORITY_LABEL[p]}</option>)}</select></label>
        </div>
      </div>
      <section aria-label="قائمة الإشعارات" aria-live="polite">
        {!hydrated ? <ListSkeleton rows={4} h={76} /> : shown.length ? (
          <ul className="stack">
            {shown.map((n) => (
              <li key={n.id} className={"notice-item " + (n.read ? "read " : "unread ") + n.priority}>
                <span className={"notice-ico " + n.priority}><Icon name={TYPE_ICON[n.type]} size={20} /></span>
                <button className="notice-body" onClick={() => void open(n)} aria-label={`${n.read ? "" : "غير مقروء: "}${n.title}`}>
                  <span className="notice-title">{!n.read && <span className="unread-dot" aria-hidden="true" />}{n.title}</span>
                  {n.body && <span className="notice-text">{n.body}</span>}
                  <span className="task-meta">
                    <Badge>{TYPE_LABEL[n.type]}</Badge>
                    {TONE[n.priority] !== undefined || n.priority === "critical" ? <Badge tone={TONE[n.priority]}>{NOTICE_PRIORITY_LABEL[n.priority]}</Badge> : null}
                    <span className="muted num" style={{ fontSize: 12 }}>{ago(n.created, now)}</span>
                  </span>
                </button>
                <div className="notice-actions">
                  <button className="icon-btn sm" onClick={() => void runCommand("notifications.mark_read", { id: n.id, read: !n.read })} aria-label={n.read ? "تعليم كغير مقروء" : "تعليم كمقروء"}><Icon name={n.read ? "inbox" : "check"} size={18} /></button>
                  <button className="icon-btn sm" onClick={() => void runCommand("notifications.archive", { id: n.id })} aria-label={n.archived ? "استعادة" : "أرشفة"}><Icon name="archive" size={18} /></button>
                  <button className="icon-btn sm" onClick={() => void runCommand("notifications.remove", { id: n.id })} aria-label="حذف"><Icon name="trash" size={18} /></button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card"><Empty icon={list.length ? "search" : "bell"} title={list.length ? "لا إشعارات في هذا العرض" : "لا إشعارات بعد"}>
            {list.length ? "غيّر القسم أو التصفية." : "ستظهر هنا تنبيهات التذكيرات والمهام والنظام عندما تصل."}</Empty></div>
        )}
        {tab === "archived" && archivedCount > 0 && <div style={{ marginBlockStart: 12 }}><button className="btn btn-sm btn-danger" onClick={() => void clearArchived()}><Icon name="trash" size={16} />حذف المؤرشفة</button></div>}
      </section>
    </div>
  );
}
