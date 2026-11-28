/**
 * ONE status model for every indicator in the app (R11). A badge is never written by hand: it is the result of a function in this file
 * applied to a real source (the app's health, the engine's /status, what a real voice call learned, push registration).
 *
 *   unknown     no data, or the source cannot say (never coloured as success)
 *   configured  set up on paper (the engine says it is ready / this device is registered) but nothing was exercised by a live call
 *   reachable   a live request just got an answer, nothing more is proven
 *   tested_ok   a live, authenticated, functional check passed (a signed round trip to the engine whose link is up; a real voice reply)
 *   degraded    works partly (link reconnecting, voice only through a fallback path)
 *   down        a live check failed, or the source says it is stopped
 *
 * Every reading carries `checkedAt` (epoch ms of the last check, or null when the source has no time). Pure: no clock, no I/O.
 */
import type { AssistantStatus } from "./assistant";
import { engineAnswered, type EngineStatus } from "./engine-status";
import type { PushState } from "./push-client";
import type { VoiceReason } from "./basht-client";
import { voiceReasonText } from "./basht-client";

export const STATUS_LEVELS = ["unknown", "configured", "reachable", "tested_ok", "degraded", "down"] as const;
export type StatusLevel = (typeof STATUS_LEVELS)[number];
export const isStatusLevel = (v: unknown): v is StatusLevel => (STATUS_LEVELS as readonly unknown[]).includes(v);

export type StatusReading = {
  level: StatusLevel;
  /** Epoch ms of the last check of THIS source; null = the source has no time (shown as «لم يُفحص بعد» only for unknown). */
  checkedAt: number | null;
  /** Optional short Arabic badge text replacing the level's generic label (e.g. «غير مفعّلة»). It never changes the level or the tone. */
  label?: string;
  /** Optional one-line Arabic explanation under the title. Never an id, a path, a hostname or raw error text. */
  detail?: string;
};
export const UNKNOWN_READING: StatusReading = { level: "unknown", checkedAt: null };
const reading = (level: StatusLevel, checkedAt: number | null, extra: Pick<StatusReading, "label" | "detail"> = {}): StatusReading => ({ level, checkedAt, ...extra });

export const STATUS_LABEL: Record<StatusLevel, string> = {
  unknown: "غير معروف", configured: "مهيّأ", reachable: "متصل", tested_ok: "يعمل", degraded: "جزئي", down: "متوقف",
};
/** Success colour is reserved for `tested_ok`. `unknown` and `configured` are neutral, `reachable` is informational. */
export const statusTone = (l: StatusLevel): "ok" | "info" | "warn" | "danger" | undefined =>
  l === "tested_ok" ? "ok" : l === "reachable" ? "info" : l === "degraded" ? "warn" : l === "down" ? "danger" : undefined;
export const statusIcon = (l: StatusLevel): "check-circle" | "link" | "alert" | "x-circle" | "info" =>
  l === "tested_ok" ? "check-circle" : l === "reachable" ? "link" : l === "degraded" ? "alert" : l === "down" ? "x-circle" : "info";
export const readingLabel = (r: StatusReading): string => r.label ?? STATUS_LABEL[r.level];

/** The worse of two levels, for combining signals about ONE source (down < degraded < unknown < configured < reachable < tested_ok). */
const RANK: Record<StatusLevel, number> = { down: 0, degraded: 1, unknown: 2, configured: 3, reachable: 4, tested_ok: 5 };
export const worse = (a: StatusLevel, b: StatusLevel): StatusLevel => (RANK[a] <= RANK[b] ? a : b);

/** «آخر فحص قبل ٣ دقائق» · null → «لم يُفحص بعد». `now` is passed in (pure). */
export function checkedText(at: number | null, now: number, relative: (ts: number, now: number) => string): string {
  if (at === null) return "لم يُفحص بعد";
  const r = relative(at, now);
  return r === "الآن" ? "آخر فحص الآن" : `آخر فحص ${r}`;
}

// ── sources ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The app's own server: the public /api/health, which runs a signed round trip to the API (and its database). */
export function readServer(app: AssistantStatus, checkedAt: number | null): StatusReading {
  if (app.server === "checking") return reading("unknown", null);
  if (app.server === "offline") return reading("down", checkedAt, { detail: "لا استجابة من الخادم" });
  return reading("tested_ok", checkedAt, { detail: app.version && app.version !== "?" ? `الإصدار ${app.version}` : undefined });
}

/** What the app has of the engine: its own status read (null = not read: signed out / not asked yet) and when. */
export type EngineSnapshot = { status: EngineStatus | null; at: number };

/**
 * «جاهزية باشت»: the ENGINE's readiness, from the signed /status the engine answers (link state) and the public gateway check.
 * It is never inferred from the old direct-Claude key. No engine configured = unknown («غير مربوط»), not down.
 */
