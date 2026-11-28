/**
 * Browser-side client for /api/basht/* (the real BASHT engine). Same-origin, cookie-authenticated (HttpOnly: this code never sees
 * the credential). Every failure becomes an Arabic message; upstream text never reaches the UI.
 */
import { parseEngineStatus, unknownEngineStatus, type EngineStatus } from "./engine-status";

export type BashtSession = { key: string; label: string; channel: string; updated_at: number; writable: boolean };
export type BashtFallback = { from: string | null; to: string | null; reason: string | null; at?: number | null };
/** B2: an image/file of one engine message. `ref` is opaque (no path ever reaches the app); `link` is a public https URL. */
export type BashtMedia = { kind: "image" | "file" | "link"; name: string; ref?: string; mime?: string | null; size?: number | null; available?: boolean; url?: string };
/** `provider`/`model`: the model that actually wrote an assistant reply (as the engine recorded it), with any fallback.
 *  `kind: "reset"` (role "system") marks «محادثة جديدة» in the engine's record; `id` is the engine's message id (B1). */
export type BashtMessage = { role: "user" | "assistant" | "system"; text: string; at: number; provider?: string | null; model?: string | null; fallback?: BashtFallback;
  id?: string | null; kind?: "reset"; media?: BashtMedia[];
  /** Optional: the run / idempotency key of an owner message, when the engine exposes it (the strongest match for a local photo copy). */
  runId?: string | null };
/** B1: a tool BASHT is using in the running turn (name only, never its arguments). */
export type BashtStep = { tool: string; done: boolean };
/** `errorCode`: why a failed run failed, when the engine says so (additive; only "rate_limited" is acted on, see lib/run-error). */
export type BashtRun = { status: "running" | "done" | "error" | "stopped"; text: string; failed: boolean; errorCode?: string; firstTokenMs?: number | null; totalMs?: number | null; steps?: BashtStep[] };
/** One page of a conversation: `earlier` is the cursor for older rows (also across «محادثة جديدة»), or null. */
export type BashtPage = { messages: BashtMessage[]; earlier: string | null; hasMore: boolean; nextOffset: number | null };
export type BashtHit = { key: string; label: string; message_id: string; role: "user" | "assistant"; at: number; snippet: string };
export type BashtImage = { mime: string; data: string };

/** One model the engine offers this agent (models.list, the agent's allowlist). Nothing here is invented by the app. */
export type BashtModel = {
  id: string; name: string; provider: string | null; provider_name: string | null; available: boolean; unavailable_reason: string | null;
  unavailable_until: number | null; context_window: number | null; reasoning: boolean; thinking_levels: string[]; thinking_default: string | null;
  fast_mode: boolean; tools: boolean | null; input: string[]; recommended: boolean; selectable: boolean;
};
/** The app conversation's current settings, as the engine reports them. */
export type BashtModelState = {
  /** override: the owner pinned it · fallback: OpenClaw switched temporarily after a failure · default: BASHT's default */
  model: { id: string | null; provider: string | null; source: "override" | "fallback" | "default" };
  thinking: { level: string | null; default: string | null; effective: string | null; levels: string[] };
  fast: { supported: boolean | null; enabled: boolean | null };
  usage: { input_tokens: number | null; output_tokens: number | null; context_tokens: number | null; context_window: number | null };
  last_reply: { provider: string | null; model: string | null; fallback?: BashtFallback; at: number | null } | null;
  fallback: BashtFallback | null;
  last_run: { status: string | null; first_token_ms: number | null; total_ms: number | null } | null;
};

