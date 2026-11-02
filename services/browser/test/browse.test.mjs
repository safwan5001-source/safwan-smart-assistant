import test from "node:test";
import assert from "node:assert/strict";
import { createBrowse } from "../browse.mjs";
import { createJobManager } from "../jobs.mjs";
import { createPolicy } from "../policy.mjs";

const policy = createPolicy(["example.com"]);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const URL1 = "https://example.com/";

function fakes({ guardFails = false, createDelay = 0, createFails = false, connectFails = false, gotoHang = false, releaseFails = false, shot = Buffer.alloc(2000) } = {}) {
  const calls = { release: [], closed: 0, created: 0 };
  const page = {
    goto: () => (gotoHang ? new Promise(() => {}) : Promise.resolve()),
    url: () => URL1, title: async () => "Example Domain",
    locator: () => ({ innerText: async () => "Example Domain  text" }),
    screenshot: async () => shot,
  };
  const context = { pages: () => [page], newPage: async () => page, route: async () => {}, newCDPSession: async () => { if (guardFails) throw new Error("cdp unavailable"); return { on() {}, send: async () => ({}) }; } };
  const browser = { contexts: () => [context], newContext: async () => context, close: async () => { calls.closed++; } };
  const client = {
    createSession: async () => { calls.created++; await tick(createDelay); if (createFails) throw new Error("create failed https://secret"); return { id: "sess-1", connectUrl: "wss://x/?signingKey=S" }; },
    release: async (id) => { calls.release.push(id); if (releaseFails) throw new Error("nope"); },
  };
  return { calls, client, connect: async () => { if (connectFails) throw new Error("wss://x/?signingKey=S"); return browser; } };
}
const mk = (f, opts = {}) => createJobManager({ run: createBrowse({ client: f.client, projectId: "p", policy, connect: f.connect, log: () => {} }), ...opts });

test("happy path releases the session and reports every step", async () => {
  const f = fakes(); const m = mk(f); const j = m.create(URL1); await j.done;
  const v = m.view(j);
  assert.equal(v.status, "succeeded"); assert.equal(v.sessionReleased, true);
  assert.deepEqual(f.calls.release, ["sess-1"]); assert.equal(f.calls.closed >= 1, true);
  assert.deepEqual(v.steps.map((s) => s.status), ["done", "done", "done", "done", "done", "done"]);
  assert.equal(v.result.excerpt, "Example Domain text");
});

test("failure at connect still releases the session and hides the secret-bearing message", async () => {
  const f = fakes({ connectFails: true }); const m = mk(f); const j = m.create(URL1); await j.done;
  const v = m.view(j);
  assert.equal(v.status, "failed"); assert.equal(v.error, "browser_execution_failed");
  assert.deepEqual(f.calls.release, ["sess-1"]);
  assert.equal(JSON.stringify(v).includes("signingKey"), false);
  assert.deepEqual(v.steps.map((s) => s.status), ["done", "failed", "skipped", "skipped", "skipped", "done"]);
});

test("an oversized screenshot fails the job with its own code", async () => {
  const f = fakes({ shot: Buffer.alloc(300_000) }); const m = mk(f); const j = m.create(URL1); await j.done;
  assert.equal(m.view(j).error, "screenshot_too_large"); assert.deepEqual(f.calls.release, ["sess-1"]);
});

test("a failed release is reported honestly (sessionReleased=false, release step failed)", async () => {
  const f = fakes({ releaseFails: true }); const m = mk(f); const j = m.create(URL1); await j.done;
  const v = m.view(j);
  assert.equal(v.sessionReleased, false); assert.equal(v.steps.at(-1).status, "failed");
});

test("cancel while navigating closes the browser and releases the session", async () => {
  const f = fakes({ gotoHang: true }); const m = mk(f); const j = m.create(URL1);
  await tick(30); assert.equal(m.view(j).steps.find((s) => s.id === "navigate").status, "running");
  m.cancel(j.id); await j.done;
  assert.equal(m.view(j).status, "cancelled"); assert.deepEqual(f.calls.release, ["sess-1"]);
  assert.equal(f.calls.closed >= 1, true); assert.equal(m.view(j).sessionReleased, true);
});

test("cancel while the session is still being created releases it as soon as it exists (no orphan)", async () => {
  const f = fakes({ createDelay: 60 }); const m = mk(f); const j = m.create(URL1);
  await tick(10); m.cancel(j.id); await j.done;
  assert.equal(m.view(j).status, "cancelled");
  assert.deepEqual(f.calls.release, ["sess-1"]); // the late session was found and released
  assert.equal(m.isBusy(), false);
});

test("a failed createSession has nothing to release and is not reported as an unreleased session", async () => {
  const f = fakes({ createFails: true }); const m = mk(f); const j = m.create(URL1); await j.done;
  assert.equal(m.view(j).status, "failed"); assert.deepEqual(f.calls.release, []); assert.equal(m.view(j).sessionReleased, true);
});

test("if the redirect guard cannot be installed the job FAILS (no unguarded browsing) and still releases the session", async () => {
  const f = fakes({ guardFails: true }); let navigated = false;
  const m = mk(f); const j = m.create(URL1); await j.done;
  const v = m.view(j);
  assert.equal(v.status, "failed"); assert.equal(v.error, "browser_execution_failed");
  assert.equal(v.steps.find((s) => s.id === "navigate").status, "skipped"); assert.equal(navigated, false);
  assert.deepEqual(f.calls.release, ["sess-1"]);
});
