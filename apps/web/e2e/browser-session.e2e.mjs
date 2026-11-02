// FULL-STACK end-to-end proof of CHAT-BROWSER-2 (interactive control) with real processes (nothing mocked except the paid cloud vendor and the internet):
//
//   iPhone-sized Chromium ──▶ next start (BFF, owner cookie) ──HMAC──▶ uvicorn API ──bearer──▶ browser worker ──CDP──▶ Chromium
//                                                                                    (mock Browserbase REST)      (example.com / lab.test ⇒ local HTTPS fixture serving the SHIPPED lab page)
//
//   cd apps/web && pnpm build && node e2e/browser-session.e2e.mjs        (E2E_OUT=dir for screenshots + report.json)
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
  const LABDIR = join(here, "..", "public", "browser-lab");
  const SCOPE = "lab.test/browser-lab/";
  const CANARY = "كناري-تجريبي-7731";
  // ── fixture "internet": example.com / lab.test / evil.test ⇒ one local HTTPS server (throw-away certificate). lab.test serves the REAL lab page files. ──
  const tmp = mkdtempSync(join(tmpdir(), "chat-browser2-e2e-")); cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tmp, "k.pem"), "-out", join(tmp, "c.pem"), "-days", "1", "-subj", "/CN=lab.test", "-addext", "subjectAltName=DNS:example.com,DNS:evil.test,DNS:lab.test"], { stdio: "ignore" });
  const hits = []; const hung = new Set();
  const site = createHttpsServer({ key: readFileSync(join(tmp, "k.pem")), cert: readFileSync(join(tmp, "c.pem")) }, (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    hits.push({ host, method: req.method, path: req.url });
    if (host === "lab.test" && /^\/browser-lab\/(index|page2)\.html$/.test(req.url) && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(LABDIR, req.url.split("/").pop())));
    }
    if (host === "example.com" && req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(`<!doctype html><title>Example Domain</title><body><h1>Example Domain</h1><button type="button">Hello</button>`); }
    res.writeHead(404); res.end("no");
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  cleanups.push(() => { for (const r of hung) r.destroy(); site.closeAllConnections(); site.close(); });
  const sitePort = site.address().port;
  const noProxyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
  const chromiumPath = process.env.PW_CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome");

  const mock = await startMock({ chromium, launchOptions: { executablePath: chromiumPath, env: noProxyEnv, args: [`--host-resolver-rules=MAP example.com 127.0.0.1:${sitePort}, MAP lab.test 127.0.0.1:${sitePort}, MAP evil.test 127.0.0.1:${sitePort}`, "--ignore-certificate-errors", "--no-sandbox"] } });
  const { server: workerServer, manager } = createApp({ token: WORKER_TOKEN, policy: createPolicy(["example.com"], [SCOPE]), projectId: "p", log: () => {}, client: createClient({ apiKey: MOCK_KEY, base: mock.base }) });
  await new Promise((r) => workerServer.listen(0, "127.0.0.1", r));
  const workerPort = workerServer.address().port;
  cleanups.push(async () => { await manager.shutdown(); workerServer.closeAllConnections(); workerServer.close(); await mock.stop(); });

  const apiPort = await freePort();
  const py = process.env.PYTHON ?? join(root, "services", "api", ".venv", "bin", "python");
  const apiEnv = { PATH: process.env.PATH, HOME: process.env.HOME, APP_ENV: "development", SERVICE_NONCE_STORE: "memory", SERVICE_AUTH_SECRET: SERVICE_SECRET,
    BROWSER_SERVICE_TOKEN: WORKER_TOKEN, BROWSER_SERVICE_URL: `http://127.0.0.1:${workerPort}`, BROWSER_CHAT_ENABLED: "1", BROWSER_INTERACTIVE_SCOPES: SCOPE };
  const api = start("api", py, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(apiPort)], { cwd: join(root, "services", "api"), env: apiEnv });
  await waitHttp(`http://127.0.0.1:${apiPort}/health`, "API");

  const webPort = await freePort();
  const WEB = `http://127.0.0.1:${webPort}`;
  const webEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", PORT: String(webPort), BACKEND_URL: `http://127.0.0.1:${apiPort}`,
    SERVICE_AUTH_SECRET: SERVICE_SECRET, BROWSER_CHAT_ACCESS_CODE: CODE, BROWSER_INTERACTIVE_SCOPES: SCOPE, HEALTH_CACHE_MS: "0" };
  const web = start("web", join(here, "..", "node_modules", ".bin", "next"), ["start", "-p", String(webPort), "-H", "127.0.0.1"], { cwd: join(here, ".."), env: webEnv });
  await waitHttp(`${WEB}/api/health`, "web");
  const h = (await (await fetch(`${WEB}/api/health`)).json());
  check("BFF → API signed hop is healthy (real HMAC, nonce, freshness)", h.status === "ok" && h.backend === "ok", JSON.stringify(h));

  // ═════ A. HTTP-level security through the real stack ═════
  const post = (path, body, headers = {}) => fetch(`${WEB}/api/browser/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: WEB, ...headers }, body: JSON.stringify(body) });
  const ID0 = "11111111-1111-4111-8111-111111111111";
  check("anonymous /status shows the feature exists but not where the lab is", await (async () => { const j = await (await fetch(`${WEB}/api/browser/status`)).json(); return j.interactive?.enabled === true && !JSON.stringify(j).includes("lab.test"); })());
  check("starting a session without the owner cookie → 401", (await post("tasks", { mode: "interactive", approved: true })).status === 401);
  const ok = await post("session", { code: CODE });
  const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0];
  const authed = { cookie };
  check("starting a session without explicit approval → 400", (await post("tasks", { mode: "interactive" }, authed)).status === 400);
  check("a start page outside the lab scope → 400, no cloud session", (await post("tasks", { mode: "interactive", approved: true, url: "https://lab.test/other/x.html" }, authed)).status === 400 && mock.sessions.size === 0);
  check("actions/approvals/finish without the cookie → 401", (await post(`tasks/${ID0}/actions`, { tool: "observe" })).status === 401 && (await post(`tasks/${ID0}/actions/1/approve`, {})).status === 401 && (await post(`tasks/${ID0}/finish`, {})).status === 401);
  check("cross-site action / approval attempts → 403", (await post(`tasks/${ID0}/actions`, { tool: "observe" }, { ...authed, origin: "https://evil.test" })).status === 403 && (await post(`tasks/${ID0}/actions/1/approve`, {}, { ...authed, origin: "https://evil.test" })).status === 403);
  for (const bad of [{ tool: "eval", code: "1" }, { tool: "click", target: { by: "css", value: "#a" } }, { tool: "navigate", url: "https://evil.test/" }, { tool: "type", target: { by: "label", value: "x" }, text: "a\nb" }]) {
    check(`malformed / out-of-scope action refused at the BFF: ${JSON.stringify(bad).slice(0, 60)}`, (await post(`tasks/${ID0}/actions`, bad, authed)).status === 400);
  }
  check("approval step numbers are bounded (0, 21 → 404)", (await post(`tasks/${ID0}/actions/0/approve`, {}, authed)).status === 404 && (await post(`tasks/${ID0}/actions/21/approve`, {}, authed)).status === 404);

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
  const card = () => page.locator(".bt-card").last();
  const shot = async (name, pg = page) => { await pg.locator(".bt-card").last().scrollIntoViewIfNeeded().catch(() => {}); await tick(500); return pg.screenshot({ path: join(OUT, name + ".jpg"), type: "jpeg", quality: 70 }); };
  const tallShot = async (name, pg = page) => { const v = pg.viewportSize(); await pg.setViewportSize({ width: v.width, height: 2300 }); await tick(500); await shot(name, pg); await pg.setViewportSize(v); await tick(300); };
  const overflow = async (label, pg = page) => { const o = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); check(`no horizontal overflow @${phone.viewport.width}px: ${label}`, o <= 1, `overflow=${o}`); };
  const say = async (text) => { await page.getByLabel("اكتب رسالة").fill(text); await page.getByRole("button", { name: "إرسال", exact: true }).click(); };
  const sendCmd = async (tool, fields = {}) => {
    await card().getByRole("tab", { name: tool, exact: true }).click();
    if (fields.kind) await card().getByLabel("نوع العنصر").selectOption({ label: fields.kind });
    if (fields.name !== undefined) await card().getByLabel("اسم العنصر").fill(fields.name);
    if (fields.text !== undefined) await card().getByLabel("النص المراد كتابته").fill(fields.text);
    if (fields.url !== undefined) await card().getByLabel("عنوان الصفحة").fill(fields.url);
    await card().getByRole("button", { name: "إرسال الأمر" }).click();
  };
  const logHas = async (text, status) => card().locator(".bt-log li", { hasText: text }).filter({ hasText: status }).first().waitFor({ timeout: 20_000 });
  const excerpt = async () => { await card().locator(".bt-more").evaluate((d) => { d.open = true; }).catch(() => {}); return (await card().locator(".bt-excerpt").innerText().catch(() => "")); };

  await page.goto(`${WEB}/chat`, { waitUntil: "networkidle" });
  check("page is RTL Arabic", (await page.evaluate(() => [document.documentElement.dir, document.documentElement.lang].join())) === "rtl,ar");

  // B1. offer → unlock → explicit start
  await say("/متصفح تفاعلي");
  await card().getByText("جلسة متصفح تفاعلية").waitFor();
  check("the card states the rules and is NOT presented as an AI reply", (await card().innerText()).includes("ليست رد مساعد ذكي") && (await card().innerText()).includes("توافق أنت"));
  await card().getByLabel("رمز المالك").fill(CODE);
  await card().getByRole("button", { name: "فتح", exact: true }).click();
  await card().getByRole("button", { name: "السماح وبدء الجلسة" }).waitFor();
  await shot("01-offer-rules-rtl-iphone");
  check("nothing has run before the explicit start click", mock.sessions.size === 0 && !hits.some((x) => x.host === "lab.test"));
  await card().getByRole("button", { name: "السماح وبدء الجلسة" }).click();
  await card().locator("img.bt-shot").waitFor({ timeout: 60_000 });
  await card().getByRole("tab", { name: "نقر", exact: true }).waitFor();
  await page.waitForFunction(() => { const i = document.querySelector("img.bt-shot"); return i && i.complete && i.naturalWidth > 0; });
  check("the live session shows the lab page as a decoded screenshot + its title", (await card().innerText()).includes("مختبر المتصفح") && (await card().locator("img.bt-shot").evaluate((i) => i.naturalWidth)) > 100);
  check("one real cloud browser session is open", [...mock.sessions.values()].filter((s) => s.status === "RUNNING").length === 1);
  await shot("02-session-live");
  await overflow("live session");

  // B2. typing: from the form, and as a chat command
  await sendCmd("كتابة", { kind: "حقل", name: "الاسم الكامل", text: CANARY });
  await logHas("كتابة", "تم");
  check("typing into a plain field works and the page received the text", (await excerpt()).includes(CANARY));
  check("the typed text is not kept in the composer after sending", (await card().getByLabel("النص المراد كتابته").inputValue()) === "");
  await say('/اكتب "ملاحظة تجريبية" في حقل "ملاحظات"');
  await card().locator(".bt-log li").nth(1).getByText("تم", { exact: true }).waitFor({ timeout: 20_000 });
  check("a chat command «/اكتب …» is routed to the active session and runs", (await excerpt()).includes("ملاحظة تجريبية"));
  check("the action log shows what was done but NOT the typed text", !(await card().locator(".bt-log").innerText()).includes(CANARY) && (await card().locator(".bt-log").innerText()).includes("كتابة"));

  // B3. a checkbox needs no approval; a button does
  await say('/انقر خانة اختيار "أوافق على شروط الاختبار"');
  await card().locator(".bt-log li").nth(2).getByText("تم", { exact: true }).waitFor({ timeout: 20_000 });
  check("a checkbox click ran without any approval prompt", (await card().locator(".bt-approval").count()) === 0);
  await sendCmd("نقر", { kind: "زر", name: "زيادة العداد" });
  await card().locator(".bt-approval").waitFor({ timeout: 20_000 });
  check("a button waits for approval and says what it will do", (await card().locator(".bt-approval").innerText()).includes("زيادة العداد") && (await card().locator(".bt-approval").innerText()).includes("قد يغيّر بيانات"));
  const sh0 = await card().locator("img.bt-shot").getAttribute("src");
  check("while waiting the page is untouched (counter still 0)", /العداد:\s*0/.test(await excerpt()));
  await shot("03-approval-pending");
  await tallShot("03b-approval-pending-tall");
  const ab = await card().getByRole("button", { name: "موافقة", exact: true }).boundingBox();
  const rb = await card().getByRole("button", { name: "رفض", exact: true }).boundingBox();
  check("approve and reject are full-size touch targets (≥44px)", ab.height >= 44 && ab.width >= 44 && rb.height >= 44 && rb.width >= 44, JSON.stringify([ab, rb]));
  check("the composer is locked while a step waits for the owner", await card().getByRole("button", { name: /بانتظار قرارك/ }).isDisabled());
  await card().getByRole("button", { name: "موافقة", exact: true }).click();
  await card().locator(".bt-approval").waitFor({ state: "detached", timeout: 20_000 });
  await card().locator(".bt-log li").nth(3).getByText("تم", { exact: true }).waitFor({ timeout: 20_000 });
  check("after the owner's approval the click ran (counter 1)", /العداد:\s*1/.test(await excerpt()));
  check("the screenshot URL changed (new observation, cache-busted)", (await card().locator("img.bt-shot").getAttribute("src")) !== sh0);

  // B4. form submit: reject, then approve
  await sendCmd("كتابة", { kind: "حقل", name: "عبارة تجريبية", text: "فحص" });
  await logHas("كتابة 3", "تم");
  await sendCmd("نقر", { kind: "زر", name: "إرسال النموذج" });
  await card().locator(".bt-approval").waitFor({ timeout: 20_000 });
  check("a form submit says it sends a form and where", (await card().locator(".bt-approval").innerText()).includes("يرسل نموذجًا") && (await card().locator(".bt-approval").innerText()).includes("https://lab.test/browser-lab/"));
  await card().getByRole("button", { name: "رفض", exact: true }).click();
  await logHas("إرسال النموذج", "لم يُنفَّذ");
  check("rejecting leaves the form unsent", (await excerpt()).includes("لم يُرسَل شيء"));
  await sendCmd("نقر", { kind: "زر", name: "إرسال النموذج" });
  await card().locator(".bt-approval").waitFor({ timeout: 20_000 });
  await card().getByRole("button", { name: "موافقة", exact: true }).click();
  await card().locator(".bt-approval").waitFor({ state: "detached", timeout: 20_000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".bt-excerpt")].at(-1)?.textContent?.includes("تم الإرسال محلياً"), null, { timeout: 20_000 });
  check("approving sends the form (handled locally by the lab page)", (await excerpt()).includes("تم الإرسال محلياً: فحص"));

  // B5. the hard denials and the scope
  await say('/انقر زر "ادفع الآن"');
  await logHas("ادفع الآن", "محظور");
  check("a payment request is denied outright with a clear reason and no approval path", (await card().locator(".bt-approval").count()) === 0 && (await card().locator(".bt-log").innerText()).includes("إجراء محظور"));
  await say('/اكتب "x" في حقل "كلمة المرور"');
  await logHas("كلمة المرور", "محظور");
  await say("/افتح https://evil.test/");
  await page.waitForFunction(() => document.querySelector(".bt-card:last-of-type .bt-error, .bt-card .bt-error")?.textContent?.includes("غير مسموح"), null, { timeout: 15_000 });
  check("navigating outside the lab is refused before it reaches the browser", !hits.some((x) => x.host === "evil.test"));
  await sendCmd("نقر", { kind: "رابط", name: "الصفحة الثانية" });
  await logHas("الصفحة الثانية", "تم");
  check("a link inside the lab is followed without approval", (await excerpt()).includes("وصلتَ إلى الصفحة الثانية"));
  await say("/افتح https://example.com/");
  await logHas("example.com", "تم");
  await say('/انقر زر "Hello"');
  await logHas("Hello", "محظور");
  check("on a look-only page a click is refused (it is for reading)", (await card().locator(".bt-log").innerText()).includes("للقراءة فقط"));
  check("nothing but GET page loads reached the fixture internet; no off-lab host, no POST", hits.every((x) => x.method === "GET" && (x.host === "lab.test" || x.host === "example.com")), JSON.stringify(hits.filter((x) => x.method !== "GET" || !["lab.test", "example.com"].includes(x.host))));
  await tallShot("04-log-after-denials-tall");

  // B6. device storage + secrets
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  const unesc = stored.replace(/\\"/g, '"');
  check("localStorage holds the small reference only: no page text, no screenshot, no code, no cookie", !stored.includes("فحص") && !stored.includes("اختبار التنقل") && !stored.includes(CODE) && !stored.includes("safwan_bc") && !/data:image|\/9j\//.test(stored), stored.slice(0, 200));
  check("the card reference is {url:'',mode,state,taskId}", /"browser":\{"url":"","mode":"interactive","state":"started","taskId":"[0-9a-f-]{36}"\}/.test(unesc), unesc.match(/"browser":\{[^}]*\}/)?.[0]);
  check("the chat history keeps the command lines the owner typed (their own device) but nothing from the page", unesc.includes("ملاحظة تجريبية") && !unesc.includes("وصلتَ إلى الصفحة الثانية"));

  // B7. STOP is real, during an approval wait
  await sendCmd("نقر", { kind: "زر", name: "زيادة العداد" }).catch(() => {});
  await tick(300);
  // after the example.com hop the session is on a look-only page: go back to the lab first
  await say("/افتح https://lab.test/browser-lab/index.html");
  await card().locator(".bt-log li", { hasText: "index.html" }).first().getByText("تم", { exact: true }).waitFor({ timeout: 20_000 });
  await sendCmd("نقر", { kind: "زر", name: "زيادة العداد" });
  await card().locator(".bt-approval").waitFor({ timeout: 20_000 });
  const stopBtn = card().getByRole("button", { name: "إيقاف", exact: true });
  const sb = await stopBtn.boundingBox();
  check("the stop button is a full-size touch target (≥44px) and visible while a step waits", sb.height >= 44 && sb.width >= 44);
  const t0 = Date.now();
  await stopBtn.click();
  await card().getByText("أُوقفت", { exact: true }).first().waitFor({ timeout: 15_000 });
  check("stop finished in seconds, the cloud session is released, the card says so", Date.now() - t0 < 12_000 && [...mock.sessions.values()].at(-1).status === "COMPLETED" && (await card().innerText()).includes("أُنهيت جلسة المتصفح السحابي"));
  check("no approval is left pending after stop, and the worker slot is free", (await card().locator(".bt-approval").count()) === 0 && !manager.isBusy());
  check("the step that was waiting for approval is marked cancelled (it never ran)", (await card().locator(".bt-log li").last().innerText()).includes("أُلغي"));
  await tallShot("05-stopped-tall");
  await overflow("stopped session");

  // B8. a second session: graceful finish; limits visible; reload degrades honestly
  await say("/متصفح تفاعلي");
  await card().getByRole("button", { name: "السماح وبدء الجلسة" }).waitFor();
  await card().getByRole("button", { name: "السماح وبدء الجلسة" }).click();
  await card().getByRole("tab", { name: "قراءة", exact: true }).waitFor({ timeout: 60_000 });
  check("limits are visible: steps counter and remaining time", (await card().locator(".bt-bar").innerText()).includes("0/20") && /\d:\d\d/.test(await card().locator(".bt-bar").innerText()));
  await card().getByRole("tab", { name: "قراءة", exact: true }).click();
  await card().getByRole("button", { name: "إرسال الأمر" }).click();
  await logHas("قراءة الصفحة", "تم");
  await card().getByRole("button", { name: "إنهاء الجلسة" }).click();
  await card().getByText("أنهيتَ الجلسة").waitFor({ timeout: 15_000 });
  check("finishing ends the session gracefully and releases it", [...mock.sessions.values()].at(-1).status === "COMPLETED" && !manager.isBusy());
  check("every session opened by this run was released (no paid browser left running)", [...mock.sessions.values()].every((s) => s.status === "COMPLETED"), JSON.stringify([...mock.sessions.values()].map((s) => s.status)));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".bt-card").first().waitFor();
  check("after reload no page text, image or typed text is re-created from device storage", (await page.locator("img.bt-shot").count()) === 0 && !(await page.locator(".bt-card").first().innerText()).includes(CANARY));

  // B9. touch targets, and the dark theme with the approval panel
  const small = await page.evaluate(() => [...document.querySelectorAll(".bt-card button")].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height < 44).length);
  check("every button on the cards is ≥44px tall", small === 0, `${small} too small`);
  const dark = await browser.newContext({ ...phone, colorScheme: "dark" });
  const dp = await dark.newPage();
  const dErrors = []; dp.on("pageerror", (e) => dErrors.push(String(e)));
  await dp.goto(`${WEB}/chat`, { waitUntil: "networkidle" });
  const dsay = async (t) => { await dp.getByLabel("اكتب رسالة").fill(t); await dp.getByRole("button", { name: "إرسال", exact: true }).click(); };
  await dsay("/متصفح تفاعلي");
  const dc = () => dp.locator(".bt-card").last();
  await dc().getByLabel("رمز المالك").fill(CODE); await dc().getByRole("button", { name: "فتح", exact: true }).click();
  await dc().getByRole("button", { name: "السماح وبدء الجلسة" }).click();
  await dc().getByRole("tab", { name: "نقر", exact: true }).waitFor({ timeout: 60_000 });
  await dc().getByRole("tab", { name: "نقر", exact: true }).click();
  await dc().getByLabel("اسم العنصر").fill("زيادة العداد"); await dc().getByRole("button", { name: "إرسال الأمر" }).click();
  await dc().locator(".bt-approval").waitFor({ timeout: 20_000 });
  await tallShot("06-dark-approval-tall", dp);
  await overflow("dark approval", dp);
  check("dark theme paints the page dark (background luminance)", await dp.evaluate(() => { const c = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number); return (c[0] + c[1] + c[2]) / 3 < 80; }));
  await dc().getByRole("button", { name: "إيقاف", exact: true }).click();
  await dc().getByText("أُوقفت", { exact: true }).first().waitFor({ timeout: 15_000 });
  check("the paid browser session of the dark-theme run was released too", [...mock.sessions.values()].every((s) => s.status === "COMPLETED"));

  // ═════ C. Secrets and typed text never leave where they belong ═════
  const html = await (await fetch(`${WEB}/chat`)).text();
  const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  let leaked = [];
  for (const s of [...new Set(scripts)]) { const js = await (await fetch(WEB + s)).text(); for (const [name, v] of [["owner code", CODE], ["service secret", SERVICE_SECRET], ["worker token", WORKER_TOKEN]]) if (js.includes(v) || html.includes(v)) leaked.push(name); }
  check(`no secret appears in the HTML or any of the ${scripts.length} JS bundles`, leaked.length === 0 && scripts.length > 3, leaked.join(", "));
  check("BROWSER_INTERACTIVE_SCOPES is server-only (not exposed to the client bundle)", !/NEXT_PUBLIC_(BROWSER|SERVICE|BACKEND)/.test(html) && !(await Promise.all([...new Set(scripts)].map(async (s) => (await (await fetch(WEB + s)).text()).includes("lab.test/browser-lab/")))).some(Boolean));
  const logs = api.logOf() + web.logOf();
  check("none of the three secrets appears in the API or web process logs", ![CODE, SERVICE_SECRET, WORKER_TOKEN].some((v) => logs.includes(v)));
  check("the typed text appears in neither the API nor the web process logs", !logs.includes(CANARY) && !logs.includes("ملاحظة تجريبية"));
  check("no page errors in the browser console (light or dark)", errors.length === 0 && dErrors.length === 0, [...errors, ...dErrors].join(" | ").slice(0, 300));
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
