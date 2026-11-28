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
export type EngineSnapshot = {
  status: EngineStatus | null;
  /** When this app asked (fetch time): drives the display and the 30 s throttle only. */
  at: number;
  /** When the engine really answered (fetch time minus the API's reported age); null = unknown. The ONLY time evidence is ordered by. */
  observedAt?: number | null;
};
/** The time to SHOW for an engine reading: the observation when known, else when it was asked. */
const shownAt = (s: EngineSnapshot): number => s.observedAt ?? s.at;

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
  // The two sources are read at different times (the public health at load / on focus, the engine's own status on its own 30 s clock).
  // The gateway half only counts while it is AT LEAST AS NEW as the engine read: an older «starting» / «offline» never degrades a
  // fresher signed read, and the row is stamped with the OLDER of the sources it actually used.
  const engAt = shownAt(snap);
  const gwAt = appCheckedAt ?? 0;
  const gwCounts = gwAt >= engAt;
  const usedAt = gwCounts ? Math.min(engAt, gwAt) : engAt;
  if (!engineAnswered(s)) {
    // asked, no answer: a fresh gateway answering while the app path does not is a partial failure, a dead one is down; with only an
    // older gateway reading nothing more than «could not read» can be said
    // (an older «offline» gateway reading that AGREES with the failed read is still evidence of a dead engine)
    if (!gwCounts && gateway !== "down") return reading("degraded", engAt, { detail: "تعذّرت قراءة حالة المحرك الآن" });
    return reading(gateway === "reachable" || gateway === "degraded" ? "degraded" : "down", usedAt, { detail: gateway === "reachable" ? "المحرك يعمل لكن مسار التطبيق إليه لا يستجيب" : "تعذّر الوصول إلى محرك باشت" });
  }
  const link = s.link.state;
  let level: StatusLevel = link === "up" ? "tested_ok" : link === "connecting" ? "degraded" : link === "down" ? "degraded" : "reachable";
  let detail = link === "up" ? undefined : link === "connecting" ? "الاتصال الداخلي بالمحرك يُعاد الآن" : link === "down" ? "الاتصال الداخلي بالمحرك منقطع" : undefined;
  if (gwCounts && gateway !== "reachable") { // success needs the signed read AND a gateway check that is not older to agree
    level = worse(level, "degraded");
    detail ??= "بوابة المحرك لم تكن جاهزة عند آخر فحص";
  }
  return reading(level, usedAt, { ...(level === "tested_ok" ? { label: "جاهز" } : {}), ...(detail ? { detail } : {}) });
}

/**
 * What real voice calls in this page session showed (lib/basht-voice availability): `speak` yes/no with the time of that answer,
 * `failed` = the newest attempt that did not play through (playback failure or a transient engine failure) with its allow-listed
 * reason, `transcribe` = what a real transcription showed.
 */
export type VoiceLearned = {
  speak: "unknown" | "yes" | "no"; reason: VoiceReason | ""; at: number | null;
  failed?: { at: number; kind?: string; reason?: VoiceReason | "" } | null; transcribe?: "unknown" | "yes" | "no";
};

const learnedVoice = (l: VoiceLearned): StatusReading | null => {
  const yesAt = l.speak === "yes" ? l.at ?? 0 : -1;
  if (l.failed && l.failed.at >= yesAt) {
    const why = l.failed.kind === "unavailable" ? voiceReasonText(l.failed.reason || "") || "تعذّر النطق في المحرك الآن" : "وصل الصوت من المحرك لكن تعذّر تشغيله على هذا الجهاز";
    return reading("degraded", l.failed.at, { detail: why });
  }
  if (l.speak === "yes") return reading("tested_ok", l.at, { detail: "نجح نطق حقيقي في هذه الجلسة" });
  if (l.speak === "no") return reading("down", l.at, { detail: voiceReasonText(l.reason) || "تعذّر النطق في المحرك" });
  return null;
};
const engineVoice = (snap: EngineSnapshot | null): StatusReading | null => {
  const s = snap?.status;
  if (!snap || !s || !engineAnswered(s)) return null;
  const reason = s.voice.reason ? voiceReasonText(s.voice.reason) : "";
  switch (s.voice.speak) {
    case "ready": return reading("configured", shownAt(snap), { detail: "المحرك يعلن جاهزية الصوت؛ لم يُجرَّب نطق بعد" });
    case "degraded": return reading("degraded", shownAt(snap), { detail: reason || "الصوت متقطع الآن" });
    case "mismatch": case "unconfigured": return reading("down", shownAt(snap), { detail: reason || "الصوت غير مضبوط في المحرك" });
    default: return null;
  }
};

