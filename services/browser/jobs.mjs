// In-memory job manager for the browser worker: ONE active job at a time, real cancellation, bounded retention.
//
// A job is the unit the chat shows. `run(url, { signal, step })` does the actual browsing and is responsible for ALL of its own cleanup
// (closing the browser, releasing the Browserbase session) before it settles; the manager only frees the single slot afterwards, so
// "busy" really means "a cloud session may still be open".
//
// Cancellation is not a flag the job politely checks: cancel() aborts the signal, run() tears the browser down immediately (which makes
// any in-flight navigation/read/screenshot reject), and the job ends as `cancelled` only after cleanup finished.
import { randomUUID } from "node:crypto";

export const STEP_IDS = ["create_session", "connect", "navigate", "read", "screenshot", "release"];
export const ERROR_CODES = new Set(["timeout", "navigation_failed", "disallowed_final_url", "screenshot_too_large", "browser_execution_failed"]);
const ACTIVE = new Set(["running", "cancelling"]);

export class BusyError extends Error {
  constructor() { super("busy"); this.name = "BusyError"; }
}
export const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted" });

export function createJobManager({ run, now = Date.now, ttlMs = 10 * 60_000, maxJobs = 20, deadlineMs = 90_000 }) {
  const jobs = new Map();
  let active = null;

  const setStep = (job, id, status) => {
    const s = job.steps.find((x) => x.id === id);
    if (s && !(s.status === "done" || s.status === "failed" || s.status === "skipped")) s.status = status;
  };

  function prune() {
    const t = now();
    for (const [id, j] of jobs) if (!ACTIVE.has(j.status) && t - j.finishedAt > ttlMs) jobs.delete(id);
    while (jobs.size >= maxJobs) {
      const oldest = [...jobs.values()].filter((j) => !ACTIVE.has(j.status)).sort((a, b) => a.finishedAt - b.finishedAt)[0];
      if (!oldest) break;
      jobs.delete(oldest.id);
    }
  }

  /** Public, whitelisted shape. Never contains the screenshot bytes, session identifiers or connection URLs. */
  function view(job) {
    const v = {
      id: job.id, status: job.status, url: job.url, createdAt: job.createdAt,
      steps: job.steps.map(({ id, status }) => ({ id, status })),
      sessionReleased: job.sessionReleased,
    };
    if (job.finishedAt) v.finishedAt = job.finishedAt;
    if (job.error) v.error = job.error;
    if (job.result) v.result = { title: job.result.title, url: job.result.url, excerpt: job.result.excerpt, hasScreenshot: !!job.result.screenshot };
    return v;
  }

  async function execute(job) {
    const timer = setTimeout(() => { job.abortReason ??= "timeout"; job.ctl.abort(); }, deadlineMs);
    const api = {
      signal: job.ctl.signal,
      step: (id, status) => setStep(job, id, status),
      sessionReleased: (ok) => { job.sessionReleased = ok; },
    };
    try {
      const result = await run(job.url, api);
      if (job.ctl.signal.aborted) throw abortError();
      job.result = result;
      job.status = "succeeded";
    } catch (e) {
      if (job.abortReason === "cancel") job.status = "cancelled";
      else if (job.abortReason === "timeout") { job.status = "failed"; job.error = "timeout"; }
      else { job.status = "failed"; job.error = ERROR_CODES.has(e?.code) ? e.code : "browser_execution_failed"; }
    } finally {
      clearTimeout(timer);
      for (const s of job.steps) {
        if (s.status === "pending") s.status = "skipped";
        else if (s.status === "running") s.status = job.status === "cancelled" ? "skipped" : "failed";
      }
      job.finishedAt = now();
      active = null;
    }
  }

  function create(url) {
    if (active) throw new BusyError();
    prune();
    const job = {
      id: randomUUID(), url, status: "running", createdAt: now(), ctl: new AbortController(), abortReason: null,
      steps: STEP_IDS.map((id) => ({ id, status: "pending" })), sessionReleased: false,
    };
    jobs.set(job.id, job);
    active = job;
    job.done = execute(job);
    return job;
  }

  return {
    create,
    view,
    get: (id) => jobs.get(id) ?? null,
    screenshot: (id) => jobs.get(id)?.result?.screenshot ?? null,
    cancel(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (job.status === "running") {
        job.abortReason = "cancel";
        job.status = "cancelling";
        job.ctl.abort();
      }
      return job; // terminal or already cancelling: idempotent
    },
    /** Called on SIGTERM so a redeploy never leaves a paid cloud browser running. */
    async shutdown(maxWaitMs = 15_000) {
      if (!active) return;
      const job = active;
      this.cancel(job.id);
      await Promise.race([job.done, new Promise((r) => setTimeout(r, maxWaitMs))]);
    },
    isBusy: () => active !== null,
    size: () => jobs.size,
  };
}
