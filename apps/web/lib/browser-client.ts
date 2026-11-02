/**
 * Browser-side client for /api/browser/*. Same-origin, cookie-authenticated (HttpOnly: this code never sees the credential),
 * fixed paths only, every reply re-validated. Holds no secret and sends no token.
 */
import { isTaskId, parseActionRequest, parseTaskView, type ActionRequest, type TaskView } from "./browser-task";

export type GateStatus = { enabled: boolean; authenticated: boolean; interactive: { enabled: boolean; startUrl?: string } };
export type Fail =
  | "disabled" | "unauthorized" | "rate_limited" | "busy" | "not_found" | "url_not_allowed" | "unavailable" | "network" | "interactive_disabled" | "bad_request"
  | "action_in_progress" | "limit_reached" | "not_ready" | "session_ended" | "not_interactive" | "no_pending_approval" | "conflict";
export type Result<T> = { ok: true; value: T } | { ok: false; error: Fail };

type Fetch = typeof fetch;
const KNOWN: Fail[] = ["disabled", "unauthorized", "rate_limited", "busy", "not_found", "url_not_allowed", "unavailable", "interactive_disabled", "bad_request",
  "action_in_progress", "limit_reached", "not_ready", "session_ended", "not_interactive", "no_pending_approval", "conflict"];

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
      try {
        const j = (await res.json()) as Partial<GateStatus>;
        const i = (j.interactive ?? {}) as Partial<GateStatus["interactive"]>;
        const startUrl = typeof i.startUrl === "string" && /^https:\/\/[a-z0-9.-]{3,100}\/[\x21-\x7e]{0,300}$/.test(i.startUrl) ? i.startUrl : undefined;
        return { ok: true, value: { enabled: j.enabled === true, authenticated: j.authenticated === true, interactive: { enabled: i.enabled === true, ...(startUrl ? { startUrl } : {}) } } };
      }
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
    /** `version` only defeats the HTTP cache between two observations of the same session; it carries no information. */
    screenshotUrl: (taskId: string, version?: number) => `${base}/tasks/${id(taskId)}/screenshot${typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? `?v=${version}` : ""}`,
    // ── interactive session ──
    /** `approved: true` is sent ONLY from the click handler of the card's «السماح وبدء الجلسة» button. */
    createSession: async (): Promise<Result<TaskView>> => task(await request("POST", "/tasks", { mode: "interactive", approved: true })),
    /** One structured action. Validated again here so a bug in the UI can never send a free-form string. */
    act: async (taskId: string, action: ActionRequest): Promise<Result<TaskView>> => {
      const valid = parseActionRequest(action, (u) => /^https:\/\//.test(u));
      return valid ? task(await request("POST", `/tasks/${id(taskId)}/actions`, valid)) : { ok: false, error: "bad_request" };
    },
    /** The ONLY way a step that changes data runs: the user's own click on «موافقة» for that step number. */
    decide: async (taskId: string, seq: number, approve: boolean): Promise<Result<TaskView>> =>
      Number.isInteger(seq) && seq >= 1 && seq <= 20 ? task(await request("POST", `/tasks/${id(taskId)}/actions/${seq}/${approve ? "approve" : "reject"}`, {})) : { ok: false, error: "bad_request" },
    finish: async (taskId: string): Promise<Result<TaskView>> => task(await request("POST", `/tasks/${id(taskId)}/finish`, {})),
  };
}
export const browserClient = createBrowserClient();
