import test from "node:test";
import assert from "node:assert/strict";
import { BusyError, STEP_IDS, abortError, createJobManager } from "../jobs.mjs";

const URL1 = "https://example.com/";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const good = async (_url, { step }) => {
  for (const id of STEP_IDS) { step(id, "running"); await tick(1); step(id, "done"); }
  return { title: "T", url: URL1, excerpt: "E", screenshot: Buffer.from("jpeg") };
};

test("a successful job exposes steps and text, never the screenshot bytes or anything else", async () => {
  const m = createJobManager({ run: good });
  const job = m.create(URL1);
  await job.done;
  const v = m.view(job);
  assert.equal(v.status, "succeeded");
  assert.deepEqual(v.steps.map((s) => s.status), STEP_IDS.map(() => "done"));
  assert.deepEqual(v.result, { title: "T", url: URL1, excerpt: "E", hasScreenshot: true });
  assert.equal(JSON.stringify(v).includes("jpeg"), false);
  assert.deepEqual(Object.keys(v).sort(), ["createdAt", "finishedAt", "id", "result", "sessionReleased", "status", "steps", "url"]);
  assert.equal(m.screenshot(job.id).toString(), "jpeg");
});

test("only one job at a time; the slot is freed once the job ends", async () => {
  let release; const gate = new Promise((r) => (release = r));
  const m = createJobManager({ run: async () => { await gate; return { title: "", url: URL1, excerpt: "", screenshot: Buffer.alloc(1) }; } });
  const a = m.create(URL1);
  assert.throws(() => m.create(URL1), BusyError);
  assert.equal(m.isBusy(), true);
  release(); await a.done;
  assert.equal(m.isBusy(), false);
  await m.create(URL1).done;
});

test("failures map to fixed codes; raw error text never reaches the view", async () => {
  const m = createJobManager({ run: async () => { throw Object.assign(new Error("wss://connect.example/?signingKey=SECRET"), { code: "navigation_failed" }); } });
  const j = m.create(URL1); await j.done;
  assert.equal(m.view(j).status, "failed");
  assert.equal(m.view(j).error, "navigation_failed");
  assert.equal(JSON.stringify(m.view(j)).includes("SECRET"), false);
  const m2 = createJobManager({ run: async () => { throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" }); } });
  const j2 = m2.create(URL1); await j2.done;
  assert.equal(m2.view(j2).error, "browser_execution_failed"); // unknown codes are collapsed
  assert.equal(m2.isBusy(), false);
});

test("cancel really aborts: the run is told, cleans up, and only then does the job become cancelled and the slot free", async () => {
  let cleanedUp = false, sawAbort = false;
  const m = createJobManager({ run: async (_u, { signal, step }) => {
    step("navigate", "running");
    try { await new Promise((_, rej) => signal.addEventListener("abort", () => { sawAbort = true; rej(abortError()); })); }
    finally { await tick(30); cleanedUp = true; step("release", "done"); }
  } });
  const job = m.create(URL1);
  const v = m.view(m.cancel(job.id));
  assert.equal(v.status, "cancelling");        // honest intermediate state
  assert.equal(m.isBusy(), true);              // cloud session may still be open
  assert.throws(() => m.create(URL1), BusyError);
  await job.done;
  assert.equal(sawAbort, true); assert.equal(cleanedUp, true);
  assert.equal(m.view(job).status, "cancelled");
  assert.equal(m.view(job).steps.find((s) => s.id === "navigate").status, "skipped");
  assert.equal(m.view(job).steps.find((s) => s.id === "release").status, "done");
  assert.equal(m.isBusy(), false);
});

test("cancel is idempotent, harmless on finished jobs, and null for unknown ids", async () => {
  const m = createJobManager({ run: good });
  const j = m.create(URL1); await j.done;
  assert.equal(m.view(m.cancel(j.id)).status, "succeeded"); // cannot rewrite history
  assert.equal(m.cancel("00000000-0000-4000-8000-000000000000"), null);
});

test("a run that ignores the signal but returns after cancel is still reported as cancelled, not succeeded", async () => {
  const m = createJobManager({ run: async () => { await tick(20); return { title: "x", url: URL1, excerpt: "", screenshot: Buffer.alloc(1) }; } });
  const j = m.create(URL1); m.cancel(j.id); await j.done;
  assert.equal(m.view(j).status, "cancelled");
  assert.equal(m.view(j).result, undefined);
});

test("the deadline aborts a stuck job and reports timeout", async () => {
  const m = createJobManager({ deadlineMs: 30, run: (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(abortError()))) });
  const j = m.create(URL1); await j.done;
  assert.equal(m.view(j).status, "failed"); assert.equal(m.view(j).error, "timeout");
});

test("finished jobs expire after the TTL and the table is bounded", async () => {
  let t = 1_000;
  const m = createJobManager({ run: good, now: () => t, ttlMs: 100, maxJobs: 3 });
  const ids = [];
  for (let i = 0; i < 3; i++) { const j = m.create(URL1); await j.done; ids.push(j.id); t += 1; }
  const d = m.create(URL1); await d.done;        // at capacity: oldest finished job is evicted
  assert.equal(m.get(ids[0]), null); assert.ok(m.get(ids[2]));
  t += 10_000;
  const e = m.create(URL1); await e.done;        // everything older than the TTL is gone
  assert.equal(m.get(ids[2]), null); assert.equal(m.size(), 1);
});

test("shutdown cancels the active job and waits for its clean-up", async () => {
  let cleaned = false;
  const m = createJobManager({ run: async (_u, { signal }) => { try { await new Promise((_, rej) => signal.addEventListener("abort", () => rej(abortError()))); } finally { await tick(20); cleaned = true; } } });
  m.create(URL1);
  await m.shutdown();
  assert.equal(cleaned, true);
  await m.shutdown(); // nothing active: returns at once
});

test("expiry is enforced on reads and by the sweeper, with no new job needed (Codex P2)", async () => {
  let t = 1_000;
  const m = createJobManager({ run: good, now: () => t, ttlMs: 100, sweepMs: 0 });
  const j = m.create(URL1); await j.done;
  assert.ok(m.get(j.id)); assert.ok(m.screenshot(j.id));
  t += 50; assert.ok(m.get(j.id) && m.screenshot(j.id));            // still inside the TTL
  t += 100;                                                          // past it, nobody created anything
  assert.equal(m.screenshot(j.id), null); assert.equal(m.get(j.id), null); assert.equal(m.cancel(j.id), null);
  assert.equal(m.size(), 0);
  // the background sweep frees memory without any read
  const real = createJobManager({ run: good, ttlMs: 20, sweepMs: 15 });
  const r = real.create(URL1); await r.done;
  for (let i = 0; i < 40 && real.size() > 0; i++) await tick(20);
  assert.equal(real.size(), 0); real.stop();
});