export const BASHT_ERROR_TEXT: Record<string, string> = {
  unauthorized: "يلزم فتح جلسة باشت برمز وصول المالك.", disabled: "محادثة باشت غير مفعّلة على الخادم.", forbidden: "غير مصرّح بهذا الطلب.",
  rate_limited: "طلبات كثيرة؛ انتظر قليلًا ثم أعد المحاولة.", busy: "باشت ينفّذ طلبًا سابقًا الآن؛ انتظر حتى يكتمل.",
  unknown_model: "هذا النموذج غير موجود في قائمة باشت المعتمدة.", model_unavailable: "هذا النموذج غير متاح الآن.",
  model_not_selectable: "لا يمكن اختيار هذا النموذج يدويًا.", unsupported_level: "النموذج الحالي لا يدعم مستوى التفكير هذا.",
  fast_mode_unsupported: "النموذج الحالي لا يدعم الوضع السريع.", rejected: "رفض المحرك هذا التغيير.",
  model_control_unavailable: "التحكم بالنماذج غير متاح في نسخة المحرك الحالية.",
  voice_unavailable: "صوت باشت غير مفعّل في المحرك الآن.", no_speech: "لم أسمع كلامًا واضحًا في التسجيل. حاول مرة أخرى.",
  unsupported_audio: "صيغة التسجيل غير مدعومة في هذا المتصفح.",
  too_many_images: "يمكن إرسال 8 صور كحد أقصى في الرسالة.", image_too_large: "إحدى الصور كبيرة جدًا (الحد 10 ميجابايت).",
  images_too_large: "الصور كبيرة جدًا معًا؛ أرسل عددًا أقل.", unsupported_image: "نوع الصورة غير مدعوم.",
  // one code from two routes (voice note 413, media file 413): one text that fits both
  too_large: "الحجم أكبر من الحد المسموح (التسجيل الصوتي حتى 3 دقائق).", unsupported: "نوع الملف غير مدعوم للعرض.",
  not_found: "المحادثة غير متاحة.", bad_request: "طلب غير صالح.", unavailable: "تعذّر الوصول إلى محرك باشت الآن.", network: "انقطع الاتصال بالخادم.",
  timeout: "تأخّر الرد طويلًا فأُوقف الطلب. أعد المحاولة.",
};
export const bashtErrorText = (code: string) => BASHT_ERROR_TEXT[code] ?? BASHT_ERROR_TEXT.unavailable;
/** The engine answered and DID NOT take the request (validation, auth, limits, busy). A network error, a timeout or a 5xx may have reached it. */
const REFUSAL_CODES = new Set(["bad_request", "unauthorized", "forbidden", "disabled", "rate_limited", "busy", "too_many_images", "image_too_large", "images_too_large", "unsupported_image", "too_large", "unsupported"]);

/**
 * Why BASHT's engine voice is unavailable (`reason` of a voice error / voice-status). A fixed list identical to the shared contract
 * (services/api/tests/fixtures/voice-contract.json — a test compares them); never upstream text.
 */
export const VOICE_REASONS = ["identity_mismatch", "tool_denied", "unconfigured", "provider_error", "link_down", "timeout", "bad_audio", "engine_error",
  "in_flight", "per_minute", "text_rejected", "tool_path_only", "tool_path_unavailable", "no_tts_config", "config_unreadable"] as const;
export type VoiceReason = (typeof VOICE_REASONS)[number];
export const isVoiceReason = (v: unknown): v is VoiceReason => (VOICE_REASONS as readonly unknown[]).includes(v);
export const VOICE_REASON_TEXT: Record<VoiceReason, string> = {
  identity_mismatch: "صوت باشت موقوف: المحرك المتصل لا يطابق هوية باشت المعتمدة في التطبيق.",
  tool_denied: "أداة النطق غير مسموحة لباشت في إعدادات المحرك.",
  unconfigured: "لم يُضبط صوت باشت (النطق) في المحرك بعد.",
  no_tts_config: "لا توجد إعدادات نطق لباشت في المحرك.",
  config_unreadable: "تعذّرت قراءة إعدادات صوت باشت في المحرك.",
  tool_path_unavailable: "مسار أداة النطق غير متاح في المحرك.",
  provider_error: "مزوّد الصوت رفض الطلب أو تعذّر الآن (قد يكون الرصيد أو الحصة).",
  link_down: "الاتصال بمحرك باشت منقطع الآن.",
  timeout: "تأخّر مزوّد الصوت في الرد فانتهت المهلة.",
  bad_audio: "لم يُنتج المحرك صوتًا صالحًا لهذا الرد.",
  engine_error: "تعذّر على محرك باشت تجهيز الصوت الآن.",
  in_flight: "طلب صوت سابق ما زال قيد التنفيذ؛ انتظر قليلًا.",
  per_minute: "طلبات صوت كثيرة في الدقيقة؛ انتظر قليلًا ثم أعد المحاولة.",
  text_rejected: "رفض المحرك نطق هذا النص.",
  tool_path_only: "النطق متاح الآن عبر أداة المحرك فقط؛ أعد المحاولة لاحقًا.",
};
/**
 * Configuration failures that will not fix themselves on the next try: the UI hides «استمع» / the live voice for the page
 * session. Every other contract reason is TRANSIENT (controls stay; «أعد المحاولة»).
 */
export const DURABLE_VOICE_REASONS: readonly VoiceReason[] = ["identity_mismatch", "tool_denied", "unconfigured", "no_tts_config", "config_unreadable", "tool_path_unavailable"];
export const TRANSIENT_VOICE_REASONS: readonly VoiceReason[] = ["provider_error", "timeout", "link_down", "engine_error", "in_flight", "per_minute", "text_rejected", "bad_audio", "tool_path_only"];
export const voiceReasonText = (reason: string | null | undefined): string => (isVoiceReason(reason) ? VOICE_REASON_TEXT[reason] : "");

