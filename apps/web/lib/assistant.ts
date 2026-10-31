/**
 * Assistant service boundary. The UI talks to this, never to a provider.
 * Nothing here claims AI is available: `status()` reports only what the server's public
 * /health says, and `respond()` refuses unless that report says the assistant is configured.
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

export function createAssistantService(fetchImpl: Fetch = (...a) => fetch(...a), base = "/backend", timeoutMs = 4000) {
  const call = async (path: string, init?: RequestInit) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetchImpl(base + path, { ...init, signal: ctl.signal, cache: "no-store" }); }
    finally { clearTimeout(timer); }
  };
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
    async respond(turns: ChatTurn[], status: AssistantStatus): Promise<string> {
      if (status.server !== "online" || !status.assistant) throw new AssistantUnavailableError();
      const res = await call("/assistant/respond", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: turns.slice(-50) }),
      });
      if (!res.ok) throw new AssistantUnavailableError(res.status === 503 ? "المساعد الذكي غير مفعّل على الخادم." : "تعذر الحصول على رد من المساعد.");
      const data = (await res.json()) as { content?: unknown };
      if (typeof data.content !== "string" || !data.content) throw new AssistantUnavailableError("رد غير صالح من الخادم.");
      return data.content;
    },
  };
}
export const assistantService = createAssistantService();
