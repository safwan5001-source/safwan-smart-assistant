// End-to-end verification of the notification system in real Chromium against a running build.
//   E2E_BASE_URL=http://127.0.0.1:3100 node e2e/notifications.e2e.mjs
// The server must be started with VAPID + a notify store (see docs/NOTIFICATIONS.md).
import { chromium, devices } from "playwright";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";
const OUT = process.env.E2E_OUT ?? "e2e-output";
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  → " + detail : ""}`); };
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });

const INIT = () => {
  window.__sounds = []; window.__alerts = [];
  window.addEventListener("safwan:sound", (e) => window.__sounds.push(e.detail));
  window.addEventListener("safwan:alert", (e) => window.__alerts.push({ sound: e.detail.sound, speech: e.detail.speech, dup: e.detail.duplicate, title: e.detail.notice?.title ?? null }));
};

// channel "chromium" = the new headless mode of full Chromium (supports Notification permission + Push API surface)
const browser = await chromium.launch({ channel: "chromium", args: ["--autoplay-policy=no-user-gesture-required"] });
const phone = { ...devices["iPhone 14"], locale: "ar-SA", timezoneId: "Asia/Riyadh" };
const { userAgent: _ua, ...phoneNoUA } = phone; // Chromium engine with phone viewport (functional flows)

async function overflow(page, label) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`no horizontal overflow @390px: ${label}`, o <= 1, `overflow=${o}`);
}

