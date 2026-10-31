// A LOCAL stand-in for the Browserbase REST API, used only to test the Smoke-1 harness without any cloud account.
// It validates request shapes against the official API reference and drives a real local Chromium over CDP.
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = (() => { for (const n of ["playwright-core", "playwright"]) { try { return require(n); } catch {} } throw new Error("playwright missing"); })();

export const MOCK_KEY = "mock-key-0000";
export async function startMock({ bearer = true } = {}) {
  const sessions = new Map(); // id -> { browser, status, live: { token, exp } }
  const log = [];
  const sockets = new Set(); // upgraded sockets are not tracked by closeAllConnections()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    log.push(`${req.method} ${url.pathname}`);
    if (url.pathname.startsWith("/live/")) { // the "live view" page
      const token = url.pathname.slice(6);
      const s = [...sessions.values()].find((x) => x.live?.token === token);
      const ok = s && s.status === "RUNNING" && Date.now() < s.live.exp && (bearer || (req.headers.cookie ?? "").includes("app_session="));
      res.writeHead(ok ? 200 : 403, { "content-type": "text/html" }); return res.end(ok ? "<title>Mock live view</title>" : "forbidden");
    }
    if (req.headers["x-bb-api-key"] !== MOCK_KEY) return json(401, { message: "unauthorized" });
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (req.method === "POST" && url.pathname === "/v1/sessions") {
      if (!(body.timeout >= 60 && body.timeout <= 21600) || body.keepAlive !== false || !body.browserSettings?.viewport) return json(400, { message: "bad request" });
      const port = 9300 + Math.floor(Math.random() * 500);
      const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
      const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const id = crypto.randomUUID();
      sessions.set(id, { browser, status: "RUNNING" });
      return json(201, { id, status: "RUNNING", expiresAt: new Date(Date.now() + body.timeout * 1000).toISOString(), connectUrl: ver.webSocketDebuggerUrl, seleniumRemoteUrl: "http://x", signingKey: "mock-signing-key", projectId: "p", region: "us-west-2", keepAlive: false });
    }
    const m = url.pathname.match(/^\/v1\/sessions\/([^/]+)(\/debug)?$/);
    const s = m && sessions.get(m[1]);
    if (!s) return json(404, { message: "not found" });
    if (req.method === "GET" && m[2]) {
      const ttl = Number(url.searchParams.get("expiresIn") ?? 21600);
      if (!(ttl >= 60 && ttl <= 21600)) return json(400, { message: "bad ttl" });
      const token = crypto.randomBytes(16).toString("hex"); s.live = { token, exp: Date.now() + ttl * 1000 };
      const base = `http://${req.headers.host}`;
      return json(200, { debuggerFullscreenUrl: `${base}/live/${token}`, debuggerUrl: `${base}/live/${token}?chrome=1`, wsUrl: `ws://${req.headers.host}/ws/${token}`, pages: [] });
    }
    if (req.method === "POST" && !m[2]) {
      if (JSON.stringify(body) !== JSON.stringify({ status: "REQUEST_RELEASE" })) return json(400, { message: "body must be exactly {status:'REQUEST_RELEASE'}" });
      await s.browser.close().catch(() => {}); s.status = "COMPLETED"; return json(200, { id: m[1], status: "COMPLETED" });
    }
    if (req.method === "GET" && !m[2]) return json(200, { id: m[1], status: s.status });
    return json(405, {});
  });
  server.on("upgrade", (req, socket) => { // minimal RFC 6455 handshake, valid token only
    const token = req.url.slice(4); const s = [...sessions.values()].find((x) => x.live?.token === token);
    if (!s || s.status !== "RUNNING" || Date.now() >= s.live.exp || !bearer) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, log, sessions, async stop() {
      if (process.env.MOCK_DEBUG) console.error("mock.stop: closing browsers");
      for (const s of sessions.values()) await Promise.race([s.browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      if (process.env.MOCK_DEBUG) console.error("mock.stop: closing server");
      for (const sock of sockets) sock.destroy();
      server.closeAllConnections(); await new Promise((r) => server.close(r));
    } };
}
