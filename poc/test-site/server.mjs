// Controlled local test site + fixtures for the cloud-computer PoC (Phase 0).
//
// Safety properties (asserted by selftest.mjs):
//  * binds to loopback only; no outbound network calls of any kind
//  * redirects take a fixed KEY (?to=canary), never a caller-supplied URL, so it cannot be an open redirect
//  * by default every probe target is a LOCAL canary listener; real internal addresses (cloud metadata, RFC1918, ...)
//    are only added when started with --internal, which is meant for runs inside a provider's own sandbox
//  * request bodies are never logged; passwords/secrets are never stored
import http from "node:http";
import crypto from "node:crypto";
import {
  html, indexPage, formPage, rtlPage, loginPage, accountPage, downloadsPage, tabsPage, tabPage,
  injectionPage, longPage, probePage, subresourcesPage,
} from "./pages.mjs";

const MAX_BODY = 4096;
const LOG_CAP = 500;

const internalTargets = {
  metadata: "http://169.254.169.254/latest/meta-data/",
  loopback80: "http://127.0.0.1:80/",
  rfc1918_10: "http://10.0.0.1/",
  rfc1918_172: "http://172.16.0.1/",
  rfc1918_192: "http://192.168.0.1/",
  ipv6_loopback: "http://[::1]/",
  ipv4_mapped: "http://[::ffff:169.254.169.254]/",
  decimal_ip: "http://2852039166/", // 169.254.169.254
  hex_ip: "http://0xa9fea9fe/",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const SAMPLE_PDF = Buffer.from(
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

export function createSite({ host = "127.0.0.1", port = 0, canaryPort = 0, internal = false } = {}) {
  const state = { submits: [], logins: 0, canary: [], log: [] };
  let targets = {};
  const note = (arr, entry) => { arr.push(entry); if (arr.length > LOG_CAP) arr.shift(); };

  const canary = http.createServer((req, res) => {
    note(state.canary, { method: req.method, url: req.url, kind: "http" });
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("canary");
  });
  canary.on("upgrade", (req, socket) => {
    note(state.canary, { method: req.method, url: req.url, kind: "upgrade" });
    socket.destroy();
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname;
    note(state.log, { method: req.method, path: p });
    const send = (status, body, type = "text/html; charset=utf-8", extra = {}) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
      res.end(body);
    };
    const json = (status, obj) => send(status, JSON.stringify(obj), "application/json");
    try {
      if (req.method === "GET") {
        if (p === "/") return send(200, indexPage());
        if (p === "/form") return send(200, formPage());
        if (p === "/rtl") return send(200, rtlPage());
        if (p === "/login") return send(200, loginPage());
        if (p === "/account") return send(200, accountPage((req.headers.cookie ?? "").includes("poc_session=ok")));
        if (p === "/downloads") return send(200, downloadsPage());
        if (p === "/tabs") return send(200, tabsPage());
        if (p === "/tabs/a") return send(200, tabPage("a"));
        if (p === "/tabs/b") return send(200, tabPage("b"));
        if (p === "/injection") return send(200, injectionPage(targets.canary));
        if (p === "/probe") return send(200, probePage(targets));
        if (p === "/subresources") return send(200, subresourcesPage(targets));
        const long = p.match(/^\/long\/(\d{1,2})$/);
        if (long) { const n = Number(long[1]); return n >= 1 && n <= 50 ? send(200, longPage(n)) : send(404, "not found", "text/plain"); }
        const red = p.match(/^\/redirect\/(301|302|307|308)$/);
        if (red) {
          const key = url.searchParams.get("to") ?? "";
          if (!Object.hasOwn(targets, key)) return send(400, "unknown target key", "text/plain");
          return send(Number(red[1]), "", "text/plain", { location: targets[key] });
        }
        if (p === "/files/sample.txt") return send(200, "نص تجريبي / sample text\n", "text/plain; charset=utf-8", { "content-disposition": 'attachment; filename="sample.txt"' });
        if (p === "/files/sample.pdf") return send(200, SAMPLE_PDF, "application/pdf", { "content-disposition": 'attachment; filename="sample.pdf"' });
        if (p === "/files/fake.exe") return send(200, "harmless text pretending to be an executable\n", "application/octet-stream", { "content-disposition": 'attachment; filename="fake.exe"' });
        if (p === "/api/stats") return json(200, { submits: state.submits.length, logins: state.logins, canaryHits: state.canary.length });
        if (p === "/api/canary") return json(200, state.canary);
        if (p === "/api/log") return json(200, state.log);
        if (p === "/api/targets") return json(200, targets);
        return send(404, "not found", "text/plain");
      }
      if (req.method === "POST") {
        if (p === "/api/submit") {
          const body = await readBody(req);
          state.submits.push(crypto.createHash("sha256").update(body).digest("hex")); // hash only, never the body
          return json(200, { count: state.submits.length });
        }
        if (p === "/api/login") {
          await readBody(req); // consumed and discarded: the fake password is never stored or logged
          state.logins += 1;
          return send(303, "", "text/plain", { location: "/account", "set-cookie": "poc_session=ok; HttpOnly; SameSite=Lax; Path=/" });
        }
        if (p === "/api/reset") { state.submits.length = 0; state.canary.length = 0; state.log.length = 0; state.logins = 0; return json(200, { ok: true }); }
        return send(404, "not found", "text/plain");
      }
      return send(405, "method not allowed", "text/plain");
    } catch (e) {
      return send(e.status ?? 500, "error", "text/plain");
    }
  });

  return {
    state,
    async start() {
      await new Promise((r) => canary.listen(canaryPort, host, r));
      await new Promise((r) => server.listen(port, host, r));
      const cport = canary.address().port;
      targets = { canary: `http://${host}:${cport}/hit`, ...(internal ? internalTargets : {}) };
      return { host, port: server.address().port, canaryPort: cport, base: `http://${host}:${server.address().port}`, targets };
    },
    addresses() { return { site: server.address(), canary: canary.address() }; },
    async stop() {
      await new Promise((r) => server.close(r));
      await new Promise((r) => canary.close(r));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const internal = process.argv.includes("--internal");
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const site = createSite({ port: portArg ? Number(portArg.split("=")[1]) : 8787, internal });
  const info = await site.start();
  console.log(`test site on ${info.base} (loopback only); canary on :${info.canaryPort}; internal targets: ${internal ? "ON" : "off"}`);
  process.on("SIGINT", async () => { await site.stop(); process.exit(0); });
}