export class BashtError extends Error {
  /**
   * `reason`: the allowlisted cause of a voice error (POST speak / transcribe). `reasonGiven`: the server sent a reason at all —
   * an unknown token (newer engine) is given-but-unknown, which is never treated as a configuration failure.
   */
  constructor(public code: string, public reason?: VoiceReason, public reasonGiven: boolean = reason !== undefined) {
    super(code === "voice_unavailable" && reason ? `${bashtErrorText(code)} ${VOICE_REASON_TEXT[reason]}` : bashtErrorText(code));
    this.name = "BashtError";
  }
}

/** GET /api/basht/voice-status: what the engine says about BASHT's voice (always answers; "unknown" when it cannot tell). */
export type VoiceSpeakState = "ready" | "degraded" | "unconfigured" | "mismatch" | "unknown";
export type VoiceStatus = { speak: VoiceSpeakState; reason?: VoiceReason; features: string[] };
export const UNKNOWN_VOICE_STATUS: VoiceStatus = { speak: "unknown", features: [] };
const SPEAK_STATES: readonly string[] = ["ready", "degraded", "unconfigured", "mismatch", "unknown"];
export function parseVoiceStatus(j: unknown): VoiceStatus {
  const o = (j && typeof j === "object" ? j : {}) as { speak?: unknown; reason?: unknown; features?: unknown };
  if (typeof o.speak !== "string" || !SPEAK_STATES.includes(o.speak)) return { ...UNKNOWN_VOICE_STATUS };
  const features = Array.isArray(o.features) ? o.features.filter((f): f is string => typeof f === "string").slice(0, 32) : [];
  return { speak: o.speak as VoiceSpeakState, ...(isVoiceReason(o.reason) ? { reason: o.reason } : {}), features };
}
const errorOf = (body: unknown): BashtError => {
  const b = body as { error?: unknown; reason?: unknown } | null;
  const given = typeof b?.reason === "string" && b.reason.length > 0;
  return new BashtError(typeof b?.error === "string" ? b.error : "unavailable", isVoiceReason(b?.reason) ? b.reason : undefined, given);
};

type Fetch = typeof fetch;
/** The longest one /speak request may take before the client gives up (a hung request never leaves «يجهّز الصوت…» forever). */
export const SPEAK_TIMEOUT_MS = 45_000;
/** An AbortSignal that aborts with `outer` or after `ms`; `timedOut()` tells which. */
export function linkedSignal(outer: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  let timed = false;
  const onAbort = () => ctl.abort();
  if (outer?.aborted) ctl.abort(); else outer?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timed = true; ctl.abort(); }, ms);
  return { signal: ctl.signal, timedOut: () => timed, done: () => { clearTimeout(timer); outer?.removeEventListener("abort", onAbort); } };
}

