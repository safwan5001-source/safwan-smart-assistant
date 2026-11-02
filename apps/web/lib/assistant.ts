/**
 * Assistant service boundary. The UI talks to this, never to a provider.
 * Nothing here claims AI is available: `status()` reports only what the BFF's public
 * /api/health says (web tier + signed backend hop), and `respond()` refuses unless that report says the assistant is configured.
 * API keys live on the server; there is no key (and must never be one) in this bundle.
 */
export type AssistantStatus =
  | { server: "checking" }
  | { server: "offline" }
  | { server: "online"; assistant: boolean; version: string };

export class AssistantUnavailableError extends Error {
  constructor(message = "المساعد الذكي غير مفعّل.") { super(message); this.name = "AssistantUnavailableError"; }
}

export type ChatTurn = { role: "user" | "assistant" | "system"; content: string };
type Fetch = typeof fetch;

/** User-facing Arabic text for every failure code the BFF/API can produce. Unknown codes fall back to a generic message (never upstream text). */
export const AI_ERROR_TEXT: Record<string, string> = {
  unauthorized: "يلزم فتح جلسة Claude من جديد.", disabled: "Claude غير مفعّل على الخادم.", forbidden: "غير مصرّح بهذا الطلب.",
  rate_limited: "عدد الطلبات كبير؛ انتظر قليلاً ثم أعد المحاولة.",
  budget_daily: "بلغت حد التكلفة اليومي لـClaude. سيتجدد غدًا أو يمكن رفع الحد من إعدادات الخادم.",
  budget_monthly: "بلغت حد التكلفة الشهري لـClaude. يمكن رفع الحد من إعدادات الخادم.",
  conversation_full: "هذه المحادثة وصلت حدّها الأقصى. ابدأ محادثة جديدة.", not_found: "المحادثة غير موجودة.", bad_request: "طلب غير صالح.",
  provider_auth: "تعذّر قبول مفتاح Anthropic على الخادم. راجع إعداد المفتاح.", model_unavailable: "النموذج المختار غير متاح لدى Anthropic.",
  provider_busy: "Claude مشغول حاليًا؛ أعد المحاولة بعد لحظات.", provider_timeout: "انتهت مهلة الاستجابة من Claude.",
  provider_request_failed: "تعذر الاتصال بـClaude.", response_too_large: "الرد أطول من الحد المسموح.", assistant_unavailable: "Claude غير متاح حاليًا على الخادم.",
  unavailable: "Claude غير متاح حاليًا على الخادم.", network: "انقطع الاتصال بالخادم.",
};
export const aiErrorText = (code: string) => AI_ERROR_TEXT[code] ?? "تعذر الحصول على رد من المساعد.";

export class AssistantRequestError extends Error {
  constructor(public code: string, public status = 0) { super(aiErrorText(code)); this.name = "AssistantRequestError"; }
}

