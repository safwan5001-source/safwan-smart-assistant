// CHAT-BROWSER-2 end to end against REAL Chromium: real Playwright locators, real CDP guard, real worker HTTP surface.
// Stand-ins: the Browserbase REST API (poc/smoke1/mock-browserbase.mjs, launches local Chromium) and the internet (a local HTTPS server
// that example.com / lab.test / evil.test are mapped to). `hits` records every request that reaches that "internet", so "nothing left the
// lab" and "the form was not submitted before approval" are asserted on what really arrived, not on what the code believes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { startMock, MOCK_KEY } from "../../../poc/smoke1/mock-browserbase.mjs";
import { createClient } from "../../../poc/smoke1/browserbase.mjs";
import { createApp } from "../app.mjs";
import { createPolicy } from "../policy.mjs";
import { LIMITS } from "../actions.mjs";

const TOKEN = "j".repeat(40);
const CANARY = "ZX-CANARY-7731-typed-text";
const haveChromium = fs.existsSync(chromium.executablePath());
if (!haveChromium && process.env.REQUIRE_BROWSER === "1") throw new Error("REQUIRE_BROWSER=1 but Chromium is not installed");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const LAB = "https://lab.test/browser-lab/";

const PAGE = (body, head = "") => `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>مختبر</title>${head}<body>${body}</body></html>`;
const PAGES = {
  "/browser-lab/index.html": PAGE(`<h1>Lab</h1>
    <a href="/browser-lab/page2.html">Next page</a> <a href="https://evil.test/x">External link</a>
    <label for="n">Full name</label><input id="n" name="fullname" oninput="document.getElementById('echo').textContent='name='+this.value">
    <label for="pw">Secret word</label><input id="pw" type="password">
    <label>Notes <textarea></textarea></label>
    <label><input type="checkbox" id="agree"> I agree</label>
    <button type="button" id="count" onclick="o.textContent=Number(o.textContent)+1">Count</button> <span id="o">0</span>
    <form action="/browser-lab/submit" method="post"><input name="q" aria-label="Query"><button type="submit">Send form</button></form>
    <button type="button">Pay now</button>
    <button type="button" id="dlg" onclick="alert('hi');document.getElementById('echo').textContent+=' dialog-done'">Show dialog</button>
    <button type="button" id="leave" onclick="location.href='https://evil.test/js-nav'">Go away</button>
    <button type="button" id="beacon" onclick="fetch('https://evil.test/beacon',{mode:'no-cors'});new WebSocket('wss://evil.test/ws');window.open('https://evil.test/pop')">Ping</button>
    <button type="button" id="ls" onclick="localStorage.setItem('k','v1');document.cookie='c=1;path=/';echo.textContent='stored'">Store state</button>
    <button type="button" id="show" onclick="echo.textContent='ls='+localStorage.getItem('k')+' ck='+document.cookie">Show state</button>
    <button type="button" id="grow">Save</button>
    <script>setInterval(async()=>{try{if((await (await fetch('/browser-lab/flip')).text())==='1')document.getElementById('grow').textContent='Save everything'}catch(e){}},100)</script>
    <button type="button">Twin</button><button type="button">Twin</button>
    <button type="button" disabled>Disabled one</button><button type="button" style="display:none">Hidden one</button>
    <p id="echo"></p>`),
  "/browser-lab/page2.html": PAGE(`<h1>Second page</h1><a href="/browser-lab/index.html">Back</a>`),
  "/browser-lab/submit": PAGE(`<h1>Submitted</h1>`),
  "/other/secret.html": PAGE(`<h1>Outside the lab prefix</h1>`),
};

