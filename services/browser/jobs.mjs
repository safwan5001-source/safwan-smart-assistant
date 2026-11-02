// In-memory job manager for the browser worker: ONE active job at a time, real cancellation, bounded retention.
//
// A job is the unit the chat shows. `run(url, { signal, step })` does the actual browsing and is responsible for ALL of its own cleanup
// (closing the browser, releasing the Browserbase session) before it settles; the manager only frees the single slot afterwards, so
// "busy" really means "a cloud session may still be open".
//
// Cancellation is not a flag the job politely checks: cancel() aborts the signal, run() tears the browser down immediately (which makes
// any in-flight navigation/read/screenshot reject), and the job ends as `cancelled` only after cleanup finished.
//
// CHAT-BROWSER-2: a job may be `interactive`. It is still the same single slot, the same deadline, the same cancellation and the same
// clean-up path; the only difference is that after opening the start page `run` keeps the session open and takes ONE action at a time
// from a mailbox (navigate / click / type / observe) until the user finishes, stops, goes idle or a limit is reached.
import { randomUUID } from "node:crypto";
import { ActionError, LIMITS, describe } from "./actions.mjs";

export const STEP_IDS = ["create_session", "connect", "navigate", "read", "screenshot", "release"];
export const INTERACTIVE_STEP_IDS = ["create_session", "connect", "navigate", "interact", "release"];
export const ERROR_CODES = new Set(["timeout", "navigation_failed", "disallowed_final_url", "screenshot_too_large", "browser_execution_failed"]);
export const END_REASONS = new Set(["finished", "idle", "limit"]);
const ACTIVE = new Set(["running", "cancelling"]);
const ACTION_FINAL = new Set(["done", "failed", "rejected", "denied", "cancelled"]);

export class BusyError extends Error {
  constructor() { super("busy"); this.name = "BusyError"; }
}
export const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted" });

/** One-consumer mailbox. next() settles on a message, on close, on idle timeout, or rejects when the job is aborted; a lost race never swallows a later push. */
function createMailbox() {
  const queue = []; let waiter = null; let closed = null;
  return {
    push(item) { if (waiter) waiter(item); else queue.push(item); },
    close(reason) { closed ??= reason; if (waiter) waiter({ type: "close", reason }); },
    next({ timeoutMs, signal }) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve({ type: "close", reason: closed });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => settle({ type: "idle" }), timeoutMs);
        const onAbort = () => { clearTimeout(t); waiter = null; reject(abortError()); };
        const settle = (v) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); waiter = null; resolve(v); };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiter = settle;
      });
    },
  };
}

