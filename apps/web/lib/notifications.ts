/** Notification-centre domain: inbox items, filtering, idempotent insertion. Pure. */
export type NoticeType = "reminder" | "task" | "assistant" | "system" | "security";
export type NoticePriority = "low" | "normal" | "high" | "critical";
export const NOTICE_TYPES: NoticeType[] = ["reminder", "task", "assistant", "system", "security"];
export const NOTICE_PRIORITIES: NoticePriority[] = ["critical", "high", "normal", "low"];
export const TYPE_LABEL: Record<NoticeType, string> = { reminder: "تذكير", task: "مهمة", assistant: "المساعد", system: "النظام", security: "الأمان" };
export const NOTICE_PRIORITY_LABEL: Record<NoticePriority, string> = { critical: "حرجة", high: "عالية", normal: "عادية", low: "منخفضة" };
export const NOTICE_LIMIT = 300;

export type Notice = {
  id: string;
  /** idempotency key: inserting the same key twice never creates a second item */
  key: string;
  type: NoticeType;
  priority: NoticePriority;
  title: string;
  body?: string;
  created: number;
  read: boolean;
  archived?: boolean;
  /** internal path only (validated) */
  href?: string;
  reminderId?: string;
};

/** Only same-origin app paths may be opened from a notification (no open redirects / javascript: URLs). */
export function safeHref(h: unknown): string | undefined {
  if (typeof h !== "string" || h.length > 200) return undefined;
  if (!h.startsWith("/") || h.startsWith("//") || h.includes("\\") || /[\u0000-\u001f]/.test(h)) return undefined;
  return h;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function parseNotices(value: unknown): Notice[] {
  if (!Array.isArray(value)) return [];
  const out: Notice[] = [];
  const keys = new Set<string>();
  for (const v of value) {
    if (!isObj(v) || typeof v.id !== "string" || typeof v.key !== "string" || typeof v.title !== "string" || typeof v.created !== "number" || !Number.isFinite(v.created)) continue;
    if (!NOTICE_TYPES.includes(v.type as NoticeType) || !NOTICE_PRIORITIES.includes(v.priority as NoticePriority) || keys.has(v.key)) continue;
    keys.add(v.key);
    const n: Notice = { id: v.id, key: v.key.slice(0, 200), type: v.type as NoticeType, priority: v.priority as NoticePriority, title: v.title.slice(0, 200), created: v.created, read: v.read === true };
    if (typeof v.body === "string" && v.body) n.body = v.body.slice(0, 1000);
    if (v.archived === true) n.archived = true;
    const href = safeHref(v.href); if (href) n.href = href;
    if (typeof v.reminderId === "string") n.reminderId = v.reminderId.slice(0, 80);
    out.push(n);
    if (out.length >= NOTICE_LIMIT) break;
  }
  return out;
}

/** Adds a notice unless one with the same key exists. Newest first, capped (oldest read+archived dropped first). */
export function insertNotice(list: Notice[], n: Notice): { list: Notice[]; inserted: boolean } {
  if (list.some((x) => x.key === n.key)) return { list, inserted: false };
  let next = [n, ...list];
  if (next.length > NOTICE_LIMIT) {
    const drop = [...next].reverse().find((x) => x.read) ?? next[next.length - 1];
    next = next.filter((x) => x !== drop);
  }
  return { list: next, inserted: true };
}

export const unreadCount = (list: Notice[]) => list.filter((n) => !n.read && !n.archived).length;
export type Tab = "inbox" | "unread" | "archived";
export type NoticeFilter = { tab: Tab; type?: NoticeType | "all"; priority?: NoticePriority | "all"; query?: string };
const WEIGHT: Record<NoticePriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
export function filterNotices(list: Notice[], f: NoticeFilter): Notice[] {
  const q = (f.query ?? "").trim().toLowerCase();
  return list
    .filter((n) => (f.tab === "archived" ? !!n.archived : !n.archived && (f.tab === "unread" ? !n.read : true)))
    .filter((n) => !f.type || f.type === "all" || n.type === f.type)
    .filter((n) => !f.priority || f.priority === "all" || n.priority === f.priority)
    .filter((n) => !q || (n.title + " " + (n.body ?? "")).toLowerCase().includes(q))
    .sort((a, b) => (f.tab === "unread" ? WEIGHT[a.priority] - WEIGHT[b.priority] : 0) || b.created - a.created);
}
