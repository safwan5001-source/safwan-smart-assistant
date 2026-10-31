// Smoke-1: one Browser-Mode session end to end (create → load fixture → type Arabic/English → ONE submit → screenshot →
// live-view checks → release). Two modes:
//   node smoke1.mjs                 local Chromium, no network, no keys (validates the harness itself)
//   node smoke1.mjs --cloud         Browserbase; REQUIRES BROWSERBASE_API_KEY and SMOKE1_APPROVED=yes (set by the account owner)
// Safety: the API key is read from the environment only; nothing secret is printed or written; the session has a 300 s timeout
// and keepAlive=false, and is released in a `finally` block even if a step throws. Output goes to ./out (git-ignored).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, isRealApi, mask, redact } from "./browserbase.mjs";
import { formPage } from "../test-site/pages.mjs";

const require = createRequire(import.meta.url);
const pw = (() => { for (const n of ["playwright-core", "playwright"]) { try { return require(n); } catch {} } throw new Error("install playwright-core (npm i) first"); })();
const { chromium } = pw;

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const cloud = args.has("--cloud");
const ttlTest = !args.has("--no-ttl-test");
const holdArg = process.argv.find((a) => a.startsWith("--hold-live="));
const holdSeconds = holdArg ? Math.min(Number(holdArg.split("=")[1]) || 0, 240) : 0;
const base = process.env.BROWSERBASE_API_BASE || "https://api.browserbase.com";
const WALL_CLOCK_MS = 240_000;

if (process.argv.some((a) => /key|token|secret/i.test(a))) { console.error("refusing: credentials must come from the environment, not argv"); process.exit(2); }
if (cloud) {
  if (!process.env.BROWSERBASE_API_KEY) { console.error("--cloud needs BROWSERBASE_API_KEY in the environment"); process.exit(2); }
  if (isRealApi(base) && process.env.SMOKE1_APPROVED !== "yes") {
    console.error("refusing to touch the real Browserbase API: the account owner must approve and set SMOKE1_APPROVED=yes"); process.exit(2);
  }
}

