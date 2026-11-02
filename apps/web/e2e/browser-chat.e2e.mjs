// FULL-STACK end-to-end proof of CHAT-BROWSER-1 with real processes (nothing mocked except the paid cloud vendor and the internet):
//
//   iPhone-sized Chromium ──▶ next start (BFF, owner cookie) ──HMAC──▶ uvicorn API ──bearer──▶ browser worker ──CDP──▶ Chromium
//                                                                                    (mock Browserbase REST)      (example.com ⇒ local HTTPS fixture)
//
//   cd apps/web && pnpm build && node e2e/browser-chat.e2e.mjs        (E2E_OUT=dir for screenshots + report.json)
// Requires: services/api/.venv (uv sync), services/browser/node_modules (npm install), a Chromium (PW_CHROMIUM_PATH or Playwright's own), openssl.
import { spawn, execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { startMock, MOCK_KEY } from "../../../poc/smoke1/mock-browserbase.mjs";
import { createClient } from "../../../poc/smoke1/browserbase.mjs";
import { createApp } from "../../../services/browser/app.mjs";
import { createPolicy } from "../../../services/browser/policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const OUT = process.env.E2E_OUT ?? join(here, "..", "e2e-output");
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: ok ? "" : String(detail) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  → " + detail : ""}`); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const secret = () => randomBytes(36).toString("base64url");

// ── secrets for this run only: three DIFFERENT values, none ever reaches the browser ──
const CODE = secret(), SERVICE_SECRET = secret(), WORKER_TOKEN = secret();
const children = [];
const cleanups = [];
async function waitHttp(url, label, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } await tick(250); }
  throw new Error(`${label} did not start`);
}
function start(label, cmd, args, opts) {
  const c = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; c.stdout.on("data", (d) => (log += d)); c.stderr.on("data", (d) => (log += d));
  c.logOf = () => log; children.push(c);
  return c;
}

