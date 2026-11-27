// End-to-end check of BASHT HQ in real Chromium against a running build made with NEXT_PUBLIC_HQ_ENABLED=1.
//   NEXT_PUBLIC_HQ_ENABLED=1 pnpm build:web && (cd apps/web && npx next start -p 3100) &
//   E2E_BASE_URL=http://127.0.0.1:3100 node apps/web/e2e/hq.e2e.mjs
// WebGL runs on SwiftShader (software), so fps here says nothing about an iPhone; draw calls and triangles do.
import { chromium, devices } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";
const OUT = process.env.E2E_OUT ?? "e2e-output/hq";
mkdirSync(OUT, { recursive: true });
const BUDGET = { calls: 150, triangles: 400_000 };
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`); };
// PW_CHROMIUM lets a machine with a preinstalled browser (e.g. a cloud runner) reuse it instead of downloading one
const exe = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
const GL = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

const browser = await chromium.launch({ ...exe, args: GL });
const { userAgent: _ua, ...phone } = { ...devices["iPhone 14"], locale: "ar-SA" };
try {
  // A. phone: tabs, page, simulation notice, 3D view, names, panels
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE + "/", { waitUntil: "load" });
  const tabs = await page.locator(".bottom-nav a").allInnerTexts();
  check("bottom bar: الرئيسية · المهام · باشت · المقر · المزيد", JSON.stringify(tabs.map((t) => t.trim())) === JSON.stringify(["الرئيسية", "المهام", "باشت", "المقر", "المزيد"]), tabs.join(" | "));
  check("home shows the HQ entry card", await page.locator("a.hq-entry").count() === 1);
  await page.goto(BASE + "/more", { waitUntil: "load" });
  check("الملفات is reachable from المزيد", await page.locator('a.more-link[href="/files"]').count() === 1);
  await page.locator('a.more-link[href="/files"]').click();
  await page.waitForURL("**/files");
  check("المزيد tab stays active inside الملفات", await page.locator('.bottom-nav a[href="/more"][aria-current="page"]').count() === 1);

  await page.goto(BASE + "/hq?hqdebug=1", { waitUntil: "load" });
  check("simulation notice is visible", await page.getByRole("note").filter({ hasText: "ليست وكلاء فعليين" }).isVisible());
  await page.waitForSelector(".hq-canvas-wrap canvas", { timeout: 60_000 });
  await page.waitForFunction(() => window.__hqStats, null, { timeout: 90_000 });
  const stats = await page.evaluate(() => window.__hqStats);
  check(`draw calls ≤ ${BUDGET.calls}`, stats.calls <= BUDGET.calls, `calls=${stats.calls}`);
  check(`triangles ≤ ${BUDGET.triangles}`, stats.triangles <= BUDGET.triangles, `triangles=${stats.triangles}`);
  const names = await page.locator(".hq-name").evaluateAll((els) => els.filter((e) => getComputedStyle(e).visibility === "visible").map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent, l: r.left, r: r.right, top: r.top, b: r.bottom }; }));
  const clash = names.some((a, i) => names.some((b, j) => j > i && a.l < b.r && a.r > b.l && a.top < b.b && a.b > b.top));
  check("floating names are shown and never overlap", names.length >= 4 && !clash, names.map((n) => n.t).join("، "));
  check("BASHT's name is gold", await page.locator(".hq-name.ceo").evaluate((e) => getComputedStyle(e).color) === "rgb(246, 207, 90)");
  await page.screenshot({ path: `${OUT}/phone-hq.png` });
  await page.getByRole("button", { name: "إخفاء الأسماء" }).click();
  check("names can be hidden", await page.locator(".hq-labels.off").count() === 1);
  await page.getByRole("button", { name: "إظهار الأسماء" }).click();

  // 3D → plan → 3D (switching to the plan must not count as a WebGL failure)
  await page.getByRole("button", { name: "عرض المخطط" }).click();
  await page.waitForSelector(".hq-plan");
  await page.getByRole("button", { name: "عرض ثلاثي الأبعاد" }).click();
  await page.waitForSelector(".hq-canvas-wrap canvas", { timeout: 60_000 });
  check("plan → 3D round trip works", await page.locator(".hq-fallback-note").count() === 0);

  // directory + Arabic-normalised search + card
  await page.locator(".hq-search input").fill("الامن");
  const found = await page.locator(".hq-person strong").allInnerTexts();
  check("search finds حصين for «الامن» (hamza-insensitive)", found.length === 1 && found[0] === "حصين", found.join("، "));
  await page.locator(".hq-person").first().click();
  check("agent card opens", await page.locator("#hq-agent-name").innerText().then((t) => t.includes("حصين")));
  await page.locator(".hq-search input").fill("");

  // simulation end to end (sped up by stepping the page clock is not possible with rAF; wait in real time)
  await page.getByRole("button", { name: "بدء المحاكاة" }).click();
  await page.waitForFunction(() => document.querySelector(".hq-stage-line")?.textContent?.includes("بانتظار اعتمادك"), null, { timeout: 150_000 });
  check("scenario reaches «awaiting approval»", true);
  await page.getByRole("tab", { name: /الموافقات/ }).click();
  await page.getByRole("button", { name: "اعتماد تجريبي" }).click();
  check("trial approval produces a simulated report", await page.locator(".hq-report").isVisible());
  await page.screenshot({ path: `${OUT}/phone-hq-report.png`, fullPage: true });
  // measured against the device width, not innerWidth (which itself grows when a page overflows)
  const ov = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, inner: window.innerWidth }));
  check("no horizontal overflow on the phone", ov.scroll <= 390 && ov.client <= 390 && ov.inner <= 390, JSON.stringify(ov));
  // and no element escapes the screen unless it lives in a horizontal scroller (page clipping must not hide a broken layout)
  const escapes = await page.evaluate(() => [...document.querySelectorAll(".hq-page *")].filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || (r.left >= -1 && r.right <= 391)) return false;
    for (let p = el.parentElement; p && !p.classList.contains("hq-page"); p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return false;
    }
    return !el.closest(".hq-canvas-wrap");
  }).slice(0, 5).map((el) => el.className || el.tagName));
  check("no element escapes the phone screen outside a scroller", escapes.length === 0, escapes.join(" | "));
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();

  // A2. phone landscape: the tab bar must never cover the stage or the view chips
  const land = await browser.newContext({ ...phone, viewport: { width: phone.viewport.height, height: phone.viewport.width } });
  const pl = await land.newPage();
  await pl.goto(BASE + "/hq", { waitUntil: "load" });
  await pl.waitForSelector(".hq-views", { timeout: 60_000 });
  const geo = await pl.evaluate(() => {
    const nav = document.querySelector(".bottom-nav"), vp = document.querySelector(".hq-viewport").getBoundingClientRect();
    const navTop = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().top : Infinity;
    return { vpBottom: Math.round(vp.bottom), navTop, inner: innerHeight };
  });
  check("landscape: stage and chips stay clear of the tab bar", geo.vpBottom <= Math.min(geo.navTop, geo.inner) + 1, JSON.stringify(geo));
  await pl.screenshot({ path: `${OUT}/phone-landscape.png` });
  await land.close();

  // B. no WebGL → 2D plan fallback, still fully usable
  const noGl = await chromium.launch({ ...exe, args: ["--disable-gpu", "--disable-webgl", "--disable-3d-apis"] });
  const p2 = await (await noGl.newContext(phone)).newPage();
  await p2.goto(BASE + "/hq", { waitUntil: "load" });
  await p2.waitForSelector(".hq-plan", { timeout: 20_000 });
  check("without WebGL the 2D plan is shown", await p2.locator(".hq-plan").isVisible());
  await p2.getByRole("button", { name: /مكتب ميزان/ }).click();
  check("plan offices are buttons that open the card", (await p2.locator("#hq-agent-name").innerText()).includes("ميزان"));
  await p2.screenshot({ path: `${OUT}/phone-plan-fallback.png` });
  await noGl.close();
} finally {
  await browser.close();
  writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