export type ClaudeState = {
  provider: "anthropic"; models: { id: string; label: string }[]; default_model: string | null;
  limits: { daily_usd: number; monthly_usd: number; per_minute: number };
  usage: { day: { spent_usd: number; requests: number }; month: { spent_usd: number; requests: number } };
};
export type StoredMessage = { id: string; role: "user" | "assistant"; content: string; partial: boolean; created: string };
export type StoredConversation = { id: string; title: string; model: string; updated: string; messages: StoredMessage[] };
export type ConversationSummary = { id: string; title: string; count: number; model: string; updated: string };
export type StreamDone = { text: string; stopped: boolean; usage?: { input_tokens: number; output_tokens: number; cost_usd: number } };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function createAssistantService(fetchImpl: Fetch = (...a) => fetch(...a), base = "/api", timeoutMs = 20000) {
  const call = async (path: string, init?: RequestInit, ms = timeoutMs) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try { return await fetchImpl(base + path, { ...init, signal: init?.signal ?? ctl.signal, cache: "no-store" }); }
    finally { clearTimeout(timer); }
  };
  const failure = async (res: Response) => { let code = "unavailable"; try { const b: unknown = await res.json(); if (isObj(b) && typeof b.error === "string") code = b.error; } catch { /* generic */ } return new AssistantRequestError(code, res.status); };
  const jsonCall = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let res: Response;
    try { res = await call(path, init); } catch { throw new AssistantRequestError("network"); }
    if (!res.ok) throw await failure(res);
    return (await res.json()) as T;
  };
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    async status(): Promise<AssistantStatus> {
      try {
        const res = await call("/health");
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return { server: "offline" };
        const body: unknown = await res.json();
        const b = body as { status?: unknown; version?: unknown; features?: { assistant?: unknown } };
        if (b?.status !== "ok") return { server: "offline" };
        return { server: "online", assistant: b.features?.assistant === true, version: typeof b.version === "string" ? b.version : "?" };
      } catch { return { server: "offline" }; }
    },
    async sessionStatus(): Promise<{ enabled: boolean; authenticated: boolean }> {
      try {
        const res = await call("/assistant/status");
        if (!res.ok) return { enabled: false, authenticated: false };
        const data = await res.json() as { enabled?: unknown; authenticated?: unknown };
        return { enabled: data.enabled === true, authenticated: data.authenticated === true };
      } catch { return { enabled: false, authenticated: false }; }
    },
    async unlock(code: string): Promise<boolean> {
      try { return (await call("/assistant/session", post({ code }))).ok; } catch { return false; }
    },
    async lock(): Promise<void> { try { await call("/assistant/session", { method: "DELETE" }); } catch { /* cookie expires by itself */ } },
    state: () => jsonCall<ClaudeState>("/assistant/state"),
    probe: () => jsonCall<{ model: string; reachable: boolean; cached: boolean }>("/assistant/probe", post({})),
    setDefaultModel: (model: string) => jsonCall<{ default_model: string }>("/assistant/settings", post({ model })),
    async conversations(): Promise<ConversationSummary[]> { return (await jsonCall<{ conversations: ConversationSummary[] }>("/assistant/conversations")).conversations; },
    conversation: (id: string) => jsonCall<StoredConversation>(`/assistant/conversations/${encodeURIComponent(id)}`),
    removeConversation: (id: string) => jsonCall<{ deleted: boolean }>(`/assistant/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),

    /**
     * Streams one answer. `onDelta` fires for every chunk as it arrives. Aborting `signal` (the Stop button) cancels the request on
     * the server too; the partial text received so far is returned with `stopped: true`. Server-side failures throw AssistantRequestError
     * carrying the text received so far in `.partial`.
     */
    async chat(conversationId: string, message: string, opts: { signal?: AbortSignal; onDelta?: (text: string, all: string) => void } = {}): Promise<StreamDone> {
      let res: Response;
      try { res = await call("/assistant/chat", { ...post({ conversationId, message }), signal: opts.signal }, 140000); }
      catch { if (opts.signal?.aborted) return { text: "", stopped: true }; throw new AssistantRequestError("network"); }
      if (!res.ok || !res.body) throw await failure(res);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "", all = "";
      const fail = (code: string): never => { const e = new AssistantRequestError(code) as AssistantRequestError & { partial: string }; e.partial = all; throw e; };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: unknown;
            try { ev = JSON.parse(line); } catch { continue; }
            if (!isObj(ev)) continue;
            if (ev.type === "delta" && typeof ev.text === "string") { all += ev.text; opts.onDelta?.(ev.text, all); }
            else if (ev.type === "error") fail(typeof ev.code === "string" ? ev.code : "unavailable");
            else if (ev.type === "done") {
              const u = isObj(ev.usage) ? ev.usage : undefined;
              return { text: all, stopped: false, usage: u ? { input_tokens: Number(u.input_tokens) || 0, output_tokens: Number(u.output_tokens) || 0, cost_usd: Number(u.cost_usd) || 0 } : undefined };
            }
          }
        }
      } catch (e) {
        if (e instanceof AssistantRequestError) throw e;
        if (opts.signal?.aborted) return { text: all, stopped: true };
        fail("network");
      }
      if (opts.signal?.aborted) return { text: all, stopped: true };
      return fail("network"); // the stream ended without a "done" event: never present it as a complete answer
    },
  };
}
export const assistantService = createAssistantService();
