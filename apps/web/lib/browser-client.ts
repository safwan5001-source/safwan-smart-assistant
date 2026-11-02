/**
 * Browser-side client for /api/browser/*. Same-origin, cookie-authenticated (HttpOnly: this code never sees the credential),
 * fixed paths only, every reply re-validated. Holds no secret and sends no token.
 */
import { isTaskId, parseTaskView, type TaskView } from "./browser-task";

export type GateStatus = { enabled: boolean; authenticated: boolean };
export type Fail = "disabled" | "unauthorized" | "rate_limited" | "busy" | "not_found" | "url_not_allowed" | "unavailable" | "network";
export type Result<T> = { ok: true; value: T } | { ok: false; error: Fail };

type Fetch = typeof fetch;
const KNOWN: Fail[] = ["disabled", "unauthorized", "rate_limited", "busy", "not_found", "url_not_allowed", "unavailable"];

export function createBrowserClient(fetchImpl: Fetch = (...a) => fetch(...a), base = "/api/browser", timeoutMs = 15_000) {
  async function request(method: string, path: string, body?: unknown): Promise<Response | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetchImpl(base + path, {
        method, cache: "no-store", credentials: "same-origin", redirect: "error", signal: ctl.signal,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch { return null; } finally { clearTimeout(timer); }
  }
  async function failure(res: Response | null): Promise<{ ok: false; error: Fail }> {
    if (!res) return { ok: false, error: "network" };
    let code: unknown;
    try { code = ((await res.json()) as { error?: unknown }).error; } catch { /* non-JSON error */ }
    const error = KNOWN.find((k) => k === code) ?? (res.status === 401 ? "unauthorized" : "unavailable");
    return { ok: false, error };
  }
  async function task(res: Response | null): Promise<Result<TaskView>> {
    if (!res || !res.ok) return failure(res);
    try {
      const view = parseTaskView(((await res.json()) as { task?: unknown }).task);
      return view ? { ok: true, value: view } : { ok: false, error: "unavailable" };
    } catch { return { ok: false, error: "unavailable" }; }
  }
  const id = (v: string) => { if (!isTaskId(v)) throw new Error("invalid task id"); return v; };
  return {
    async status(): Promise<Result<GateStatus>> {
      const res = await request("GET", "/status");
      if (!res || !res.ok) return failure(res);
      try { const j = (await res.json()) as Partial<GateStatus>; return { ok: true, value: { enabled: j.enabled === true, authenticated: j.authenticated === true } }; }
      catch { return { ok: false, error: "unavailable" }; }
    },
    async unlock(code: string): Promise<Result<true>> {
      const res = await request("POST", "/session", { code });
      return res?.ok ? { ok: true, value: true } : failure(res);
    },
    async lock(): Promise<void> { await request("DELETE", "/session"); },
    /** `approved: true` is sent ONLY from the click handler of the card's «تشغيل» button. */
    create: async (url: string): Promise<Result<TaskView>> => task(await request("POST", "/tasks", { url, approved: true })),
    get: async (taskId: string): Promise<Result<TaskView>> => task(await request("GET", `/tasks/${id(taskId)}`)),
    cancel: async (taskId: string): Promise<Result<TaskView>> => task(await request("POST", `/tasks/${id(taskId)}/cancel`)),
    screenshotUrl: (taskId: string) => `${base}/tasks/${id(taskId)}/screenshot`,
  };
}
export const browserClient = createBrowserClient();