export function readEngine(app: AssistantStatus, appCheckedAt: number | null, snap: EngineSnapshot | null): StatusReading {
  if (app.server === "checking") return reading("unknown", null);
  if (app.server === "offline") return reading("unknown", appCheckedAt, { detail: "تعذّر الوصول إلى الخادم فلا يُعرف حال المحرك" });
  if (!app.bashtChat && app.basht === "unconfigured") return reading("unknown", appCheckedAt, { label: "غير مربوط", detail: "لم يُضبط محرك باشت على الخادم" });

  const gateway: StatusLevel = app.basht === "connected" ? "reachable" : app.basht === "starting" ? "degraded" : app.basht === "offline" ? "down" : "unknown";
  const s = snap?.status ?? null;
  if (!snap || !s) {
    // not read (signed out, not asked yet): only the public gateway check speaks
    return reading(gateway, appCheckedAt, gateway === "down" ? { detail: "تعذّر الوصول إلى محرك باشت" } : gateway === "degraded" ? { detail: "محرك باشت قيد التشغيل" } : {});
  }
  if (!engineAnswered(s)) {
    // asked, no answer: the gateway answering while the app path does not is a partial failure, a dead gateway is down
    return reading(gateway === "reachable" || gateway === "degraded" ? "degraded" : "down", snap.at, { detail: gateway === "reachable" ? "المحرك يعمل لكن مسار التطبيق إليه لا يستجيب" : "تعذّر الوصول إلى محرك باشت" });
  }
  const link = s.link.state;
  let level: StatusLevel = link === "up" ? "tested_ok" : link === "connecting" ? "degraded" : link === "down" ? "degraded" : "reachable";
  if (gateway !== "reachable") level = worse(level, "degraded"); // success needs BOTH the signed read and the public gateway check to agree
  const detail = link === "up" ? undefined : link === "connecting" ? "الاتصال الداخلي بالمحرك يُعاد الآن" : link === "down" ? "الاتصال الداخلي بالمحرك منقطع" : undefined;
  return reading(level, snap.at, { ...(level === "tested_ok" ? { label: "جاهز" } : {}), ...(detail ? { detail } : {}) });
}

/** What a real voice call in this page session proved (lib/basht-voice availability), and when. */
export type VoiceLearned = { speak: "unknown" | "yes" | "no"; reason: VoiceReason | ""; at: number | null; playbackFailed?: { at: number } | null };

/**
 * The voice: `yes` means a reply's audio really PLAYED THROUGH (a fetched blob proves nothing); a real engine failure beats the
 * engine's declaration, and a playback that failed since (blocked autoplay, stall, decode) is `degraded`, never success.
 */
export function readVoice(snap: EngineSnapshot | null, learned: VoiceLearned): StatusReading {
  if (learned.playbackFailed) return reading("degraded", learned.playbackFailed.at, { detail: "وصل الصوت من المحرك لكن تعذّر تشغيله على هذا الجهاز" });
  if (learned.speak === "yes") return reading("tested_ok", learned.at, { detail: "نجح نطق حقيقي في هذه الجلسة" });
  if (learned.speak === "no") return reading("down", learned.at, { detail: voiceReasonText(learned.reason) || "تعذّر النطق في المحرك" });
  const s = snap?.status;
  if (!snap || !s || !engineAnswered(s)) return reading("unknown", null);
  const reason = s.voice.reason ? voiceReasonText(s.voice.reason) : "";
  switch (s.voice.speak) {
    case "ready": return reading("configured", snap.at, { detail: "المحرك يعلن جاهزية الصوت؛ لم يُجرَّب نطق بعد" });
    case "degraded": return reading("degraded", snap.at, { detail: reason || "الصوت متقطع الآن" });
    case "mismatch": case "unconfigured": return reading("down", snap.at, { detail: reason || "الصوت غير مضبوط في المحرك" });
    default: return reading("unknown", snap.at);
  }
}

/** Push registration of THIS device (lib/push-client getPushState); `null` = not read yet. Nothing is "tested" until the owner taps the test. */
export function readPush(state: PushState | "loading" | null, checkedAt: number | null): StatusReading {
  if (state === null || state === "loading") return reading("unknown", null);
  switch (state) {
    case "on": return reading("configured", checkedAt, { label: "مسجَّلة", detail: "هذا الجهاز مسجَّل لاستقبال الإشعارات" });
    case "off": return reading("unknown", checkedAt, { label: "غير مفعّلة", detail: "لم تُفعَّل على هذا الجهاز" });
    case "needs_install": return reading("unknown", checkedAt, { label: "تتطلب التثبيت", detail: "أضف التطبيق إلى الشاشة الرئيسية أولًا" });
    case "unsupported": return reading("unknown", checkedAt, { label: "غير مدعومة", detail: "هذا المتصفح لا يدعم الإشعارات" });
    case "denied": return reading("down", checkedAt, { label: "محظورة", detail: "حُظر الإذن في إعدادات الجهاز" });
    case "unconfigured": return reading("down", checkedAt, { label: "الخادم غير مهيأ", detail: "الإشعارات غير مضبوطة على الخادم" });
    default: return reading("down", checkedAt, { detail: "تعذّرت قراءة حالة الإشعارات" });
  }
}

/** Approvals waiting on the engine: readable only while its live link is up and the engine counted them. */
export function readApprovals(snap: EngineSnapshot | null): StatusReading {
  const s = snap?.status;
  if (!snap || !s || !engineAnswered(s)) return reading("unknown", null);
  if (s.link.state === "down" || s.link.state === "connecting") return reading("degraded", snap.at, { detail: "الاتصال بالمحرك متقطع؛ لا يمكن قراءة الموافقات الآن" });
  const n = s.runs?.approvalsPending ?? s.link.pendingApprovals;
  if (s.link.state !== "up" || n === null || n === undefined) return reading("unknown", snap.at);
  return reading("reachable", snap.at, { label: n === 0 ? "لا شيء" : `${n} بانتظارك`, detail: n === 0 ? "لا موافقات معلّقة" : "افتح الموافقات للقرار" });
}