export function createBashtClient(fetchImpl: Fetch = (...a) => fetch(...a), opts: { speakTimeoutMs?: number } = {}) {
  const speakMs = opts.speakTimeoutMs ?? SPEAK_TIMEOUT_MS;
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let res: Response;
    try { res = await fetchImpl(`/api/basht/${path}`, { credentials: "same-origin", cache: "no-store", ...init }); } catch { throw new BashtError("network"); }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw errorOf(body);
    return body as T;
  };
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    async status(): Promise<{ enabled: boolean; authenticated: boolean }> {
      try { const s = await call<{ enabled?: unknown; authenticated?: unknown }>("status"); return { enabled: s.enabled === true, authenticated: s.authenticated === true }; }
      catch { return { enabled: false, authenticated: false }; }
    },
    async unlock(code: string): Promise<boolean> { try { await call("session", post({ code })); return true; } catch { return false; } },
    async lock(): Promise<void> { try { await call("session", { method: "DELETE" }); } catch { /* expires by itself */ } },
    sessions: async () => (await call<{ sessions: BashtSession[] }>("sessions")).sessions,
    history: async (key: string) => (await call<{ messages: BashtMessage[] }>(`history?key=${encodeURIComponent(key)}`)).messages,
    /** B1: a page with paging info; `before` = an `earlier` cursor, `around` = a message id (search hit), `offset` = engine offset. */
    historyPage: async (key: string, at: { before?: string; around?: string; offset?: number } = {}): Promise<BashtPage> => {
      const q = at.before ? `&before=${encodeURIComponent(at.before)}` : at.around ? `&around=${encodeURIComponent(at.around)}` : at.offset !== undefined ? `&offset=${at.offset}` : "";
      const j = await call<{ messages?: BashtMessage[]; earlier?: unknown; has_more?: unknown; next_offset?: unknown }>(`history?key=${encodeURIComponent(key)}${q}`);
      return { messages: Array.isArray(j.messages) ? j.messages : [], earlier: typeof j.earlier === "string" ? j.earlier : null,
        hasMore: j.has_more === true, nextOffset: typeof j.next_offset === "number" ? j.next_offset : null };
    },
    /** B2: one owner turn with photos (already downscaled/re-encoded by lib/image-prep). */
    sendMedia: async (message: string, images: BashtImage[]) => (await call<{ runId: string }>("send-media", post({ message, images }))).runId,
    /** B1: «محادثة جديدة» — the engine starts a fresh context; earlier messages stay readable. */
    newConversation: () => call<{ at: number | null; earlier: boolean }>("new", post({})),
    search: async (q: string) => (await call<{ results: BashtHit[] }>(`search?q=${encodeURIComponent(q)}`)).results,
    send: async (message: string) => (await call<{ runId: string }>("send", post({ message }))).runId,
    run: (id: string) => call<BashtRun>(`runs/${id}`),
    stop: async (id: string) => { await call(`runs/${id}/stop`, post({})); },
    models: async () => (await call<{ models: BashtModel[] }>("models")).models,
    modelState: () => call<BashtModelState>("model"),
    setModel: async (model: string) => { await call("model", post({ model })); },
    setThinking: async (level: string) => { await call("thinking", post({ level })); },
    setFast: async (mode: "on" | "off" | "default") => { await call("fast", post({ mode })); },
    /** One chunk (≤ 1500 chars) spoken in BASHT's own voice (the engine's config). Resolves with the audio. */
    async speak(text: string, signal?: AbortSignal): Promise<Blob> {
      const link = linkedSignal(signal, speakMs);
      const fail = (e: unknown) => { if (link.timedOut()) return new BashtError("timeout"); if (signal?.aborted) return e; return new BashtError("network"); };
      try {
        let res: Response;
        try { res = await fetchImpl("/api/basht/speak", { credentials: "same-origin", cache: "no-store", ...post({ text }), signal: link.signal }); }
        catch (e) { throw fail(e); }
        const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
        if (res.ok && type.startsWith("audio/")) {
          try { return await res.blob(); } catch (e) { throw fail(e); }
        }
        let body: unknown = null;
        try { body = await res.json(); } catch { /* not JSON */ }
        throw errorOf(body);
      } finally { link.done(); }
    },
    /** What the engine says about BASHT's voice. Never throws: any failure is `{ speak: "unknown", features: [] }`. */
    async voiceStatus(): Promise<VoiceStatus> {
      try {
        const res = await fetchImpl("/api/basht/voice-status", { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) return { ...UNKNOWN_VOICE_STATUS };
        return parseVoiceStatus(await res.json());
      } catch { return { ...UNKNOWN_VOICE_STATUS }; }
    },
    /**
     * What the engine says about itself (/api/basht/engine-status), validated again here. `null` = it was not asked successfully
     * (signed out, BASHT disabled): the caller must treat that as "no data", never as down. A network failure or a non-answer is
     * `{ reachable: false }` (asked, nobody answered). Never throws.
     */
    async engineStatus(): Promise<EngineStatus | null> {
      try {
        const res = await fetchImpl("/api/basht/engine-status", { credentials: "same-origin", cache: "no-store" });
        // no data (not asked successfully): signed out, BASHT off, a rate limit, an outage of the door, or a route an older deploy lacks
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 429 || res.status === 503) return null;
        if (!res.ok) return unknownEngineStatus();
        return parseEngineStatus(await res.json());
      } catch { return unknownEngineStatus(); }
    },
    /** A voice note → the engine's transcript (its own audio config, as on WhatsApp). */
    transcribe: async (audio: Blob, signal?: AbortSignal) => {
      const type = (audio.type || "audio/webm").split(";")[0].trim();
      return (await call<{ text: string }>("transcribe", { method: "POST", headers: { "content-type": type }, body: audio, signal })).text;
    },
  };
}
export const bashtClient = createBashtClient();
/** Same-origin URL of one media item (served with the owner session, never cached by shared caches). */
export const bashtMediaUrl = (key: string, msg: string, ref: string) =>
  `/api/basht/media?key=${encodeURIComponent(key)}&msg=${encodeURIComponent(msg)}&ref=${encodeURIComponent(ref)}`;

export const isDefiniteRefusal = (e: unknown): boolean => e instanceof BashtError && REFUSAL_CODES.has(e.code);