export function createJobManager({ run, now = Date.now, ttlMs = 10 * 60_000, maxJobs = 20, deadlineMs = 90_000, sweepMs = 30_000, limits = LIMITS }) {
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

  const expired = (j) => !ACTIVE.has(j.status) && now() - j.finishedAt > ttlMs;
  /** Reads enforce the TTL themselves (a finished job and its screenshot are gone after ttlMs even if nobody creates another job). */
  const live = (id) => { const j = jobs.get(id); if (!j) return null; if (expired(j)) { jobs.delete(id); return null; } return j; };
  // ...and a background sweep frees the memory too. unref(): never keeps the process (or a test run) alive.
  const sweeper = sweepMs > 0 ? setInterval(() => { for (const [id, j] of jobs) if (expired(j)) jobs.delete(id); }, sweepMs) : null;
  sweeper?.unref?.();

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
    if (job.mode === "interactive") {
      v.mode = "interactive";
      v.ready = job.ready;
      v.limits = { maxActions: limits.maxActions, deadlineMs: limits.deadlineMs, idleMs: limits.idleMs, approvalMs: limits.approvalMs };
      v.deadlineAt = job.createdAt + limits.deadlineMs;
      v.blockedRequests = job.blocked;
      v.actions = job.actions.map(({ seq, tool, status, summary, error }) => (error ? { seq, tool, status, summary, error } : { seq, tool, status, summary }));
      if (job.endReason) v.endReason = job.endReason;
      if (job.result) v.result.version = job.shotVersion;
      if (job.pending) v.pending = { seq: job.pending.seq, kind: job.pending.kind, summary: job.pending.summary, expiresAt: job.pending.expiresAt, ...(job.pending.submitsTo ? { submitsTo: job.pending.submitsTo } : {}), ...(job.pending.element ? { element: job.pending.element } : {}) };
    }
    return v;
  }

  async function execute(job) {
    const interactive = job.mode === "interactive";
    const timer = setTimeout(() => { job.abortReason ??= "timeout"; job.ctl.abort(); }, interactive ? limits.deadlineMs : deadlineMs);
    const api = {
      signal: job.ctl.signal,
      step: (id, status) => setStep(job, id, status),
      sessionReleased: (ok) => { job.sessionReleased = ok; },
    };
    if (interactive) {
      api.interactive = {
        job, limits, mailbox: job.mailbox,
        ready: () => { job.ready = true; },
        observation: (obs) => { job.result = obs; job.shotVersion += 1; },
        blocked: () => { job.blocked += 1; },
        setPending: (p) => { job.pending = p; },
        update: (seq, patch) => { const a = job.actions.find((x) => x.seq === seq); if (a) Object.assign(a, patch); },
      };
      api.sessionSeconds = Math.ceil(limits.deadlineMs / 1000) + 60; // the provider's own timeout is a backstop AFTER ours
    }
    try {
      const result = await run(job.url, api);
      if (job.ctl.signal.aborted) throw abortError();
      if (interactive) { if (END_REASONS.has(result?.endReason)) job.endReason = result.endReason; }
      else job.result = result;
      job.status = "succeeded";
    } catch (e) {
      if (job.abortReason === "cancel") job.status = "cancelled";
      else if (job.abortReason === "timeout") { job.status = "failed"; job.error = "timeout"; }
      else { job.status = "failed"; job.error = ERROR_CODES.has(e?.code) ? e.code : "browser_execution_failed"; }
    } finally {
      clearTimeout(timer);
      job.ready = false;
      if (job.pending) { job.pending.resolve?.(false); job.pending = null; }
      if (job.error === "disallowed_final_url") job.result = null; // never keep a picture of a page that was out of bounds
      for (const a of job.actions) if (!ACTION_FINAL.has(a.status)) a.status = job.status === "cancelled" ? "cancelled" : "failed";
      for (const s of job.steps) {
        if (s.status === "pending") s.status = "skipped";
        else if (s.status === "running") s.status = job.status === "cancelled" ? "skipped" : "failed";
      }
      job.finishedAt = now();
      active = null;
    }
  }

  function create(url, { mode = "read" } = {}) {
    if (active) throw new BusyError();
    prune();
    const interactive = mode === "interactive";
    const job = {
      id: randomUUID(), url, status: "running", createdAt: now(), ctl: new AbortController(), abortReason: null, mode,
      steps: (interactive ? INTERACTIVE_STEP_IDS : STEP_IDS).map((id) => ({ id, status: "pending" })), sessionReleased: false,
      ...(interactive ? { actions: [], pending: null, ready: false, blocked: 0, shotVersion: 0, endReason: null, mailbox: createMailbox() } : { actions: [] }),
    };
    jobs.set(job.id, job);
    active = job;
    job.done = execute(job);
    return job;
  }

  /** Interactive jobs only. Queues ONE action; the caller learns its outcome by polling the job view. */
  function submitAction(id, action) {
    const job = live(id);
    if (!job) throw new ActionError("not_found", 404);
    if (job.mode !== "interactive") throw new ActionError("not_interactive", 409);
    if (job.status !== "running") throw new ActionError("session_ended", 409);
    if (!job.ready) throw new ActionError("not_ready", 409);
    if (job.actions.length >= limits.maxActions) throw new ActionError("limit_reached", 409);
    if (job.actions.some((a) => !ACTION_FINAL.has(a.status))) throw new ActionError("action_in_progress", 409);
    const rec = { seq: job.actions.length + 1, tool: action.tool, status: "queued", summary: describe(action) };
    job.actions.push(rec);
    job.mailbox.push({ type: "action", seq: rec.seq, action });
    return job;
  }
  /** Approve or reject the step that is waiting for the user. Only the currently pending seq can be decided, once. */
  function decide(id, seq, approve) {
    const job = live(id);
    if (!job) throw new ActionError("not_found", 404);
    if (job.mode !== "interactive" || job.status !== "running") throw new ActionError("session_ended", 409);
    if (!job.pending || job.pending.seq !== seq) throw new ActionError("no_pending_approval", 409);
    const resolve = job.pending.resolve;
    job.pending.resolve = null;
    if (!resolve) throw new ActionError("no_pending_approval", 409);
    resolve(approve === true);
    return job;
  }
  /** Graceful end: the session is released and the job succeeds. (cancel() is the hard stop.) */
  function finish(id) {
    const job = live(id);
    if (!job) return null;
    if (job.mode === "interactive" && job.status === "running") { job.mailbox.close("finished"); job.pending?.resolve?.(false); }
    return job;
  }

  return {
    create,
    submitAction,
    decide,
    finish,
    view,
    get: (id) => live(id),
    screenshot: (id) => live(id)?.result?.screenshot ?? null,
    cancel(id) {
      const job = live(id);
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
    stop: () => { if (sweeper) clearInterval(sweeper); },
    size: () => jobs.size,
  };
}
