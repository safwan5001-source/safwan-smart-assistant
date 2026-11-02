// F1 root-cause suite: a HOSTILE lab page (it lies to every in-page read, listens for clicks, navigates on timers, redirects POSTs, serves
// downloads, opens popups) against REAL Chromium. Every assertion is about what actually ARRIVED at the fixture server (`hits`), so the suite
// fails on the pre-fix design (facts read in the page's own JavaScript world, approval based on those facts) and passes on the fix
// (facts read from an isolated world + accessibility tree, and a network-level effect gate that no page script can talk its way past).
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

const TOKEN = "h".repeat(40);
const haveChromium = fs.existsSync(chromium.executablePath());
if (!haveChromium && process.env.REQUIRE_BROWSER === "1") throw new Error("REQUIRE_BROWSER=1 but Chromium is not installed");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const LAB = "https://lab.test/browser-lab/";
const PAGE = (body, head = "") => `<!doctype html><html><meta charset="utf-8"><title>hostile</title>${head}<body>${body}</body></html>`;

// the page lies about everything a helper could ask it, BEFORE any other script runs
const LIAR = `<script>
const lie = (proto, name, val) => { try { Object.defineProperty(proto, name, { configurable: true, get() { return val; } }); } catch (e) {} };
lie(Element.prototype, "tagName", "A"); lie(Element.prototype, "localName", "a"); lie(Node.prototype, "nodeName", "A"); lie(Element.prototype, "attributes", []);
Element.prototype.getAttribute = function () { return null; }; Element.prototype.hasAttribute = function () { return false; }; Element.prototype.closest = function () { return null; };
lie(HTMLElement.prototype, "innerText", "Next page"); lie(Node.prototype, "textContent", "Next page"); lie(HTMLButtonElement.prototype, "form", null);
lie(HTMLButtonElement.prototype, "type", "button"); lie(HTMLElement.prototype, "href", "https://lab.test/browser-lab/page2.html"); lie(HTMLAnchorElement.prototype, "href", "https://lab.test/browser-lab/page2.html"); lie(HTMLElement.prototype, "isContentEditable", false);
</script>`;
const POST = (url, body = "x") => `fetch(${JSON.stringify(url)},{method:"POST",body:${JSON.stringify(body)}})`;
const PAGES = {
  "/browser-lab/liar.html": PAGE(`${LIAR}<button id="b">Continue</button><script>document.getElementById("b").addEventListener("click",()=>${POST("/browser-lab/api/transfer-all", "amount=1000")});</script>`),
  "/browser-lab/listener-link.html": PAGE(`<a id="l" href="/browser-lab/page2.html">Read more</a><script>document.getElementById("l").addEventListener("click",()=>${POST("/browser-lab/api/link-effect")});</script>`),
  "/browser-lab/submit-handler.html": PAGE(`<form action="/browser-lab/submit" method="post"><input name="q" aria-label="Query"><button type="submit">Send form</button></form>
    <script>document.forms[0].addEventListener("submit",()=>{${POST("/browser-lab/api/other-endpoint")};navigator.sendBeacon("/browser-lab/api/beacon","x");});</script>`),
  "/browser-lab/redirect-form.html": PAGE(`<form action="/browser-lab/redir" method="post"><button type="submit">Save record</button></form>`),
  "/browser-lab/download.html": PAGE(`<a href="/browser-lab/file.bin">Get the file</a> <a href="/browser-lab/file.txt">Get the text</a>`),
  "/browser-lab/timers.html": PAGE(`<p id="o">timers</p><script>setTimeout(()=>{location.href="/browser-lab/page2.html?moved=1"},1200);
    setInterval(()=>{fetch("/browser-lab/api/delete?id=1").catch(()=>{});var x=new XMLHttpRequest();x.open("GET","/browser-lab/api/xhr?id=1");x.send();new Image().src="/browser-lab/api/pixel?id=1";try{new EventSource("/browser-lab/api/sse")}catch(e){}},300);</script>`),
  "/browser-lab/popups.html": PAGE(`<a id="a" target="_blank" href="/browser-lab/page2.html">Open elsewhere</a><button id="p" type="button" onclick="window.open('/browser-lab/page2.html');window.open('https://evil.test/p')">Pop</button>`),
  "/browser-lab/pseudo.html": PAGE(`<style>#x::before{content:"Pay now"}</style><button id="x" type="button"></button><button type="button" aria-labelledby="lbl"></button><span id="lbl" hidden>Delete account</span>`),
  "/browser-lab/cookies.html": PAGE(`<p id="o"></p><script>document.getElementById("o").textContent="cookies=["+document.cookie+"] storage="+localStorage.length;</script>`),
  "/browser-lab/offscope.html": PAGE(`<a href="/browser-lab/go-evil">Leave the lab</a>`),
  "/browser-lab/payload.html": PAGE(`<form id="f" action="/browser-lab/submit" method="post"><input type="hidden" name="amount" value="10"><input name="note" aria-label="Note" value="hello"><input type="password" name="pin" value="1234"><button type="submit">Send record</button></form>
    <script>document.getElementById("f").addEventListener("submit",()=>{ if (location.hash === "#tamper") document.querySelector("[name=amount]").value = "9999999"; });</script>`),
  "/browser-lab/get-form.html": PAGE(`<form id="g" action="/browser-lab/search" method="get"><input type="hidden" name="record" value="A"><input name="q" aria-label="Query" value="x"><button type="submit">Search records</button></form>
    <script>document.getElementById("g").addEventListener("submit",()=>{ if (location.hash === "#tamper") document.querySelector("[name=record]").value = "B"; });</script>`),
  "/browser-lab/search": PAGE(`<h1>Results</h1>`),
  "/browser-lab/big-form.html": PAGE(`<form action="/browser-lab/submit" method="post">${Array.from({ length: 14 }, (_, i) => `<input type="hidden" name="f${i}" value="v">`).join("")}<button type="submit">Send many</button></form>
    <form action="/browser-lab/submit" method="post"><input type="hidden" name="long" value="${"x".repeat(61)}"><button type="submit">Send long</button></form>`),
  "/browser-lab/shadow.html": PAGE(`<my-box id="b"></my-box><script>const r = document.getElementById("b").attachShadow({ mode: "open" }); r.innerHTML = '<input aria-label="Inner field"><button type="button">Inner go</button>';</script>`),
  "/browser-lab/pixel-page.html": PAGE(`<img src="/browser-lab/pixel" alt="" width="1" height="1">`),
  "/browser-lab/redir-get.html": PAGE(`<form action="/browser-lab/search-redir" method="get"><input type="hidden" name="record" value="A"><button type="submit">Search again</button></form>`),
  "/browser-lab/focus-trick.html": PAGE(`<input id="real" type="password" aria-label="Code"><input id="decoy" aria-label="Backup note"><script>let n = 0; document.getElementById("real").addEventListener("focus", () => { if (n++ < 2) document.getElementById("decoy").focus(); });</script>`),
  "/browser-lab/overlay.html": PAGE(`<div style="position:relative;width:200px;height:40px"><input id="real" type="password" aria-label="Code" style="position:absolute;inset:0;width:200px;height:40px"><input id="decoy" aria-label="Other" style="position:absolute;inset:0;width:200px;height:40px;z-index:5"></div>`),
  "/browser-lab/long-attrs.html": PAGE(`<input placeholder="Reference box" autocomplete="section-${"a".repeat(60)} billing cc-number"><input placeholder="Notes box" aria-label="${"x".repeat(3000)} note">`),
  "/browser-lab/page2.html": PAGE(`<h1>Second page</h1>`),
  "/browser-lab/submit": PAGE(`<h1>Submitted</h1>`),
};