/**
 * The voice. Two kinds of evidence, the NEWER wins (a tie: the worse):
 *  - what this app's own real calls showed (a reply that played through = tested_ok; a failed attempt = degraded; a configuration
 *    failure = down), and
 *  - what the engine says now. An engine «ready» is only a declaration: it never downgrades a newer real success and never hides a
 *    real failure, but a NEWER engine «degraded / mismatch / unconfigured» beats an older real success.
 * A real transcription failure folds in with worse(): the row is never better than «جزئي» while dictation to the engine is broken.
 */
export function readVoice(snap: EngineSnapshot | null, learned: VoiceLearned): StatusReading {
  const eng = engineVoice(snap), lea = learnedVoice(learned);
  let out: StatusReading;
  if (!lea) out = eng ?? reading("unknown", null);
  else if (!eng) out = lea;
  else {
    const engNegative = eng.level === "degraded" || eng.level === "down";
    // evidence is ordered by when the ENGINE answered, never by when this app asked: a cached answer re-fetched after a real playback
    // is old evidence, and an answer of unknown age (an older API) is the oldest of all: it can never override a real event
    const engTime = snap?.observedAt ?? -1, leaTime = lea.checkedAt ?? 0;
    if (engNegative) out = engTime > leaTime ? eng : engTime < leaTime ? lea : RANK[eng.level] <= RANK[lea.level] ? eng : lea;
    else out = lea.level === "down" && engTime > leaTime ? eng : lea; // a «ready» declaration only replaces an OLDER configuration failure
  }
  if (learned.transcribe === "no" && RANK[out.level] > RANK.degraded) {
    return reading("degraded", out.checkedAt, { detail: "تفريغ الصوت في المحرك غير متاح الآن" + (out.level === "tested_ok" ? "؛ النطق نجح" : "") });
  }
  return out;
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

/**
 * Approvals waiting on the engine: readable only while its live link is up and the engine counted them. A count of 0 from a run list
 * the engine says is NOT complete is no all-clear («غير معروف»); a positive count from one is «على الأقل n». When the engine's own
 * `runs` block is there but could not count approvals, the link's own (possibly not yet synced) counter is never used instead.
 */
export function readApprovals(snap: EngineSnapshot | null): StatusReading {
  const s = snap?.status;
  if (!snap || !s || !engineAnswered(s)) return reading("unknown", null);
  if (s.link.state === "down" || s.link.state === "connecting") return reading("degraded", shownAt(snap), { detail: "الاتصال بالمحرك متقطع؛ لا يمكن قراءة الموافقات الآن" });
  const n = s.runs ? s.runs.approvalsPending : s.link.pendingApprovals;
  if (s.link.state !== "up" || n === null || n === undefined) return reading("unknown", shownAt(snap));
  const partial = s.runs !== null && !s.runs.complete;
  if (partial) {
    return n === 0 ? reading("unknown", shownAt(snap), { detail: "قراءة المحرك غير مكتملة؛ لا يمكن الجزم بخلوّ الموافقات" })
      : reading("reachable", shownAt(snap), { label: `على الأقل ${n}`, detail: "قراءة المحرك غير مكتملة؛ افتح الموافقات للقرار" });
  }
  return reading("reachable", shownAt(snap), { label: n === 0 ? "لا شيء" : `${n} بانتظارك`, detail: n === 0 ? "لا موافقات معلّقة" : "افتح الموافقات للقرار" });
}
