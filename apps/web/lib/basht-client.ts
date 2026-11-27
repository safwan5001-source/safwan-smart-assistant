/**
 * Browser-side client for /api/basht/* (the real BASHT engine). Same-origin, cookie-authenticated (HttpOnly: this code never sees
 * the credential). Every failure becomes an Arabic message; upstream text never reaches the UI.
 */
export type BashtSession = { key: string; label: string; channel: string; updated_at: number; writable: boolean };
export type BashtMessage = { role: "user" | "assistant"; text: string; at: number };
export type BashtRun = { status: "running" | "done" | "error" | "stopped"; text: string; failed: boolean };

export const BASHT_ERROR_TEXT: Record<string, string> = {
  unauthorized: "يلزم فتح جلسة باشت برمز وصول المالك.", disabled: "محادثة باشت غير مفعّلة على الخادم.", forbidden: "غير مصرّح بهذا الطلب.",
  rate_limited: "طلبات كثيرة؛ انتظر قليلًا ثم أعد المحاولة.", busy: "باشت ينفّذ طلبًا سابقًا الآن؛ انتظر حتى يكتمل.",
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
    send: async (message: string) => (await call<{ runId: string }>("send", post({ message }))).runId,
    run: (id: string) => call<BashtRun>(`runs/${id}`),
    stop: async (id: string) => { await call(`runs/${id}/stop`, post({})); },
  };
}
export const bashtClient = createBashtClient();
