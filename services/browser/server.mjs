import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { chromium } from "playwright-core";
import { createClient } from "../../poc/smoke1/browserbase.mjs";

const port = Number(process.env.PORT || 8080);
const token = process.env.BROWSER_SERVICE_TOKEN;
const apiKey = process.env.BROWSERBASE_API_KEY;
const projectId = process.env.BROWSERBASE_PROJECT_ID;
const allowHosts = (process.env.BROWSER_ALLOWED_HOSTS || "example.com").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const maxBytes = 2048;
let running = false;
if (!token || token.length < 32 || !apiKey || !projectId) {
  console.error("Browser service requires BROWSER_SERVICE_TOKEN (32+ chars), BROWSERBASE_API_KEY, and BROWSERBASE_PROJECT_ID");
  process.exit(1);
}
const client = createClient({ apiKey });
function authorized(header) {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function respond(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(obj));
}
function safeUrl(value) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port || !allowHosts.includes(u.hostname.toLowerCase()))
    throw new Error("URL not allowed");
  return u.href;
}
async function browse(url) {
  let session, browser;
  try {
    session = await client.createSession({ projectId, timeoutSeconds: 120, userMetadata: { purpose: "safwan-browser-v1" } });
    browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 20000 });
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    // Intercept BEFORE the network request. This blocks disallowed redirects,
    // subresources, scripts, and navigation attempts, not just the final URL.
    await context.route("**/*", async route => {
      try {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.protocol === "https:" && !requestUrl.port &&
            allowHosts.includes(requestUrl.hostname.toLowerCase())) {
          return await route.continue();
        }
      } catch {}
      return await route.abort("blockedbyclient");
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    if (!allowHosts.includes(new URL(page.url()).hostname.toLowerCase())) throw new Error("Disallowed final URL");
    return { title: (await page.title()).slice(0, 200), url: page.url() };
  } finally {
    try { await browser?.close(); } catch {}
    try { if (session?.id) await client.release(session.id); } catch { console.error("Browserbase session release failed"); }
  }
}
const server = http.createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") return respond(res, 200, { status: "ok", browser: "configured" });
  if (req.url !== "/v1/navigate" || req.method !== "POST") return respond(res, 404, { error: "not_found" });
  if (!authorized(req.headers.authorization)) return respond(res, 401, { error: "unauthorized" });
  if (running) return respond(res, 429, { error: "busy" });
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") return respond(res, 415, { error: "json_required" });
  let bytes = 0, chunks = [];
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("Request too large");
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof input.url !== "string") throw new Error("Missing URL");
    const target = safeUrl(input.url);
    running = true;
    try { return respond(res, 200, { ok: true, ...(await browse(target)) }); }
    catch { return respond(res, 502, { ok: false, error: "browser_execution_failed" }); }
    finally { running = false; }
  } catch { return respond(res, 400, { error: "invalid_request" }); }
});
server.requestTimeout = 60_000;
server.listen(port, "0.0.0.0", () => console.log("safwan-browser listening"));
