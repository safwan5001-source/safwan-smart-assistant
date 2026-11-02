// iPhone-profile browser scenario for CHAT-AI-1 (driven by scripts/e2e-claude.py). Exits non-zero on the first failed expectation.
const { chromium, devices } = require("playwright");
const WEB = process.env.WEB, CODE = process.env.CODE, SHOTS = process.env.SHOTS || "/tmp";
const ok = (c, m) => { if (!c) { console.error("FAIL", m); process.exitCode = 1; throw new Error(m); } console.log("PASS", m); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "ar-SA", timezoneId: "Asia/Riyadh", baseURL: WEB });
  const page = await ctx.newPage();
  await page.goto("/chat");
  await page.getByLabel("اكتب رسالة").fill("مرحبا يا Claude");
  await page.getByRole("button", { name: "إرسال" }).click();
  // unlock prompt (owner access code, password field, never stored)
  const codeField = page.getByLabel("رمز وصول المالك");
  await codeField.waitFor();
  ok((await codeField.getAttribute("type")) === "password", "unlock code field is a password input");
  await codeField.fill(CODE);
  await page.getByRole("button", { name: "حفظ" }).click();
  // streaming: the bubble grows over time (sample its text)
  const bubble = page.locator(".bubble.streaming");
  const samples = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (await bubble.count()) { const t = (await bubble.innerText()).replace(/\s+/g, " "); if (t) samples.add(t); } else if (samples.size) break;
    await page.waitForTimeout(120);
  }
  ok(samples.size >= 3, `answer appeared incrementally (${samples.size} distinct partial renders)`);
  await page.locator(".bubble.assistant:not(.streaming)").first().waitFor();
  const full = await page.locator(".bubble.assistant:not(.streaming)").first().innerText();
  ok(/أهلاً صفوان/.test(full) && /سياق=1/.test(full), "final answer committed to the chat (context=1 message)");
  await page.screenshot({ path: `${SHOTS}/chat-answer.png` });

  // follow-up: server holds the context
  await page.getByLabel("اكتب رسالة").fill("سؤال ثانٍ");
  await page.getByRole("button", { name: "إرسال" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".bubble.assistant")].some((b) => /سياق=3 تم/.test(b.textContent || "")), null, { timeout: 15000 });
  ok(true, "second turn reached Claude with 3 messages of server-side context");

  // reopen the app: reload keeps the conversation
  await page.reload();
  await page.locator(".bubble", { hasText: "مرحبا يا Claude" }).first().waitFor();
  ok((await page.locator(".bubble.assistant", { hasText: "سياق=3" }).count()) === 1, "conversation is still there after reopening the app");

  // Stop
  await page.getByLabel("اكتب رسالة").fill("اطلب رداً طويلاً");
  await page.getByRole("button", { name: "إرسال" }).click();
  await page.locator(".bubble.streaming", { hasText: "بطيء" }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "إيقاف الرد" }).click();
  await page.locator(".bubble.system", { hasText: "أُوقف الرد" }).waitFor({ timeout: 10000 });
  ok((await page.locator(".bubble.streaming").count()) === 0, "Stop ends the stream and keeps the partial answer");
  ok((await page.locator(".bubble.assistant", { hasText: "بطيء" }).count()) === 1, "partial text was saved as a message");

  // Settings: management UI at iPhone width, no overflow, no secrets
  await page.goto("/settings");
  await page.getByRole("heading", { name: "Claude (Anthropic)" }).waitFor();
  await page.getByLabel("النموذج الافتراضي").waitFor();
  ok(await page.getByLabel("النموذج الافتراضي").inputValue() === "claude-test-small", "default model shown");
  await page.getByLabel("النموذج الافتراضي").selectOption("claude-test-big");
  await page.getByText("تم حفظ النموذج الافتراضي").waitFor();
  await page.getByRole("button", { name: "اختبار الاتصال" }).click();
  await page.getByText("نجح فحص المفتاح والنموذج لدى Anthropic").waitFor({ timeout: 10000 });
  ok(true, "live connection test succeeded against the (fake) Anthropic with the selected model");
  ok((await page.getByRole("progressbar").count()) === 2, "daily and monthly budget meters are shown");
  const html = await page.content();
  ok(!/sk-ant|SERVICE_AUTH|api[_-]?key/i.test(html) && !html.includes(CODE), "no key / secret / access code in the page");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 0, "no horizontal overflow at iPhone width");
  ok((await page.locator("html").getAttribute("dir")) === "rtl", "RTL document");
  await page.screenshot({ path: `${SHOTS}/settings-claude.png`, fullPage: true });

  // phone storage wiped (iOS eviction) -> restore from the server
  await page.evaluate(async () => { localStorage.clear(); });
  await page.reload();
  await page.getByRole("button", { name: "استعادة المحادثات من الخادم" }).click();
  await page.getByText(/استُعيدت \d+ محادثة/).waitFor({ timeout: 10000 });
  await page.goto("/chat");
  await page.locator(".bubble", { hasText: "مرحبا يا Claude" }).first().waitFor();
  ok(true, "conversation restored from the server after local data loss");

  // a second browser context without the cookie cannot use Claude
  const other = await browser.newContext({ baseURL: WEB });
  const r = await other.request.post("/api/assistant/chat", { data: { conversationId: "11111111-1111-4111-8111-111111111111", message: "x" }, headers: { origin: WEB } });
  ok(r.status() === 401, "no cookie -> 401 on /api/assistant/chat");
  const st = await other.request.get("/api/assistant/state");
  ok(st.status() === 401, "no cookie -> 401 on /api/assistant/state");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