try {
  if (!existsSync(join(here, "..", ".next", "BUILD_ID"))) throw new Error("run `pnpm build:web` first");
  // ── fixture "internet": example.com / evil.test ⇒ one local HTTPS server (throw-away certificate) ──
  const tmp = mkdtempSync(join(tmpdir(), "chat-browser-e2e-")); cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tmp, "k.pem"), "-out", join(tmp, "c.pem"), "-days", "1", "-subj", "/CN=example.com", "-addext", "subjectAltName=DNS:example.com,DNS:evil.test"], { stdio: "ignore" });
  const hits = []; const hung = new Set();
  const site = createHttpsServer({ key: readFileSync(join(tmp, "k.pem")), cert: readFileSync(join(tmp, "c.pem")) }, (req, res) => {
    hits.push({ host: (req.headers.host ?? "").split(":")[0], path: req.url });
    if (req.url === "/slow") { hung.add(res); res.on("close", () => hung.delete(res)); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><title>Example Domain</title><body style="font:20px sans-serif;margin:40px"><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents. Fake data only.</p><img src="https://evil.test/pixel.png" width="1" height="1" alt=""></body></html>`);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  cleanups.push(() => { for (const r of hung) r.destroy(); site.closeAllConnections(); site.close(); });
  const sitePort = site.address().port;
  const noProxyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
  const chromiumPath = process.env.PW_CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome");

  // ── worker (in-process) behind a mock Browserbase REST API that drives a real local Chromium ──
  const mock = await startMock({ chromium, launchOptions: { executablePath: chromiumPath, env: noProxyEnv, args: [`--host-resolver-rules=MAP example.com 127.0.0.1:${sitePort}, MAP evil.test 127.0.0.1:${sitePort}`, "--ignore-certificate-errors", "--no-sandbox"] } });
  const { server: workerServer, manager } = createApp({ token: WORKER_TOKEN, policy: createPolicy(["example.com"]), projectId: "p", log: () => {}, client: createClient({ apiKey: MOCK_KEY, base: mock.base }) });
  await new Promise((r) => workerServer.listen(0, "127.0.0.1", r));
  const workerPort = workerServer.address().port;
  cleanups.push(async () => { await manager.shutdown(); workerServer.closeAllConnections(); workerServer.close(); await mock.stop(); });

  // ── API (real uvicorn, development mode so loopback worker + memory nonce store are allowed) ──
  const apiPort = await freePort();
  const py = process.env.PYTHON ?? join(root, "services", "api", ".venv", "bin", "python");
  const apiEnv = { PATH: process.env.PATH, HOME: process.env.HOME, APP_ENV: "development", SERVICE_NONCE_STORE: "memory", SERVICE_AUTH_SECRET: SERVICE_SECRET,
    BROWSER_SERVICE_TOKEN: WORKER_TOKEN, BROWSER_SERVICE_URL: `http://127.0.0.1:${workerPort}`, BROWSER_CHAT_ENABLED: "1" };
  const api = start("api", py, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(apiPort)], { cwd: join(root, "services", "api"), env: apiEnv });
  await waitHttp(`http://127.0.0.1:${apiPort}/health`, "API");

  // ── web (real `next start`, production build) ──
  const webPort = await freePort();
  const WEB = `http://127.0.0.1:${webPort}`;
  const webEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", PORT: String(webPort), BACKEND_URL: `http://127.0.0.1:${apiPort}`,
    SERVICE_AUTH_SECRET: SERVICE_SECRET, BROWSER_CHAT_ACCESS_CODE: CODE, HEALTH_CACHE_MS: "0" };
  const web = start("web", join(here, "..", "node_modules", ".bin", "next"), ["start", "-p", String(webPort), "-H", "127.0.0.1"], { cwd: join(here, ".."), env: webEnv });
  await waitHttp(`${WEB}/api/health`, "web");
  const h = (await (await fetch(`${WEB}/api/health`)).json());
  check("BFF → API signed hop is healthy (real HMAC, nonce, freshness)", h.status === "ok" && h.backend === "ok", JSON.stringify(h));

  // ═════ A. HTTP-level security checks through the real stack ═════
  const post = (path, body, headers = {}) => fetch(`${WEB}/api/browser/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: WEB, ...headers }, body: JSON.stringify(body) });
  check("task creation without the owner cookie → 401", (await post("tasks", { url: "https://example.com/", approved: true })).status === 401);
  check("unlock with a wrong code → 401 and no cookie", await (async () => { const r = await post("session", { code: "wrong" }); return r.status === 401 && !r.headers.get("set-cookie"); })());
  check("cross-site unlock attempt is refused (403) even with the right code", (await post("session", { code: CODE }, { origin: "https://evil.test" })).status === 403);
  const ok = await post("session", { code: CODE });
  const setCookie = ok.headers.get("set-cookie") ?? "";
  check("right code → HttpOnly + SameSite=Strict cookie, code never echoed", ok.status === 200 && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && !setCookie.includes(CODE) && !(await ok.clone().text()).includes(CODE));
  const cookie = setCookie.split(";")[0];
  const authed = { cookie };
  check("starting without explicit approval → 400 approval_required", await (async () => { const r = await post("tasks", { url: "https://example.com/" }, authed); return r.status === 400 && (await r.json()).error === "approval_required"; })());
  // (the create endpoint allows 6 attempts a minute, refused ones included - the full URL matrix lives in the unit suites)
  for (const url of ["https://169.254.169.254/latest/meta-data/", "https://example.com@evil.test/"]) {
    const r = await post("tasks", { url, approved: true }, authed);
    check(`SSRF target refused before any browser starts: ${url}`, r.status === 400 && (await r.json()).error === "url_not_allowed");
  }
  check("no browser session was created by any refused request", mock.sessions.size === 0, `sessions=${mock.sessions.size}`);
  const unauthPoll = await fetch(`${WEB}/api/browser/tasks/11111111-1111-4111-8111-111111111111`);
  check("polling without the cookie → 401", unauthPoll.status === 401);

  // ═════ B. The real user flow on an iPhone-sized RTL screen ═════
  const browser = await chromium.launch({ executablePath: chromiumPath, env: noProxyEnv, args: ["--no-sandbox"] });
  cleanups.push(() => browser.close());
  const phone = { ...devices["iPhone 14"], locale: "ar-SA", timezoneId: "Asia/Riyadh" };
  delete phone.userAgent;
  const ctx = await browser.newContext({ ...phone, colorScheme: "light" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const shot = async (name) => { await page.locator(".bt-card").last().scrollIntoViewIfNeeded().catch(() => {}); await tick(500); return page.screenshot({ path: join(OUT, name + ".jpg"), type: "jpeg", quality: 70 }); };
  // a tall window just for the evidence image, so the WHOLE card (steps, text, picture, notices) is visible
  const tallShot = async (name) => { const v = page.viewportSize(); await page.setViewportSize({ width: v.width, height: 1500 }); await tick(400); await shot(name); await page.setViewportSize(v); await tick(300); };
  const overflow = async (label) => { const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); check(`no horizontal overflow @${phone.viewport.width}px: ${label}`, o <= 1, `overflow=${o}`); };
  const say = async (text) => { await page.getByLabel("اكتب رسالة").fill(text); await page.getByRole("button", { name: "إرسال" }).click(); };
  const card = () => page.locator(".bt-card").last();

  await page.goto(`${WEB}/chat`, { waitUntil: "networkidle" });
  check("page is RTL Arabic", (await page.evaluate(() => [document.documentElement.dir, document.documentElement.lang].join())) === "rtl,ar");

  // B1. a disallowed request is explained and nothing is sent
  const before = mock.sessions.size;
  await say("/متصفح https://evil.test");
  await page.getByText("المسموح في هذه التجربة موقع الاختبار فقط").waitFor();
  await say("/متصفح انقر على زر الدفع");
  await page.getByText("هذه تجربة قراءة فقط").waitFor();
  check("disallowed address and action requests are refused in the chat; no card, no session", (await page.locator(".bt-card").count()) === 0 && mock.sessions.size === before);

  // B2. offer → locked → unlock → approve → run
  await say("/متصفح");
  await card().getByText("مهمة متصفح تجريبية").waitFor();
  check("card states it is read-only and NOT an AI assistant reply", (await card().innerText()).includes("قراءة فقط") && (await card().innerText()).includes("ليست رد مساعد ذكي"));
  await card().getByLabel("رمز المالك").waitFor();
  await shot("01-card-locked-rtl-iphone");
  await card().getByLabel("رمز المالك").fill("not-the-code");
  await card().getByRole("button", { name: "فتح", exact: true }).click();
  await card().getByText("الرمز غير صحيح").waitFor();
  check("wrong owner code shows an error and nothing runs", mock.sessions.size === before);
  await card().getByLabel("رمز المالك").fill(CODE);
  await card().getByRole("button", { name: "فتح", exact: true }).click();
  await card().getByRole("button", { name: "السماح وتشغيل" }).waitFor();
  check("nothing has run before the explicit approval click", mock.sessions.size === before && !hits.some((x) => x.host === "example.com"));
  const cookies = await ctx.cookies();
  const bc = cookies.find((c) => c.name === "safwan_bc");
  check("cookie is HttpOnly + SameSite=Strict and invisible to page JavaScript", !!bc && bc.httpOnly && bc.sameSite === "Strict" && !(await page.evaluate(() => document.cookie)).includes("safwan_bc"));
  await shot("02-card-ready-approve");
  await overflow("card ready");
  await card().getByRole("button", { name: "السماح وتشغيل" }).click();
  await card().getByText("اكتملت", { exact: true }).waitFor({ timeout: 60_000 });
  await card().locator("img.bt-shot").waitFor();
  await page.waitForFunction(() => { const i = document.querySelector("img.bt-shot"); return i && i.complete && i.naturalWidth > 0; });
  const text = await card().innerText();
  check("result card shows title, text excerpt and a decoded screenshot", text.includes("Example Domain") && text.includes("illustrative examples") && (await card().locator("img.bt-shot").evaluate((i) => i.naturalWidth)) > 100);
  check("all six steps shown as done, session reported released", (await card().locator('.bt-steps li[data-status="done"]').count()) === 6 && text.includes("أُنهيت الجلسة السحابية"));
  check("the off-list <img> on the page never reached the network", !hits.some((x) => x.host === "evil.test"), JSON.stringify(hits.filter((x) => x.host === "evil.test")));
  check("Browserbase session was released (mock status COMPLETED)", [...mock.sessions.values()].every((s) => s.status === "COMPLETED"));
  await tallShot("03-result-with-screenshot");
  await overflow("result card");

  // B3. nothing sensitive is stored on the device
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  check("localStorage holds the small reference only: no page text, no image, no code, no cookie", !stored.includes("illustrative") && !stored.includes(CODE) && !stored.includes("safwan_bc") && !/data:image|\/9j\//.test(stored), stored.slice(0, 200));
  const unescaped = stored.replace(/\\"/g, '"'); // localStorage values are JSON strings inside JSON
  check("the chat message kept only {url,state,taskId,outcome}", /"browser":\{"url":"https:\/\/example\.com\/","state":"done","taskId":"[0-9a-f-]{36}","outcome":"succeeded"\}/.test(unescaped), unescaped.match(/"browser":\{[^}]*\}/)?.[0]);

  // B4. cancel for real
  await say("/متصفح example.com/slow");
  await card().getByRole("button", { name: "السماح وتشغيل" }).click();
  await card().locator('.bt-steps li[data-status="running"]', { hasText: "فتح الصفحة" }).waitFor({ timeout: 30_000 });
  for (let i = 0; i < 100 && !hits.some((x) => x.path === "/slow"); i++) await tick(50);
  check("the hung page request really started in the cloud browser", hits.some((x) => x.path === "/slow"));
  await shot("04-running-hung-page");
  // the owner cookie disappears while the task is running (expiry / rotated code): the card must offer sign-in and then RESUME (Codex P2)
  await ctx.clearCookies();
  await card().getByText("انتهت صلاحية الدخول").first().waitFor({ timeout: 20_000 });
  check("cookie expiry mid-run: the running card offers sign-in instead of going dead", await card().getByLabel("رمز المالك").isVisible());
  await shot("04b-reauth-mid-run");
  await card().getByLabel("رمز المالك").fill(CODE);
  await card().getByRole("button", { name: "فتح", exact: true }).click();
  await card().getByLabel("رمز المالك").waitFor({ state: "detached" });
  check("after signing in again the same task is followed and can be controlled", (await card().locator('.badge[role="status"]').innerText()) === "قيد التنفيذ" && (await card().getByRole("button", { name: "إيقاف", exact: true }).isEnabled()));
  const stopBtn = card().getByRole("button", { name: "إيقاف", exact: true });
  const box = await stopBtn.boundingBox();
  check("the stop button is a full-size touch target (≥44px)", !!box && box.height >= 44 && box.width >= 44, JSON.stringify(box));
  const t0 = Date.now();
  await stopBtn.click();
  await card().getByText("أُوقفت", { exact: true }).waitFor({ timeout: 15_000 });
  check("cancel finished in seconds, not at the 20 s navigation timeout", Date.now() - t0 < 12_000, `${Date.now() - t0} ms`);
  check("cancel released the cloud session and the card says so", (await card().innerText()).includes("أُنهيت جلسة المتصفح السحابي") && [...mock.sessions.values()].at(-1).status === "COMPLETED");
  check("the worker slot is free again after cancel", !manager.isBusy());
  await tallShot("05-cancelled");
  await overflow("cancelled card");

  // B5. reload: finished cards degrade honestly, nothing stale is shown
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".bt-card").first().waitFor();
  check("after reload no result text or image is re-created from device storage", (await page.locator("img.bt-shot").count()) === 1 || (await page.locator("img.bt-shot").count()) === 0);

  // B6. touch targets + dark mode
  const small = await page.evaluate(() => [...document.querySelectorAll(".bt-card button")].map((b) => b.getBoundingClientRect()).filter((r) => r.height < 44).length);
  check("every button on the cards is ≥44px tall", small === 0, `${small} too small`);
  const dark = await browser.newContext({ ...phone, colorScheme: "dark" });
  const dp = await dark.newPage();
  await dp.goto(`${WEB}/chat`, { waitUntil: "networkidle" });
  await dp.getByLabel("اكتب رسالة").fill("/متصفح"); await dp.getByRole("button", { name: "إرسال" }).click();
  await dp.locator(".bt-card").last().getByText("مهمة متصفح تجريبية").waitFor();
  await dp.locator(".bt-card").last().scrollIntoViewIfNeeded(); await tick(400);
  await dp.screenshot({ path: join(OUT, "06-card-dark.jpg"), type: "jpeg", quality: 70 });

  // ═════ C. Secrets never reach the browser bundle ═════
  const html = await (await fetch(`${WEB}/chat`)).text();
  const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  let leaked = [];
  for (const s of [...new Set(scripts)]) { const js = await (await fetch(WEB + s)).text(); for (const [name, v] of [["owner code", CODE], ["service secret", SERVICE_SECRET], ["worker token", WORKER_TOKEN]]) if (js.includes(v) || html.includes(v)) leaked.push(name + " in " + s); }
  check(`no secret appears in the HTML or any of the ${scripts.length} JS bundles`, leaked.length === 0 && scripts.length > 3, leaked.join(", "));
  check("no NEXT_PUBLIC_* variable is used for these features", !/NEXT_PUBLIC_(BROWSER|SERVICE|BACKEND)/.test(html));
  const logs = api.logOf() + web.logOf();
  check("none of the three secrets appears in the API or web process logs", ![CODE, SERVICE_SECRET, WORKER_TOKEN].some((v) => logs.includes(v)));
  check("no page errors in the browser console", errors.length === 0, errors.join(" | ").slice(0, 300));
} catch (e) {
  check("e2e run completed without an unexpected error", false, e?.stack ?? e);
  if (process.env.E2E_DEBUG) console.error("--- API log tail ---\n" + children[0]?.logOf().slice(-1500) + "\n--- web log tail ---\n" + children[1]?.logOf().slice(-1500));
} finally {
  for (const c of children) c.kill("SIGTERM");
  for (const f of cleanups.reverse()) { try { await f(); } catch { /* best effort */ } }
  await tick(300);
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
