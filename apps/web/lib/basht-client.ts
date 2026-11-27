/**
 * Browser-side client for /api/basht/* (the real BASHT engine). Same-origin, cookie-authenticated (HttpOnly: this code never sees
 * the credential). Every failure becomes an Arabic message; upstream text never reaches the UI.
 */
export type BashtSession = { key: string; label: string; channel: string; updated_at: number; writable: boolean };
export type BashtFallback = { from: string | null; to: string | null; reason: string | null; at?: number | null };
/** B2: an image/file of one engine message. `ref` is opaque (no path ever reaches the app); `link` is a public https URL. */
export type BashtMedia = { kind: "image" | "file" | "link"; name: string; ref?: string; mime?: string | null; size?: number | null; available?: boolean; url?: string };
/** `provider`/`model`: the model that actually wrote an assistant reply (as the engine recorded it), with any fallback.
 *  `kind: "reset"` (role "system") marks «محادثة جديدة» in the engine's record; `id` is the engine's message id (B1). */
export type BashtMessage = { role: "user" | "assistant" | "system"; text: string; at: number; provider?: string | null; model?: string | null; fallback?: BashtFallback;
  id?: string | null; kind?: "reset"; media?: BashtMedia[] };
/** B1: a tool BASHT is using in the running turn (name only, never its arguments). */
export type BashtStep = { tool: string; done: boolean };
export type BashtRun = { status: "running" | "done" | "error" | "stopped"; text: string; failed: boolean; firstTokenMs?: number | null; totalMs?: number | null; steps?: BashtStep[] };
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
  too_many_images: "يمكن إرسال 8 صور كحد أقصى في الرسالة.", image_too_large: "إحدى الصور كبيرة جدًا (الحد 10 ميجابايت).",
  images_too_large: "الصور كبيرة جدًا معًا؛ أرسل عددًا أقل.", unsupported_image: "نوع الصورة غير مدعوم.",
  too_large: "الملف أكبر من الحد المسموح.", unsupported: "نوع الملف غير مدعوم للعرض.",
  not_found: "المحادثة غير متاحة.", bad_request: "طلب غير صالح.", unavailable: "تعذّر الوصول إلى محرك باشت الآن.", network: "انقطع الاتصال بالخادم.",
};
export const bashtErrorText = (code: string) => BASHT_ERROR_TEXT[code] ?? BASHT_ERROR_TEXT.unavailable;
export class BashtError extends Error { constructor(public code: string) { super(bashtErrorText(code)); this.name = "BashtError"; } }

type Fetch = typeof fetch;
export function createBashtClient(fetchImpl: Fetch = (...a) => fetch(...a)) {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let res: Response;
    try { res = await fetchImpl(`/api/basht/${path}`, { credentials: "same-origin", cache: "no-store", ...init }); } catch { throw new BashtError("network"); }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new BashtError(typeof (body as { error?: unknown })?.error === "string" ? (body as { error: string }).error : "unavailable");
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
  };
}
export const bashtClient = createBashtClient();
/** Same-origin URL of one media item (served with the owner session, never cached by shared caches). */
export const bashtMediaUrl = (key: string, msg: string, ref: string) =>
  `/api/basht/media?key=${encodeURIComponent(key)}&msg=${encodeURIComponent(msg)}&ref=${encodeURIComponent(ref)}`;