const AR = ["فاتورة رقم ١٢٣٤", "Invoice #123 شركة الأفق", "لا إله إلا الله", "المبلغ: 1,250.75 ر.س / ١٬٢٥٠٫٧٥"];
const steps = [];
const rec = (id, name, ok, detail = {}) => { steps.push({ id, name, ok: ok === null ? null : Boolean(ok), ...detail }); console.log(`${detail.inconclusive ? "INCONCLUSIVE" : ok === null ? "N/A " : ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail.note ? "  — " + detail.note : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = async (fn) => { const t = Date.now(); const v = await fn(); return [v, Date.now() - t]; };

// status: HTTP number, or "error" for a transport failure (timeout, DNS, TLS, reset). A transport failure says NOTHING about
// whether the server would have refused: it is never counted as a denial.
const isDenied = (r) => (typeof r.status === "number" ? r.status !== 200 : null); // true = refused, false = served, null = inconclusive
async function anonymousGet(url) {
  try { const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: {} }); const t = await r.text(); return { status: r.status, title: (t.match(/<title>([^<]{0,80})/i) || [])[1] ?? null, bytes: t.length }; }
  catch { return { status: "error" }; }
}
function anonymousWs(url) {
  return new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
    let ws; try { ws = new WebSocket(url); } catch { return resolve("error"); }
    ws.onopen = () => finish("opened"); ws.onerror = () => finish("rejected"); ws.onclose = () => finish("closed"); setTimeout(() => finish("timeout"), 8000);
  });
}

const started = Date.now();
let freshLive, knownSecrets = [process.env.BROWSERBASE_API_KEY], browser, session, client, projectId = process.env.BROWSERBASE_PROJECT_ID || undefined, localBrowser;
const wall = setTimeout(() => { console.error("wall-clock cap reached; aborting"); process.exitCode = 3; cleanup().finally(() => process.exit(3)); }, WALL_CLOCK_MS);

async function cleanup() {
  try { await browser?.close(); } catch {}
  try { await localBrowser?.close(); } catch {}
  if (client && session?.id) { try { await client.release(session.id); } catch { rec("CLEAN-0", "release request", false, { note: "release call failed; the 300 s timeout is the backstop" }); } }
}

try {
  let connectUrl;
  if (cloud) {
    client = createClient({ apiKey: process.env.BROWSERBASE_API_KEY, base });
    session = await client.createSession({ projectId, timeoutSeconds: 300, userMetadata: { purpose: "smoke1" } });
    knownSecrets.push(session.connectUrl, session.signingKey, session.seleniumRemoteUrl);
    rec("S1-create", "session created (timeout 300 s, keepAlive=false)", session?.id && session.connectUrl, { note: `status=${session.status}; connect ${mask(session.connectUrl)}` });
    connectUrl = session.connectUrl;
    const [b, ms] = await timed(() => chromium.connectOverCDP(connectUrl)); browser = b;
    rec("S1-connect", "Playwright connected over CDP", true, { ms });
  } else {
    localBrowser = await chromium.launch(); browser = localBrowser;
    rec("S1-create", "local Chromium launched (harness validation, no cloud)", true);
  }
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  await page.setContent(formPage());
  rec("S2-load", "fixture form loaded via setContent (no hosting needed)", (await page.title()).includes("Invoice"));

  let exact = true; const bad = [];
  for (const [method, sel] of [["fill", "#supplier"], ["type", "#notes"], ["fill", "#notes"], ["type", "#supplier"]]) {
    for (const s of AR) {
      await page.locator(sel).fill("");
      if (method === "fill") await page.locator(sel).fill(s); else { await page.locator(sel).focus(); await page.keyboard.type(s); }
      const v = await page.locator(sel).inputValue(); if (v !== s) { exact = false; bad.push(`${method}:${sel}`); }
    }
  }
  rec("S3-text", `Arabic/English readback is exact (${AR.length} strings × fill/type × 2 fields)`, exact, { note: bad.slice(0, 2).join(", ") });

  await page.fill("#supplier", AR[1]); await page.fill("#ref", "SMOKE-0001"); await page.fill("#date", "2026-10-31"); await page.fill("#notes", AR[0]);
  await page.click("#submit");
  await page.waitForFunction(() => document.querySelector("[data-testid=submit-count]").textContent !== "0", null, { timeout: 10_000 });
  const c1 = await page.locator("[data-testid=submit-count]").textContent();
  await sleep(3000);
  const c2 = await page.locator("[data-testid=submit-count]").textContent();
  const echo = JSON.parse(await page.locator("[data-testid=echo]").textContent());
  rec("S4-submit-once", "exactly one submission, still one after 3 s", c1 === "1" && c2 === "1", { note: `count=${c1}→${c2}` });
  rec("S4-echo", "submitted payload keeps the Arabic text exactly", echo.supplier === AR[1] && echo.notes === AR[0]);

  fs.mkdirSync(path.join(here, "out"), { recursive: true });
  const shot = path.join(here, "out", `shot-${Date.now()}.png`);
  await page.screenshot({ path: shot });
  rec("S5-shot", "screenshot captured", fs.statSync(shot).size > 1000, { note: `${fs.statSync(shot).size} bytes (kept locally in ./out)` });

  if (cloud) {
    const live = await client.liveUrls(session.id, ttlTest ? 60 : undefined);
    const urls = [live.debuggerFullscreenUrl, live.debuggerUrl, live.wsUrl];
    knownSecrets.push(...urls);
    rec("S6-live-issued", "live-view URLs issued with a 60 s TTL", urls.every(Boolean), { note: `fullscreen ${mask(live.debuggerFullscreenUrl)}` });
    const anon = await anonymousGet(live.debuggerFullscreenUrl);
    rec("S6-anon-http", "live-view page fetched with NO credentials and NO cookies", null, { observed: anon, note: anon.status === "error" ? "inconclusive: transport error, no HTTP answer" : `HTTP ${anon.status} — ${anon.status === 200 ? "BEARER URL: whoever holds it can load it" : "not loadable anonymously"}` });
    const anonWs = await anonymousWs(live.wsUrl);
    rec("S6-anon-ws", "live-view WebSocket opened with NO credentials", null, { observed: anonWs, note: anonWs === "opened" ? "anonymous WS opened (interactive control must be verified manually)" : String(anonWs) });
    if (holdSeconds) { fs.writeFileSync(path.join(here, "out", "live-url.txt"), live.debuggerFullscreenUrl, { mode: 0o600 }); console.log(`holding ${holdSeconds}s: manual check URL written to ./out/live-url.txt (mode 0600, git-ignored)`); await sleep(holdSeconds * 1000); }
    if (ttlTest) {
      await sleep(65_000);
      const after = await anonymousGet(live.debuggerFullscreenUrl); const d = isDenied(after);
      rec("S6-ttl", "live-view URL after its 60 s TTL", d, { observed: after, inconclusive: d === null, note: d === null ? "inconclusive: transport error, no HTTP answer" : `HTTP ${after.status}` });
    }
    // A FRESH, unexpired URL (no expiresIn => valid for the whole session): if it stops working after release, that is revocation,
    // not TTL expiry. It is kept in memory only.
    const fresh = await client.liveUrls(session.id);
    knownSecrets.push(fresh.debuggerFullscreenUrl, fresh.debuggerUrl, fresh.wsUrl);
    freshLive = { url: fresh.debuggerFullscreenUrl, pre: await anonymousGet(fresh.debuggerFullscreenUrl) };
    rec("S6-fresh", "unexpired live-view URL obtained for the post-release revocation check", null, { observed: freshLive.pre, note: `HTTP ${freshLive.pre.status} before release` });
  } else {
    rec("S6-live", "live view not applicable locally", null);
  }
} catch (e) {
  rec("FATAL", "a step threw", false, { note: `${e?.name ?? "Error"}: ${redact(e?.message, knownSecrets).slice(0, 160)}` });
} finally {
  clearTimeout(wall);
  await cleanup();
  if (cloud && session?.id) {
    let status = "?"; for (let i = 0; i < 10; i++) { try { status = (await client.retrieve(session.id)).status; } catch { status = "unknown"; } if (status !== "RUNNING" && status !== "PENDING") break; await sleep(2000); }
    rec("S7-released", "session no longer running after release", ["COMPLETED", "TIMED_OUT"].includes(status), { note: `status=${status}` });
    if (freshLive) {
      const post = await anonymousGet(freshLive.url); const d = isDenied(post);
      if (freshLive.pre.status !== 200) rec("S7-live-dead", "live-view URL revoked by release", null, { observed: { pre: freshLive.pre.status, post: post.status }, inconclusive: freshLive.pre.status === "error", note: "untestable: the URL was not loadable anonymously even before release" });
      else rec("S7-live-dead", "live-view URL revoked by release (URL was unexpired and loadable before)", d, { observed: { pre: 200, post: post.status }, inconclusive: d === null, note: d === null ? "inconclusive: transport error, no HTTP answer" : `HTTP 200 → ${post.status}` });
    }
  }
}

const failed = steps.filter((s) => s.ok === false);
const inconclusive = steps.filter((s) => s.inconclusive);
const verdict = failed.length ? "failed" : inconclusive.length ? "inconclusive" : "passed"; // an outage must never read as a pass
const report = { verdict, when: new Date().toISOString(), mode: cloud ? (isRealApi(base) ? "browserbase" : "mock-api") : "local", durationMs: Date.now() - started, steps };
fs.mkdirSync(path.join(here, "out"), { recursive: true });
const file = path.join(here, "out", `smoke1-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\n${steps.filter((s) => s.ok === true).length} passed, ${failed.length} failed, ${steps.filter((s) => s.ok === null && !s.inconclusive).length} observations, ${inconclusive.length} INCONCLUSIVE (verdict: ${verdict}) — report: ${path.relative(process.cwd(), file)}`);
process.exit(failed.length ? 1 : inconclusive.length ? 4 : 0);