test("hostile lab page against real Chromium", { skip: !haveChromium && "Chromium not installed", timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-hostile-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"),
    "-days", "1", "-subj", "/CN=lab.test", "-addext", "subjectAltName=DNS:example.com,DNS:evil.test,DNS:lab.test"], { stdio: "ignore" });
  let hits = [];
  const site = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    hits.push({ host, method: req.method, path: req.url, cookie: req.headers.cookie, referer: req.headers.referer });
    if (req.method !== "GET" && req.method !== "HEAD") { req.resume(); }
    if (req.url === "/browser-lab/redir" && req.method === "POST") { res.writeHead(307, { location: "/browser-lab/api/transfer-after-redirect" }); return res.end(); }
    if (req.url === "/browser-lab/go-evil") { res.writeHead(302, { location: "https://evil.test/stolen" }); return res.end(); }
    if (req.url.startsWith("/browser-lab/search-redir")) { res.writeHead(302, { location: "/browser-lab/search?record=B" }); return res.end(); }
    if (req.url === "/browser-lab/pixel") { res.writeHead(302, { location: "/browser-lab/api/event?id=1" }); return res.end(); }
    if (req.url === "/browser-lab/file.bin") { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="x.bin"' }); return res.end("BINARY"); }
    if (req.url === "/browser-lab/file.txt") { res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=x.txt" }); return res.end("text"); }
    if (req.url.startsWith("/browser-lab/api/")) { res.writeHead(200, { "content-type": "text/plain", "set-cookie": "leak=1; Path=/" }); return res.end("ok"); }
    const page = host === "lab.test" ? (PAGES[req.url.split("?")[0]]) : null;
    if (!page) { res.writeHead(404); return res.end("no"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const sitePort = site.address().port;
  const noProxyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
  const mock = await startMock({ chromium, launchOptions: { env: noProxyEnv, args: [`--host-resolver-rules=MAP example.com 127.0.0.1:${sitePort}, MAP lab.test 127.0.0.1:${sitePort}, MAP evil.test 127.0.0.1:${sitePort}`, "--ignore-certificate-errors"] } });
  const limits = { ...LIMITS, idleMs: 60_000, approvalMs: 30_000 };
  const { server, manager } = createApp({ token: TOKEN, policy: createPolicy(["example.com"], ["lab.test/browser-lab/"]), projectId: "p", log: () => {}, limits, sessionCsp: null, client: createClient({ apiKey: MOCK_KEY, base: mock.base }) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await manager.shutdown(); server.closeAllConnections(); await new Promise((r) => server.close(r)); await mock.stop(); site.closeAllConnections(); await new Promise((r) => site.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

  const api = (method, p, body) => fetch(base + p, { method, headers: { authorization: "Bearer " + TOKEN, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const get = async (id) => (await (await api("GET", `/v1/jobs/${id}`)).json()).job;
  const until = async (id, pred, what) => { for (let i = 0; i < 400; i++) { const v = await get(id); if (pred(v)) return v; await tick(40); } throw new Error("timed out: " + what + " " + JSON.stringify(await get(id))); };
  const ended = (v) => !["running", "cancelling"].includes(v.status);
  const final = (a) => a && ["done", "failed", "denied", "rejected", "cancelled"].includes(a.status);
  const last = (v) => v.actions.at(-1);
  const start = async (page) => { await manager.shutdown(); const r = await api("POST", "/v1/jobs", { url: LAB + page, mode: "interactive" }); assert.equal(r.status, 202); const j = (await r.json()).job; return until(j.id, (x) => x.ready, "ready"); };
  const stop = async (id) => { await api("POST", `/v1/jobs/${id}/finish`); const v = await until(id, ended, "end"); assert.equal(v.sessionReleased, true); };
  /** One user action; if it stops for approval the "user" APPROVES it (the worst case for the owner), then wait until it is final. */
  const doApproved = async (id, body) => {
    const n = (await get(id)).actions.length;
    assert.equal((await api("POST", `/v1/jobs/${id}/actions`, body)).status, 202);
    for (let i = 0; i < 400; i++) {
      const v = await get(id);
      if (v.pending && v.pending.seq === n + 1) { await api("POST", `/v1/jobs/${id}/actions/${v.pending.seq}/approve`); }
      if (v.actions.length > n && final(v.actions[n]) && !v.pending) return v;
      await tick(40);
    }
    throw new Error("action never settled");
  };
  const mutate = async (fn) => { const sess = [...mock.sessions.values()].at(-1); const b = await chromium.connectOverCDP(sess.connectUrl); try { await b.contexts()[0].pages()[0].evaluate(fn); } finally { await b.close(); } };
  const role = (r, value) => ({ by: "role", role: r, value });
  const posts = () => hits.filter((h) => h.method !== "GET" && h.method !== "HEAD");
  const effect = (v) => `${last(v).status}/${last(v).error ?? "-"}`;

  await t.test("F1 PoC: a page that lies about tag/href/text/attributes cannot turn a scripted POST into an unapproved, successful click", async () => {
    hits = [];
    const v = await start("liar.html");
    const r = await doApproved(v.id, { tool: "click", target: role("button", "Continue") });
    await tick(500);
    assert.deepEqual(posts().map((h) => h.path), [], `no state-changing request may arrive; got ${JSON.stringify(posts())}; action ${effect(r)}`);
    assert.notEqual(last(r).status, "done", "the scripted effect must not be reported as a successful click");
    await stop(v.id);
  });

  await t.test("a link with a script listener: the allowed click is navigation only, the scripted POST never leaves", async () => {
    hits = [];
    const v = await start("listener-link.html");
    const r = await doApproved(v.id, { tool: "click", target: role("link", "Read more") });
    await tick(500);
    assert.deepEqual(posts().map((h) => h.path), [], JSON.stringify(posts()));
    assert.equal(last(r).error, "effect_blocked", effect(r));
    await stop(v.id);
  });

  await t.test("an approved form submit sends exactly the approved request: handler fetch/sendBeacon to other endpoints are blocked", async () => {
    hits = [];
    const v = await start("submit-handler.html");
    const r = await doApproved(v.id, { tool: "click", target: role("button", "Send form") });
    await tick(500);
    assert.deepEqual(posts().map((h) => h.path), ["/browser-lab/submit"], JSON.stringify(posts()));
    assert.equal(last(r).error, "effect_blocked", "the extra scripted requests are reported, not silently ignored: " + effect(r));
    await stop(v.id);
  });

  await t.test("a 307 redirect of the approved POST to another in-scope endpoint is not re-POSTed", async () => {
    hits = [];
    const v = await start("redirect-form.html");
    const r = await doApproved(v.id, { tool: "click", target: role("button", "Save record") });
    await tick(500);
    assert.deepEqual(posts().map((h) => h.path), ["/browser-lab/redir"], `only the approved destination: ${JSON.stringify(posts())} (${effect(r)})`);
    await stop(v.id);
  });

  await t.test("downloads: attachment / octet-stream responses are blocked by the browser guard itself (not by provider settings)", async () => {
    hits = [];
    const v = await start("download.html");
    for (const name of ["Get the file", "Get the text"]) {
      const r = await doApproved(v.id, { tool: "click", target: role("link", name) });
      assert.equal(last(r).error, "download_blocked", `${name}: ${effect(r)} job=${r.status}/${r.error} ${JSON.stringify(last(r))}`);
      assert.equal(last(r).status, "denied");
    }
    assert.ok((await get(v.id)).result.url.endsWith("/browser-lab/download.html"), "the session stayed on the page");
    await stop(v.id);
  });

  await t.test("idle page scripts cannot navigate, fetch, XHR, EventSource, or load query-carrying images", async () => {
    hits = [];
    const v = await start("timers.html");
    await tick(2500);
    const r = await doApproved(v.id, { tool: "observe" });
    assert.match(r.result.url, /\/browser-lab\/timers\.html$/, "a timer navigation must not move the session");
    assert.deepEqual(hits.filter((h) => /\/api\/|page2/.test(h.path)).map((h) => h.path), [], "nothing from the page's scripts reached the server");
    assert.ok(r.blockedRequests >= 3, `blocked requests are counted (${r.blockedRequests})`);
    await stop(v.id);
  });

  await t.test("popups: scripted and target=_blank opens (even to an in-scope URL) never load", async () => {
    hits = [];
    const v = await start("popups.html");
    await doApproved(v.id, { tool: "click", target: role("button", "Pop") });
    await doApproved(v.id, { tool: "click", target: role("link", "Open elsewhere") }).catch(() => {});
    await tick(600);
    assert.equal(hits.some((h) => h.host === "evil.test"), false);
    assert.equal(hits.filter((h) => h.path.startsWith("/browser-lab/page2")).length <= 1, true, "at most the same-tab navigation of the link, never a second window: " + JSON.stringify(hits));
    await stop(v.id);
  });

  await t.test("a redirect from the lab to a foreign host: nothing reaches it (refused by the gate), the action is reported, the session survives on its previous page", async () => {
    hits = [];
    const v = await start("offscope.html");
    const r = await doApproved(v.id, { tool: "click", target: role("link", "Leave the lab") });
    assert.equal(hits.some((h) => h.host === "evil.test"), false, JSON.stringify(hits));
    assert.deepEqual([last(r).status, last(r).error], ["denied", "effect_blocked"]);
    assert.match(r.result.url, /\/browser-lab\/offscope\.html$/, "returned to the page it came from");
    await stop(v.id);
  });

  await t.test("an in-scope redirect from the approved GET to a URL with DIFFERENT data is not followed", async () => {
    hits = [];
    const v = await start("redir-get.html");
    const r = await doApproved(v.id, { tool: "click", target: role("button", "Search again") });
    await tick(400);
    assert.equal(hits.some((h) => h.path.includes("record=B")), false, JSON.stringify(hits));
    assert.deepEqual([last(r).status, last(r).error], ["denied", "effect_blocked"]);
    await stop(v.id);
  });

  await t.test("a focus-redirect trick (password field bounces focus to a decoy) cannot make the typed text land in a field that was not classified", async () => {
    const v = await start("focus-trick.html");
    const r = await doApproved(v.id, { tool: "type", target: { by: "label", value: "Code" }, text: "hunter2" });
    assert.deepEqual([last(r).status, last(r).error], ["denied", "sensitive_field"]);
    assert.doesNotMatch(r.result.excerpt, /hunter2/);
    await stop(v.id);
  });

  await t.test("a decoy laid over the named field is refused, not typed into", async () => {
    const v = await start("overlay.html");
    const r = await doApproved(v.id, { tool: "type", target: { by: "label", value: "Code" }, text: "abc" });
    assert.deepEqual([last(r).status, last(r).error], ["denied", "element_mismatch"]);
    assert.doesNotMatch(r.result.excerpt, /abc/);
    await stop(v.id);
  });

  await t.test("sensitive words hidden beyond any display cut (long labels, long autocomplete) are still seen", async () => {
    const v = await start("long-attrs.html");
    let r = await doApproved(v.id, { tool: "type", target: { by: "placeholder", value: "Reference box" }, text: "123" });
    assert.deepEqual([last(r).status, last(r).error], ["denied", "sensitive_field"], "section-<long> billing cc-number");
    r = await doApproved(v.id, { tool: "type", target: { by: "placeholder", value: "Notes box" }, text: "123" });
    assert.deepEqual([last(r).status, last(r).error], ["denied", "unsupported_target"], "a 3000-character label is refused, never silently shortened");
    await stop(v.id);
  });

  await t.test("the owner sees WHAT a form will send (hidden fields included, passwords masked); changing it after approval refuses the step", async () => {
    hits = [];
    const v = await start("payload.html");
    const n = (await get(v.id)).actions.length;
    await api("POST", `/v1/jobs/${v.id}/actions`, { tool: "click", target: role("button", "Send record") });
    const w = await until(v.id, (x) => x.pending, "pending payload");
    assert.deepEqual(w.pending.fields, [{ name: "amount", value: "10" }, { name: "note", value: "hello" }, { name: "pin", value: "••••" }]);
    assert.equal(w.pending.method, "POST");
    await mutate(() => { document.querySelector("[name=amount]").value = "1000000"; });
    await api("POST", `/v1/jobs/${v.id}/actions/${w.pending.seq}/approve`);
    const r = await until(v.id, (x) => !x.pending && x.actions.length > n && final(x.actions[n]), "after tamper");
    assert.deepEqual([last(r).status, last(r).error], ["rejected", "element_changed"]);
    assert.deepEqual(posts(), []);
    await stop(v.id);
  });

  await t.test("a submit handler that edits the fields at submit time cannot send different data than approved (body compared at the network)", async () => {
    hits = [];
    const v = await start("payload.html");
    await mutate(() => { location.hash = "#tamper"; });
    const r = await doApproved(v.id, { tool: "click", target: role("button", "Send record") });
    await tick(400);
    assert.deepEqual(posts(), [], "no POST: the body differed from what was approved");
    assert.deepEqual([last(r).status, last(r).error], ["denied", "effect_blocked"]);
    await stop(v.id);
  });

  await t.test("GET forms bind the shown fields too: a field edited at submit time never reaches the server; the honest submission does", async () => {
    hits = [];
    let v = await start("get-form.html");
    await mutate(() => { location.hash = "#tamper"; });
    let r = await doApproved(v.id, { tool: "click", target: role("button", "Search records") });
    await tick(400);
    assert.equal(hits.some((h) => h.path.startsWith("/browser-lab/search")), false, JSON.stringify(hits));
    assert.deepEqual([last(r).status, last(r).error], ["denied", "effect_blocked"]);
    hits = [];
    v = await start("get-form.html");
    r = await doApproved(v.id, { tool: "click", target: role("button", "Search records") });
    await tick(400);
    assert.deepEqual(hits.filter((h) => h.path.startsWith("/browser-lab/search")).map((h) => h.path), ["/browser-lab/search?record=A&q=x"]);
    assert.equal(last(r).status, "done", effect(r));
    await stop(v.id);
  });

  await t.test("everything that is bound must be shown: forms with more fields / longer values than the card can display are not approvable", async () => {
    const v = await start("big-form.html");
    for (const name of ["Send many", "Send long"]) {
      const r = await doApproved(v.id, { tool: "click", target: role("button", name) });
      assert.deepEqual([last(r).status, last(r).error], ["denied", "payload_too_large"], name);
    }
    assert.deepEqual(posts(), []);
    await stop(v.id);
  });

  await t.test("open shadow roots: the REAL inner control is typed into / classified (not its host)", async () => {
    const v = await start("shadow.html");
    let r = await doApproved(v.id, { tool: "type", target: { by: "label", value: "Inner field" }, text: "abc" });
    assert.equal(last(r).status, "done", effect(r));
    const n = r.actions.length;
    await api("POST", `/v1/jobs/${v.id}/actions`, { tool: "click", target: role("button", "Inner go") });
    const w = await until(v.id, (x) => x.pending && x.pending.seq === n + 1, "pending inner");
    assert.equal(w.pending.element.tag, "button"); assert.equal(w.pending.element.text, "Inner go");
    await api("POST", `/v1/jobs/${v.id}/actions/${w.pending.seq}/reject`);
    await stop(v.id);
  });

  await t.test("a redirect from a query-free image to a URL WITH a query is not followed", async () => {
    hits = [];
    const v = await start("pixel-page.html");
    await tick(800);
    assert.equal(hits.some((h) => h.path.startsWith("/browser-lab/api/")), false, JSON.stringify(hits));
    await stop(v.id);
  });

  await t.test("accessible-name tricks: CSS ::before text and aria-labelledby are what the denial rules see", async () => {
    const v = await start("pseudo.html");
    for (const target of [role("button", "ay no"), role("button", "ete accou")]) { // partial names: the caller never types a sensitive word, the accessible name still contains it
      const r = await doApproved(v.id, { tool: "click", target });
      assert.deepEqual([last(r).status, last(r).error], ["denied", "sensitive_action"], JSON.stringify(target));
    }
    await stop(v.id);
  });

  await t.test("isolation: the cloud browser carries no cookies/storage/referrer from anything else, and cookies set by the lab die with the session", async () => {
    hits = [];
    let v = await start("cookies.html");
    assert.match(v.result.excerpt, /cookies=\[\] storage=0/);
    await doApproved(v.id, { tool: "navigate", url: LAB + "page2.html" });
    await stop(v.id);
    assert.equal(hits.every((h) => !h.cookie && !h.referer), true, JSON.stringify(hits));
    v = await start("cookies.html");
    assert.match(v.result.excerpt, /cookies=\[\] storage=0/, "a second session starts empty");
    await stop(v.id);
    assert.equal(hits.some((h) => h.host !== "lab.test"), false, "the app origin / any other host was never contacted");
  });
});
