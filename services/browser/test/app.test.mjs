// HTTP contract of the worker with a fake Browserbase client: authentication, validation, job lifecycle, cancel, single slot.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.mjs";
import { createPolicy } from "../policy.mjs";

const TOKEN = "k".repeat(40);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 1)]);

async function boot({ hang = false } = {}) {
  const released = [];
  const page = { on() {}, goto: () => (hang ? new Promise(() => {}) : Promise.resolve()), url: () => "https://example.com/", title: async () => "Example Domain",
    evaluate: async () => "Hello", screenshot: async () => JPEG };
  const context = { pages: () => [page], route: async () => {}, addInitScript: async () => {}, routeWebSocket: async () => {}, on() {}, newCDPSession: async () => ({ on() {}, send: async () => ({}) }) };
  const browser = { contexts: () => [context], close: async () => {} };
  const { server, manager } = createApp({
    token: TOKEN, policy: createPolicy(["example.com"]), projectId: "p", log: () => {},
    client: { createSession: async () => ({ id: "s1", connectUrl: "wss://x" }), release: async (id) => { released.push(id); } },
    connect: async () => browser,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { auth = "Bearer " + TOKEN, body, type = "application/json" } = {}) => fetch(base + path, {
    method, headers: { ...(auth ? { authorization: auth } : {}), ...(body !== undefined ? { "content-type": type } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { call, released, manager, close: async () => { await manager.shutdown(); server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}
const waitFor = async (get, pred) => { for (let i = 0; i < 100; i++) { const v = await get(); if (pred(v)) return v; await tick(20); } throw new Error("timeout waiting"); };

test("createApp refuses a weak token", () => {
  assert.throws(() => createApp({ token: "short", policy: createPolicy(["example.com"]) }), /32/);
});

test("createApp refuses a token that cannot travel in an Authorization header (trailing newline, spaces, non-ASCII)", () => {
  for (const bad of ["a".repeat(40) + "\n", "a".repeat(40) + "\r\n", " " + "a".repeat(40), "a".repeat(20) + " " + "a".repeat(20), "a".repeat(40) + "é", "a".repeat(40) + "ل"]) {
    assert.throws(() => createApp({ token: bad, policy: createPolicy(["example.com"]) }), /visible ASCII/, JSON.stringify(bad.slice(38)));
  }
  assert.doesNotThrow(() => createApp({ token: "Ab3-_.~+/=".repeat(4), policy: createPolicy(["example.com"]), projectId: "p", log: () => {} }).manager.stop());
});

test("every job route needs the bearer token; unknown routes are 404 without revealing anything", async (t) => {
  const s = await boot(); t.after(s.close);
  const id = "11111111-1111-4111-8111-111111111111";
  for (const [m, p] of [["POST", "/v1/jobs"], ["GET", `/v1/jobs/${id}`], ["GET", `/v1/jobs/${id}/screenshot`], ["POST", `/v1/jobs/${id}/cancel`], ["POST", "/v1/navigate"]]) {
    for (const auth of [null, "Bearer wrong", "Bearer " + TOKEN + "x", "bearer " + TOKEN, TOKEN, "Basic " + TOKEN]) {
      const r = await s.call(m, p, { auth, body: m === "POST" ? { url: "https://example.com/" } : undefined });
      assert.equal(r.status, 401, `${m} ${p} ${auth}`);
    }
  }
  assert.equal((await s.call("GET", "/nope", { auth: null })).status, 404);
  assert.equal((await s.call("GET", "/health", { auth: null })).status, 200);
});

test("input validation: content type, size, JSON, URL policy", async (t) => {
  const s = await boot(); t.after(s.close);
  assert.equal((await s.call("POST", "/v1/jobs", { body: "{}", type: "text/plain" })).status, 415);
  assert.equal((await s.call("POST", "/v1/jobs", { body: "{not json" })).status, 400);
  assert.equal((await s.call("POST", "/v1/jobs", { body: { url: "x".repeat(5000) } })).status, 400);
  for (const url of ["http://example.com/", "https://127.0.0.1/", "https://example.com/?a=1", "https://169.254.169.254/", 5, null])
    assert.equal((await s.call("POST", "/v1/jobs", { body: { url } })).status, 400, String(url));
  assert.equal((await s.call("GET", "/v1/jobs/not-a-uuid")).status, 404);
  assert.equal((await s.call("GET", "/v1/jobs/11111111-1111-4111-8111-111111111111")).status, 404);
  assert.equal(s.manager.isBusy(), false); // nothing was started by any rejected request
});

test("full lifecycle: 202 -> succeeded -> text + JPEG, session released", async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await s.call("POST", "/v1/jobs", { body: { url: "https://example.com" } });
  assert.equal(r.status, 202);
  const { job } = await r.json();
  assert.match(job.id, /^[0-9a-f-]{36}$/);
  const done = await waitFor(async () => (await (await s.call("GET", `/v1/jobs/${job.id}`)).json()).job, (j) => j.status !== "running");
  assert.equal(done.status, "succeeded");
  assert.deepEqual(done.result, { title: "Example Domain", url: "https://example.com/", excerpt: "Hello", hasScreenshot: true });
  assert.equal(JSON.stringify(done).includes("connectUrl"), false);
  const shot = await s.call("GET", `/v1/jobs/${job.id}/screenshot`);
  assert.equal(shot.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), JPEG);
  assert.deepEqual(s.released, ["s1"]);
});

test("a second job is refused while one runs; cancel stops the first and frees the slot", async (t) => {
  const s = await boot({ hang: true }); t.after(s.close);
  const { job } = await (await s.call("POST", "/v1/jobs", { body: { url: "https://example.com/" } })).json();
  assert.equal((await s.call("POST", "/v1/jobs", { body: { url: "https://example.com/" } })).status, 429);
  assert.equal((await s.call("POST", "/v1/navigate", { body: { url: "https://example.com/" } })).status, 429);
  const c = await (await s.call("POST", `/v1/jobs/${job.id}/cancel`)).json();
  assert.ok(["cancelling", "cancelled"].includes(c.job.status));
  const done = await waitFor(async () => (await (await s.call("GET", `/v1/jobs/${job.id}`)).json()).job, (j) => j.status === "cancelled");
  assert.equal(done.sessionReleased, true); assert.deepEqual(s.released, ["s1"]);
  assert.equal((await s.call("GET", `/v1/jobs/${job.id}/screenshot`)).status, 404); // a cancelled job has no result to leak
  assert.equal((await s.call("POST", `/v1/jobs/${job.id}/cancel`)).status, 200);    // idempotent
  assert.equal((await s.call("POST", "/v1/jobs", { body: { url: "https://example.com/" } })).status, 202);
});

test("legacy /v1/navigate keeps its response shape and now shares the single slot", async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await s.call("POST", "/v1/navigate", { body: { url: "https://example.com" } });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.ok, true); assert.equal(b.title, "Example Domain");
  assert.deepEqual(Object.keys(b.screenshot).sort(), ["base64", "bytes", "mimeType"]);
  assert.equal(Buffer.from(b.screenshot.base64, "base64").length, JPEG.length);
});