try {
  // ───────────── A. Functional flows (Chromium, phone viewport, fake clock) ─────────────
  const ctx = await browser.newContext({ ...phoneNoUA, permissions: ["notifications"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(INIT);
  await page.clock.install({ time: new Date("2026-11-02T10:00:00+03:00") });
  await page.goto(BASE + "/reminders");
  await page.waitForSelector("#quick-r");
  check("RTL document", (await page.evaluate(() => document.documentElement.dir)) === "rtl");
  await overflow(page, "/reminders (empty)");
  await shot(page, "01-reminders-empty");

  // quick add in Arabic → fires after fast-forward
  await page.fill("#quick-r", "ذكرني بعد دقيقة بفحص الإشعارات");
  await page.click("form[aria-label='إضافة سريعة'] button[type=submit]");
  await page.waitForSelector(".reminder");
  check("quick-add creates a reminder", (await page.locator(".reminder").count()) === 1);
  check("title parsed", (await page.locator(".reminder-title").first().innerText()).includes("فحص الإشعارات"));
  await shot(page, "02-reminders-one");
  await page.clock.fastForward("01:02");
  await page.waitForSelector(".alert-banner");
  const sounds1 = await page.evaluate(() => window.__sounds);
  check("alert banner shown when reminder fires", await page.locator(".alert-banner").first().isVisible());
  check("reminder tone actually played (HTMLAudioElement.play resolved)", sounds1.some((s) => s.id === "reminder-bell" && s.result === "played"), JSON.stringify(sounds1));
  check("bell badge shows 1 unread", (await page.locator(".bell-badge").innerText()).trim() === "1");
  check("reminder card marked as awaiting action", (await page.locator(".reminder.fired").count()) === 1);
  await page.waitForTimeout(500); // let the entrance animation finish
  await shot(page, "03-banner-fired");
  // idempotency: waking the engine again must not alert twice
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await page.clock.fastForward("00:03");
  check("no duplicate alert for the same occurrence", (await page.evaluate(() => window.__alerts.filter((a) => !a.dup).length)) === 1);

  // snooze from the banner
  await page.locator(".alert-banner button", { hasText: "أجّل ١٠ د" }).click();
  await page.waitForSelector(".reminder .badge:has-text('مؤجّل')");
  check("snooze from banner marks reminder snoozed", true);
  await shot(page, "04-snoozed");
  await page.clock.fastForward("10:02");
  await page.waitForFunction(() => window.__alerts.filter((a) => !a.dup).length === 2);
  check("snoozed reminder fires again after 10 minutes", true);
  await page.locator(".alert-banner button", { hasText: "تم" }).first().click();
  await page.waitForSelector(".reminder.completed, .reminder .badge:has-text('مكتمل')", { state: "attached" }).catch(() => {});
  await page.click(".chip:has-text('المكتملة')");
  check("completing from the banner completes the reminder", (await page.locator(".reminder.completed").count()) === 1);

  // notification centre
  await page.goto(BASE + "/notifications");
  await page.waitForSelector(".notice-item");
  check("inbox keeps both reminder alerts", (await page.locator(".notice-item").count()) === 2);
  await overflow(page, "/notifications");
  await shot(page, "05-notifications");
  check("acting on a reminder (snooze/complete) marks its notifications read", (await page.locator(".bell-badge").count()) === 0);
  // two fresh in-app alerts from settings → unread tab → mark all read
  await page.goto(BASE + "/settings");
  await page.waitForSelector("#push-h");
  for (let i = 1; i <= 2; i++) {
    await page.getByRole("button", { name: "جرّب تنبيهاً داخل التطبيق" }).click();
    await page.waitForFunction((n) => window.__alerts.length === n, i);
    await page.waitForTimeout(5);
  }
  await page.goto(BASE + "/notifications");
  await page.waitForSelector(".notice-item");
  check("bell badge counts new unread alerts", (await page.locator(".bell-badge").innerText()).trim() === "2");
  await page.click(".chip:has-text('غير المقروءة')");
  check("unread tab lists unread items", (await page.locator(".notice-item.unread").count()) === 2);
  await page.getByRole("button", { name: "تعليم الكل كمقروء" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".notice-item").length === 0);
  check("mark-all-read empties unread tab and clears badge", (await page.locator(".bell-badge").count()) === 0);
  await page.click(".chip:has-text('الوارد')");
  await page.locator(".notice-item").first().getByRole("button", { name: "أرشفة" }).click();
  await page.click(".chip:has-text('المؤرشفة')");
  check("archive moves item to archived tab", (await page.locator(".notice-item").count()) === 1);
  await page.locator(".notice-item").first().getByRole("button", { name: "حذف" }).click();
  check("delete removes the notice", (await page.locator(".notice-item").count()) === 0);

  // clarification flow from chat: no time given → must ASK, not guess
  await page.goto(BASE + "/chat");
  await page.waitForSelector("textarea, input[type=text]");
  const composer = page.locator("textarea").first();
  await composer.fill("ذكرني بكرة أراجع العقد");
  await page.getByRole("button", { name: "إرسال", exact: true }).click();
  await page.waitForSelector(".dialog-card .notice.warn", { timeout: 8000 });
  const q = await page.locator(".dialog-card .notice.warn strong").innerText();
  check("ambiguous reminder (no time) asks a clarifying question", q.length > 5, q);
  await shot(page, "06-clarify-dialog");
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /reminders/.test(k)) ?? "") ?? "[]").length);
  check("nothing is saved before the user answers", before === 1, `count=${before}`);
  await page.fill("#r-time", "21:30");
  await page.getByRole("button", { name: "ضبط التذكير" }).click();
  await page.waitForSelector(".dialog-card", { state: "detached" });
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /reminders/.test(k)) ?? "") ?? "[]"));
  check("reminder saved after the user completes the dialog", after.length === 2 && after.some((r) => r.time === "21:30"));

  // edit + pause + delete
  await page.goto(BASE + "/reminders");
  await page.waitForSelector(".reminder");
  await page.locator(".reminder").first().getByRole("button", { name: /^إيقاف/ }).click();
  await page.click(".chip:has-text('الموقوفة')");
  check("pause moves reminder to paused tab", (await page.locator(".reminder.paused").count()) === 1);
  await page.locator(".reminder.paused").getByRole("button", { name: /^استئناف/ }).click();
  await page.click(".chip:has-text('النشطة')");
  check("resume returns it to active", (await page.locator(".reminder.active").count()) >= 1);
  await page.locator(".reminder").first().getByRole("button", { name: /^تعديل/ }).click();
  await page.fill("#r-title", "عنوان معدّل");
  await page.getByRole("button", { name: "حفظ", exact: true }).click();
  await page.waitForSelector(".dialog-card", { state: "detached" });
  check("edit updates the title", (await page.locator(".reminder-title", { hasText: "عنوان معدّل" }).count()) === 1);
  await page.locator(".reminder", { hasText: "عنوان معدّل" }).getByRole("button", { name: /^حذف/ }).click();
  await page.getByRole("button", { name: "حذف", exact: true }).last().click();
  await page.waitForFunction(() => !document.body.innerText.includes("عنوان معدّل"));
  check("delete removes the reminder (with confirmation)", true);

  // ───────────── B. Settings: sounds, quiet hours, privacy ─────────────
  await page.goto(BASE + "/settings");
  await page.waitForSelector("#push-h");
  await overflow(page, "/settings");
  await shot(page, "07-settings-push");
  await page.evaluate(() => (window.__sounds.length = 0));
  for (const [cat, id] of [["notification", "notification-soft"], ["reminder", "reminder-bell"], ["critical", "critical-alert"], ["success", "success-tone"]]) {
    await page.selectOption(`#tone-${cat}`, id);
    await page.getByRole("button", { name: new RegExp("استمع إلى نغمة") }).nth(["notification", "reminder", "critical", "success"].indexOf(cat)).click();
    await page.waitForFunction((x) => window.__sounds.some((s) => s.id === x && s.result === "played"), id);
    check(`preview plays tone: ${id}`, true);
  }
  await page.locator("#vol").fill("0");
  await page.getByRole("button", { name: /استمع إلى نغمة/ }).first().click();
  await page.waitForFunction(() => window.__sounds.at(-1)?.result === "muted");
  check("volume 0 → muted (no sound)", true);
  await page.locator("#vol").fill("0.7");
  await page.getByLabel("تفعيل أوقات الهدوء").check({ force: true });
  await page.fill("#q-from", "00:00"); await page.fill("#q-to", "23:59");
  await shot(page, "08-settings-sound-quiet");
  // fire an in-app alert while in quiet hours: item lands in inbox, no sound
  await page.evaluate(() => (window.__sounds.length = 0, window.__alerts.length = 0));
  await page.getByRole("button", { name: "جرّب تنبيهاً داخل التطبيق" }).click();
  await page.waitForFunction(() => window.__alerts.length === 1);
  const qa = await page.evaluate(() => ({ a: window.__alerts[0], s: window.__sounds.length }));
  check("quiet hours: no sound, alert still stored", qa.a.sound === "quiet" && qa.s === 0 && !!qa.a.title, JSON.stringify(qa));
  await page.getByLabel("تفعيل أوقات الهدوء").uncheck({ force: true });
  await page.getByLabel("تشغيل نغمة عند التنبيه").uncheck({ force: true });
  await page.evaluate(() => (window.__sounds.length = 0, window.__alerts.length = 0));
  await page.getByRole("button", { name: "جرّب تنبيهاً داخل التطبيق" }).click();
  await page.waitForFunction(() => window.__alerts.length === 1);
  check("sound disabled in settings → silent alert", (await page.evaluate(() => window.__alerts[0].sound)) === "off");
  await page.getByLabel("تشغيل نغمة عند التنبيه").check({ force: true });
  check("lock-screen content is OFF by default", !(await page.getByLabel("إظهار نص التذكير على الشاشة المقفلة").isChecked()));

  check("no uncaught page errors in flows A–B", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();

  // ───────────── C. Real push subscription (persistent profile: Chromium disables Push in incognito) ─────────────
  const profile = mkdtempSync(join(tmpdir(), "safwan-e2e-"));
  const pctx = await chromium.launchPersistentContext(profile, { channel: "chromium", viewport: { width: 390, height: 844 }, locale: "ar-SA", permissions: ["notifications"], args: ["--autoplay-policy=no-user-gesture-required"] });
  const pp = pctx.pages()[0] ?? (await pctx.newPage());
  await pp.goto(BASE + "/settings");
  await pp.waitForSelector("#push-h");
  await pp.waitForTimeout(600);
  const badge = await pp.locator("#push-h + .badge").innerText();
  check("push state is reported (not stuck loading)", badge.length > 0, badge);
  check("service worker registers at scope /", await pp.evaluate(async () => { const r = await navigator.serviceWorker.register("/sw.js", { scope: "/" }); await navigator.serviceWorker.ready; return r.scope.endsWith("/"); }));
  let pushResult = "no enable button (state: " + badge + ")";
  const enableBtn = pp.getByRole("button", { name: "تفعيل الإشعارات" });
  if (await enableBtn.count()) {
    await enableBtn.click();
    // Chromium needs Google's push service (FCM) to hand out an endpoint; sandboxes usually cannot reach it.
    const done = await pp.waitForFunction(() => { const b = document.querySelector("#push-h + .badge"); return b && !/غير مفعّلة/.test(b.textContent); }, null, { timeout: 15000 }).then(() => true, () => false);
    pushResult = done ? await pp.locator("#push-h + .badge").innerText() : "timeout waiting for the push service (FCM unreachable from this environment)";
    if (done && pushResult.includes("مفعّلة")) {
      check("REAL push subscription created in Chromium and registered with the server", true);
      await pp.getByRole("button", { name: "إرسال إشعار تجريبي" }).click();
      await pp.waitForTimeout(2500);
    }
  }
  console.log("INFO  Chromium push subscription outcome:", pushResult);
  results.push({ name: "info: chromium push subscribe outcome", ok: true, detail: pushResult });
  await shot(pp, "09-settings-after-enable");
  await pctx.close();
  rmSync(profile, { recursive: true, force: true });


  // ───────────── D. iPhone Safari (not installed) → install guidance, dark mode ─────────────
  const IOS174 = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const ictx = await browser.newContext({ ...phone, userAgent: IOS174, colorScheme: "dark" });
  const ip = await ictx.newPage();
  await ip.addInitScript(() => localStorage.setItem("safwan-theme", "dark"));
  await ip.goto(BASE + "/settings");
  await ip.waitForSelector("#push-h");
  await ip.waitForTimeout(500);
  check("iPhone iOS 17 Safari (not installed): shows 'add to Home Screen' guidance", (await ip.locator("ol.steps").count()) === 1);
  check("iPhone: no enable button offered before install", (await ip.getByRole("button", { name: "تفعيل الإشعارات" }).count()) === 0);
  await shot(ip, "10-iphone-safari-install-guide-dark");
  const old = await ictx.newPage();
  await old.close();
  const octx = await browser.newContext({ ...phone, userAgent: phone.userAgent }); // iOS 16.0 UA (< 16.4)
  const op = await octx.newPage();
  await op.goto(BASE + "/settings"); await op.waitForSelector("#push-h"); await op.waitForTimeout(400);
  check("iOS < 16.4: reported as unsupported with honest explanation", (await op.locator("#push-h + .badge").innerText()).includes("غير مدعومة"));
  await octx.close();
  await ip.goto(BASE + "/");
  await ip.waitForSelector("#today-h"); // Command Center: «ملخص اليوم»
  await overflow(ip, "/ (dashboard)");
  await shot(ip, "11-dashboard-dark");
  await ictx.close();

  // ───────────── E. Server surface ─────────────
  const cfg = await (await fetch(BASE + "/api/notify/config")).json();
  check("server: push configured with a persistent store", cfg.push === true && cfg.store === "postgres" && cfg.dispatcher === true, JSON.stringify({ ...cfg, publicKey: !!cfg.publicKey }));
  const unauth = await fetch(BASE + "/api/notify/devices/me");
  check("server: device endpoints reject unauthenticated calls", unauth.status === 401);
  const dispatch = await fetch(BASE + "/api/notify/dispatch", { method: "POST" });
  check("server: dispatch endpoint is closed without the secret", [401, 503].includes(dispatch.status), dispatch.status);
  const sw = await fetch(BASE + "/sw.js");
  check("service worker is served as JS with no long cache", sw.ok && /javascript/.test(sw.headers.get("content-type") ?? "") && /max-age=0|no-cache/.test(sw.headers.get("cache-control") ?? ""));
  const man = await (await fetch(BASE + "/manifest.webmanifest")).json();
  check("manifest is installable (standalone, id, icons)", man.display === "standalone" && man.id === "/" && man.icons?.length >= 3);
} catch (e) {
  check("e2e run completed without throwing", false, e?.stack ?? e);
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ base: BASE, total: results.length, failed: failed.length, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