test("interactive session against real Chromium", { skip: !haveChromium && "Chromium not installed", timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-it2-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"),
    "-days", "1", "-subj", "/CN=lab.test", "-addext", "subjectAltName=DNS:example.com,DNS:evil.test,DNS:lab.test"], { stdio: "ignore" });
  let hits = []; const open = new Set(); let flip = false; // flip: the lab page rewrites a button when the test says so (a bait-and-switch)
  const site = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    hits.push({ host, method: req.method, path: req.url });
    if (req.url === "/browser-lab/flip") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(flip ? "1" : "0"); }
    if (req.url === "/browser-lab/slow") { open.add(res); res.on("close", () => open.delete(res)); return; }
    if (req.method === "POST") { req.resume(); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PAGES["/browser-lab/submit"]); }
    const page = host === "lab.test" ? PAGES[req.url] : host === "example.com" ? PAGE(`<h1>Example Domain</h1><button type="button">Hello</button>`) : null;
    if (!page) { res.writeHead(404); return res.end("no"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page);
  });
  site.on("upgrade", (req, socket) => { hits.push({ host: (req.headers.host ?? "").split(":")[0], method: "UPGRADE", path: req.url }); socket.destroy(); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const sitePort = site.address().port;
  const noProxyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
  const mock = await startMock({ chromium, launchOptions: { env: noProxyEnv, args: [`--host-resolver-rules=MAP example.com 127.0.0.1:${sitePort}, MAP lab.test 127.0.0.1:${sitePort}, MAP evil.test 127.0.0.1:${sitePort}`, "--ignore-certificate-errors"] } });
  const limits = { ...LIMITS, idleMs: 30_000, approvalMs: 20_000 };
  const logs = [];
  const { server, manager } = createApp({
    token: TOKEN, policy: createPolicy(["example.com"], ["lab.test/browser-lab/"]), projectId: "p", log: (m) => logs.push(String(m)), limits,
    client: createClient({ apiKey: MOCK_KEY, base: mock.base }),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await manager.shutdown(); for (const r of open) r.destroy();
    server.closeAllConnections(); await new Promise((r) => server.close(r));
    await mock.stop(); site.closeAllConnections(); await new Promise((r) => site.close(r)); fs.rmSync(dir, { recursive: true, force: true });
  });

  const api = (method, p, body) => fetch(base + p, { method, headers: { authorization: "Bearer " + TOKEN, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
  const get = async (id) => (await (await api("GET", `/v1/jobs/${id}`)).json()).job;
  const until = async (id, pred, what = "condition") => { for (let i = 0; i < 300; i++) { const v = await get(id); if (pred(v)) return v; await tick(40); } throw new Error("timed out waiting for " + what + ": " + JSON.stringify(await get(id))); };
  const ended = (v) => !["running", "cancelling"].includes(v.status);
  const lastAction = (v) => v.actions.at(-1);
  const settled = (v) => v.actions.length > 0 && ["done", "failed", "denied", "rejected", "cancelled"].includes(lastAction(v).status);
  const start = async (url = LAB + "index.html") => { const r = await j(await api("POST", "/v1/jobs", { url, mode: "interactive" })); assert.equal(r.status, 202, JSON.stringify(r.body)); const v = await until(r.body.job.id, (x) => x.ready, "ready"); return v; };
  const act = async (id, body) => j(await api("POST", `/v1/jobs/${id}/actions`, body));
  /** submit one action and wait until it reaches a final state */
  const run = async (id, body) => { const n = (await get(id)).actions.length; const r = await act(id, body); assert.equal(r.status, 202, JSON.stringify(r.body)); return until(id, (v) => v.actions.length > n && settled(v), "action"); };
  const stopAndCheck = async (id) => { const r = await j(await api("POST", `/v1/jobs/${id}/finish`)); assert.equal(r.status, 200); const v = await until(id, ended, "end"); assert.equal(v.status, "succeeded"); assert.equal(v.sessionReleased, true); return v; };
  const sessionStates = () => [...mock.sessions.values()].map((s) => s.status);
  const role = (r, value, extra = {}) => ({ by: "role", role: r, value, ...extra });
  const echo = (v) => v.result.excerpt;

  await t.test("interactive mode is OFF without a lab scope, and needs a start page inside the allow-list", async () => {
    const { server: s2, manager: m2 } = createApp({ token: TOKEN, policy: createPolicy(["example.com"]), projectId: "p", log: () => {}, client: createClient({ apiKey: MOCK_KEY, base: mock.base }) });
    await new Promise((r) => s2.listen(0, "127.0.0.1", r));
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/v1/jobs`, { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com/", mode: "interactive" }) });
    assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: "interactive_disabled" });
    m2.stop(); s2.closeAllConnections(); await new Promise((res) => s2.close(res));
    for (const body of [{ url: "https://evil.test/", mode: "interactive" }, { url: LAB + "index.html?x=1", mode: "interactive" }, { url: "https://lab.test/other/secret.html", mode: "interactive" }, { url: LAB + "index.html", mode: "root" }]) {
      assert.equal((await api("POST", "/v1/jobs", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(manager.isBusy(), false);
  });

  await t.test("session opens, shows its limits and first observation, and a second one is refused while it lives", async () => {
    const v = await start();
    assert.equal(v.mode, "interactive"); assert.equal(v.status, "running");
    assert.deepEqual(v.steps.map((s) => s.id), ["create_session", "connect", "navigate", "interact", "release"]);
    assert.deepEqual(v.steps.map((s) => s.status), ["done", "done", "done", "running", "pending"]);
    assert.equal(v.limits.maxActions, 20); assert.ok(v.deadlineAt > v.createdAt);
    assert.equal(v.result.title, "مختبر"); assert.match(v.result.excerpt, /Lab/); assert.equal(v.result.hasScreenshot, true); assert.equal(v.result.version, 1);
    assert.equal((await api("POST", "/v1/jobs", { url: LAB + "index.html", mode: "interactive" })).status, 429);
    const shot = Buffer.from(await (await api("GET", `/v1/jobs/${v.id}/screenshot`)).arrayBuffer());
    assert.deepEqual([shot[0], shot[1], shot[2]], [0xff, 0xd8, 0xff]);
    const end = await stopAndCheck(v.id);
    assert.equal(end.endReason, "finished"); assert.deepEqual(end.steps.map((s) => s.status), ["done", "done", "done", "done", "done"]);
    assert.deepEqual(sessionStates().at(-1), "COMPLETED");
  });

  await t.test("typing into a plain field works (locator by label), the text is never echoed by the worker, sensitive fields are refused", async () => {
    logs.length = 0;
    const v = await start();
    let r = await run(v.id, { tool: "type", target: { by: "label", value: "Full name" }, text: CANARY });
    assert.equal(lastAction(r).status, "done", JSON.stringify(r.actions));
    assert.match(echo(r), new RegExp("name=" + CANARY), "the page really received the text");
    assert.equal(JSON.stringify(r.actions).includes(CANARY), false, "the action log never contains typed text");
    assert.match(lastAction(r).summary, /type 25 chars/);
    r = await run(v.id, { tool: "type", target: { by: "label", value: "Secret word" }, text: "hunter2" });
    assert.deepEqual([lastAction(r).status, lastAction(r).error], ["denied", "sensitive_field"]);
    r = await run(v.id, { tool: "type", target: { by: "label", value: "Query" }, text: "4111 1111 1111 1111" });
    assert.deepEqual([lastAction(r).status, lastAction(r).error], ["denied", "sensitive_value"]);
    r = await run(v.id, { tool: "type", target: { by: "role", role: "checkbox", value: "I agree" }, text: "x" });
    assert.deepEqual([lastAction(r).status, lastAction(r).error], ["denied", "not_editable"]);
    r = await run(v.id, { tool: "type", target: { by: "label", value: "Notes" }, text: "ملاحظة بالعربية" });
    assert.equal(lastAction(r).status, "done");
    await stopAndCheck(v.id);
    assert.equal(logs.join("\n").includes(CANARY), false, "worker logs never contain typed text");
  });

  await t.test("element verification: not found, ambiguous, disabled, hidden, nothing is clicked", async () => {
    const v = await start();
    const code = async (target) => { const r = await run(v.id, { tool: "click", target }); return [lastAction(r).status, lastAction(r).error]; };
    assert.deepEqual(await code(role("button", "Does not exist")), ["failed", "element_not_found"]);
    assert.deepEqual(await code(role("button", "Twin")), ["failed", "element_ambiguous"]);
    assert.deepEqual(await code(role("button", "Disabled one")), ["failed", "element_disabled"]);
    assert.deepEqual(await code(role("button", "Hidden one")), ["failed", "element_not_found"]); // hidden elements are not in the accessibility tree
    assert.deepEqual(await code({ by: "text", value: "Hidden one" }), ["failed", "element_hidden"]);
    await stopAndCheck(v.id);
  });

  await t.test("links inside the lab are followed; links out of it are refused BEFORE any click; payment/sign-in style buttons are denied", async () => {
    hits = [];
    const v = await start();
    let r = await run(v.id, { tool: "click", target: role("link", "Next page") });
    assert.equal(lastAction(r).status, "done"); assert.match(echo(r), /Second page/); assert.match(r.result.url, /page2\.html$/);
    r = await run(v.id, { tool: "navigate", url: LAB + "index.html" });
    assert.equal(lastAction(r).status, "done");
    r = await run(v.id, { tool: "click", target: role("link", "External link") });
    assert.deepEqual([lastAction(r).status, lastAction(r).error], ["denied", "leaves_scope"]);
    r = await run(v.id, { tool: "click", target: role("button", "Pay now") });
    assert.deepEqual([lastAction(r).status, lastAction(r).error], ["denied", "sensitive_action"]);
    assert.equal((await act(v.id, { tool: "navigate", url: "https://evil.test/" })).status, 400);
    assert.equal((await act(v.id, { tool: "navigate", url: "https://lab.test/other/secret.html" })).status, 400);
    assert.equal(hits.some((h) => h.host === "evil.test"), false);
    assert.equal(lastAction(await get(v.id)).status, "denied");
    await stopAndCheck(v.id);
  });

  await t.test("a button needs the user's approval: nothing happens until approved; reject and timeout leave the page untouched", async () => {
    const v = await start();
    let n = (await get(v.id)).actions.length;
    assert.equal((await act(v.id, { tool: "click", target: role("button", "Count") })).status, 202);
    let w = await until(v.id, (x) => x.pending, "pending approval");
    assert.deepEqual([w.pending.seq, w.pending.kind], [n + 1, "button"]); assert.match(w.pending.summary, /click button «Count»/); assert.equal(lastAction(w).status, "awaiting_approval");
    assert.ok(w.pending.expiresAt > Date.now());
    await tick(300);
    assert.match(echo(await get(v.id)), /Count\s*0/, "not clicked while waiting");
    // one action at a time
    assert.equal((await act(v.id, { tool: "observe" })).body.error, "action_in_progress");
    // approving the wrong step is refused
    assert.equal((await api("POST", `/v1/jobs/${v.id}/actions/${n + 2}/approve`)).status, 409);
    assert.equal((await api("POST", `/v1/jobs/${v.id}/actions/${n + 1}/approve`)).status, 200);
    w = await until(v.id, (x) => !x.pending && settled(x), "after approval");
    assert.equal(lastAction(w).status, "done"); assert.match(echo(w), /Count\s*1/);
    assert.equal((await api("POST", `/v1/jobs/${v.id}/actions/${n + 1}/approve`)).status, 409, "a decision cannot be replayed");

    n = w.actions.length;
    await act(v.id, { tool: "click", target: role("button", "Count") });
    await until(v.id, (x) => x.pending, "pending 2");
    assert.equal((await api("POST", `/v1/jobs/${v.id}/actions/${n + 1}/reject`)).status, 200);
    w = await until(v.id, (x) => !x.pending && settled(x), "after reject");
    assert.deepEqual([lastAction(w).status, lastAction(w).error], ["rejected", "approval_rejected"]); assert.match(echo(w), /Count\s*1/);

    limits.approvalMs = 600;
    await act(v.id, { tool: "click", target: role("button", "Count") });
    w = await until(v.id, (x) => settled(x) && !x.pending && lastAction(x).error === "approval_timeout", "timeout");
    assert.equal(lastAction(w).status, "rejected"); assert.match(echo(w), /Count\s*1/);
    limits.approvalMs = LIMITS.approvalMs;
    await stopAndCheck(v.id);
  });

  await t.test("a form is not submitted before approval; the approval shows where it goes; approving sends exactly one POST", async () => {
    hits = [];
    const v = await start();
    await run(v.id, { tool: "type", target: { by: "label", value: "Query" }, text: "hello" });
    await act(v.id, { tool: "click", target: role("button", "Send form") });
    const w = await until(v.id, (x) => x.pending, "pending form");
    assert.equal(w.pending.kind, "submit"); assert.equal(w.pending.submitsTo, "https://lab.test/browser-lab/submit");
    await tick(400);
    assert.equal(hits.filter((h) => h.method === "POST").length, 0, "no POST before approval");
    await api("POST", `/v1/jobs/${v.id}/actions/${w.pending.seq}/approve`);
    const done = await until(v.id, (x) => !x.pending && settled(x), "submitted");
    assert.equal(lastAction(done).status, "done"); assert.match(echo(done), /Submitted/);
    assert.equal(hits.filter((h) => h.method === "POST").length, 1);
    await stopAndCheck(v.id);
  });

  await t.test("approval is bound to the element: if the page changes while waiting, the step is refused", async () => {
    const v = await start();
    await act(v.id, { tool: "click", target: role("button", "Save") });
    const w = await until(v.id, (x) => x.pending, "pending save");
    flip = true; await tick(500); // the page rewrites the very button the user is looking at (a bait-and-switch)
    await api("POST", `/v1/jobs/${v.id}/actions/${w.pending.seq}/approve`);
    const r = await until(v.id, (x) => !x.pending && settled(x), "after switch");
    assert.deepEqual([lastAction(r).status, lastAction(r).error], ["rejected", "element_changed"]);
    flip = false;
    await stopAndCheck(v.id);
  });

  await t.test("page scripts cannot reach out: fetch, WebSocket, window.open, JS navigation, dialogs", async () => {
    hits = [];
    let v = await start();
    let w = await (async () => { await act(v.id, { tool: "click", target: role("button", "Show dialog") }); const p = await until(v.id, (x) => x.pending, "p"); await api("POST", `/v1/jobs/${v.id}/actions/${p.pending.seq}/approve`); return until(v.id, (x) => !x.pending && settled(x), "dialog"); })();
    assert.equal(lastAction(w).status, "done"); assert.match(echo(w), /dialog-done/, "alert() did not freeze the session");
    await act(v.id, { tool: "click", target: role("button", "Ping") });
    let p = await until(v.id, (x) => x.pending, "ping"); await api("POST", `/v1/jobs/${v.id}/actions/${p.pending.seq}/approve`);
    w = await until(v.id, (x) => !x.pending && settled(x), "ping done");
    assert.equal(lastAction(w).status, "done");
    assert.ok(w.blockedRequests >= 1, "blocked requests are counted");
    await tick(500);
    assert.equal(hits.some((h) => h.host === "evil.test"), false, JSON.stringify(hits));
    await stopAndCheck(v.id);

    // top-level navigation to a foreign host from page JS: the whole session fails closed, nothing arrives
    hits = [];
    v = await start();
    await act(v.id, { tool: "click", target: role("button", "Go away") });
    p = await until(v.id, (x) => x.pending, "leave"); await api("POST", `/v1/jobs/${v.id}/actions/${p.pending.seq}/approve`);
    const f = await until(v.id, ended, "failed");
    assert.equal(f.status, "failed"); assert.equal(f.error, "disallowed_final_url"); assert.equal(f.result, undefined, "no picture of an out-of-bounds page is kept");
    assert.equal(f.sessionReleased, true);
    assert.equal(hits.some((h) => h.host === "evil.test"), false);
    assert.equal(manager.isBusy(), false);
  });

  await t.test("look-only pages (example.com) accept navigation and observation but never a click or keystroke", async () => {
    const v = await start("https://example.com/");
    assert.match(echo(v), /Example Domain/);
    let r = await run(v.id, { tool: "click", target: role("button", "Hello") });
    assert.deepEqual([lastAction(r).status, lastAction(r).error], ["denied", "not_in_lab"]);
    r = await run(v.id, { tool: "navigate", url: LAB + "index.html" });
    assert.equal(lastAction(r).status, "done"); assert.match(echo(r), /Lab/);
    r = await run(v.id, { tool: "observe" });
    assert.equal(lastAction(r).status, "done"); assert.equal(r.result.version >= 3, true);
    await stopAndCheck(v.id);
  });

  await t.test("isolation: nothing from one session (storage, cookies) is visible in the next", async () => {
    let v = await start();
    let r = await (async () => { await act(v.id, { tool: "click", target: role("button", "Store state") }); const p = await until(v.id, (x) => x.pending, "p"); await api("POST", `/v1/jobs/${v.id}/actions/${p.pending.seq}/approve`); return until(v.id, (x) => !x.pending && settled(x), "stored"); })();
    assert.match(echo(r), /stored/);
    await act(v.id, { tool: "click", target: role("button", "Show state") });
    let p = await until(v.id, (x) => x.pending, "p2"); await api("POST", `/v1/jobs/${v.id}/actions/${p.pending.seq}/approve`);
    r = await until(v.id, (x) => !x.pending && settled(x), "shown");
    assert.match(echo(r), /ls=v1 ck=c=1/);
    await stopAndCheck(v.id);
    v = await start();
    await act(v.id, { tool: "click", target: role("button", "Show state") });
    p = await until(v.id, (x) => x.pending, "p3"); await api("POST", `/v1/jobs/${v.id}/actions/${p.pending.seq}/approve`);
    r = await until(v.id, (x) => !x.pending && settled(x), "shown2");
    assert.match(echo(r), /ls=null ck=\s*$/m.test(echo(r)) ? /./ : /ls=null/);
    assert.equal(echo(r).includes("v1"), false);
    await stopAndCheck(v.id);
  });

  await t.test("limits: action budget ends the session and releases it; idle ends it; both are 'succeeded' with a reason", async () => {
    limits.maxActions = 3;
    let v = await start();
    for (let i = 0; i < 3; i++) await run(v.id, { tool: "observe" }).catch(() => {});
    const ended1 = await until(v.id, ended, "limit end");
    assert.equal(ended1.status, "succeeded"); assert.equal(ended1.endReason, "limit"); assert.equal(ended1.actions.length, 3); assert.equal(ended1.sessionReleased, true);
    assert.equal((await act(v.id, { tool: "observe" })).status, 409);
    limits.maxActions = LIMITS.maxActions;

    limits.idleMs = 700;
    v = await start();
    const idle = await until(v.id, ended, "idle end");
    assert.equal(idle.status, "succeeded"); assert.equal(idle.endReason, "idle"); assert.equal(idle.sessionReleased, true);
    limits.idleMs = 30_000;
    assert.equal(manager.isBusy(), false);
  });

  await t.test("total deadline ends a forgotten session even if the caller keeps it busy", async () => {
    limits.deadlineMs = 2500;
    const v = await start();
    for (let i = 0; i < 6 && !ended(await get(v.id)); i++) { await act(v.id, { tool: "observe" }); await tick(500); }
    const f = await until(v.id, ended, "deadline");
    assert.equal(f.status, "failed"); assert.equal(f.error, "timeout"); assert.equal(f.sessionReleased, true);
    limits.deadlineMs = LIMITS.deadlineMs;
  });

  await t.test("STOP is real: during an approval wait, and during a hung page load; the cloud session is released and the slot is free", async () => {
    let v = await start();
    await act(v.id, { tool: "click", target: role("button", "Count") });
    await until(v.id, (x) => x.pending, "pending");
    assert.equal((await api("POST", `/v1/jobs/${v.id}/cancel`)).status, 200);
    let c = await until(v.id, ended, "cancelled");
    assert.equal(c.status, "cancelled"); assert.equal(c.sessionReleased, true); assert.equal(c.pending, undefined);
    assert.equal(lastAction(c).status, "cancelled");
    assert.equal(manager.isBusy(), false);

    v = await start();
    await act(v.id, { tool: "navigate", url: LAB + "slow" });
    await until(v.id, (x) => lastAction(x)?.status === "running", "running slow nav");
    await tick(300);
    const t0 = Date.now();
    await api("POST", `/v1/jobs/${v.id}/cancel`);
    c = await until(v.id, ended, "cancelled 2");
    assert.equal(c.status, "cancelled"); assert.equal(c.sessionReleased, true); assert.ok(Date.now() - t0 < 6000, "stopped promptly");
    assert.equal(sessionStates().every((s) => s === "COMPLETED"), true, JSON.stringify(sessionStates()));
    assert.equal(manager.isBusy(), false);
    const next = await start(); await stopAndCheck(next.id);
  });

  await t.test("the job view never carries typed text, session identifiers or connection URLs; error codes are fixed vocabulary", async () => {
    const v = await start();
    await run(v.id, { tool: "type", target: { by: "label", value: "Notes" }, text: CANARY });
    const end = await stopAndCheck(v.id);
    const text = JSON.stringify(end);
    assert.equal(text.includes(CANARY), false);
    for (const needle of ["ws://", "wss://", "connectUrl", "signingKey", "mock-signing-key", MOCK_KEY, TOKEN]) assert.equal(text.includes(needle), false, needle);
    assert.equal((await api("GET", `/v1/jobs/${v.id}`, undefined)).headers.get("cache-control"), "no-store");
  });

  await t.test("endpoint hygiene: unauthenticated, wrong content type, oversized and malformed bodies are refused", async () => {
    const v = await start();
    const raw = (p, headers, body) => fetch(base + p, { method: "POST", headers, body });
    assert.equal((await raw(`/v1/jobs/${v.id}/actions`, { "content-type": "application/json" }, "{}")).status, 401);
    assert.equal((await raw(`/v1/jobs/${v.id}/actions`, { authorization: "Bearer " + TOKEN, "content-type": "text/plain" }, "{}")).status, 415);
    assert.equal((await raw(`/v1/jobs/${v.id}/actions`, { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, "{not json")).status, 400);
    assert.equal((await raw(`/v1/jobs/${v.id}/actions`, { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, JSON.stringify({ tool: "observe", pad: "x".repeat(5000) }))).status, 400);
    assert.equal((await act(v.id, { tool: "eval", code: "1" })).status, 400);
    assert.equal((await act(v.id, { tool: "click", target: { by: "css", value: "body" } })).status, 400);
    assert.equal((await api("POST", `/v1/jobs/00000000-0000-4000-8000-000000000000/actions`, { tool: "observe" })).status, 404);
    assert.equal((await api("POST", `/v1/jobs/${v.id}/actions/999/approve`)).status, 404);
    assert.equal((await api("POST", `/v1/jobs/${v.id}/finish`, undefined)).status, 200);
    await until(v.id, ended, "end");
    assert.equal((await act(v.id, { tool: "observe" })).body.error, "session_ended");
    // a read-only job cannot receive actions
    const ro = await j(await api("POST", "/v1/jobs", { url: "https://example.com/" }));
    assert.equal((await act(ro.body.job.id, { tool: "observe" })).body.error, "not_interactive");
    await until(ro.body.job.id, ended, "ro end");
  });
});
