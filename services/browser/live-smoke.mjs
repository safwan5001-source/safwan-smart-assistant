// Explicit one-shot Railway pre-deploy diagnostic. No HTTP endpoint or public credentials.
import { chromium } from "playwright-core";
import { createClient } from "../../poc/smoke1/browserbase.mjs";

if (process.env.BROWSER_LIVE_SMOKE_APPROVED !== "yes") {
  console.error("Live smoke not approved; refusing to create a session");
  process.exit(2);
}
const { BROWSERBASE_API_KEY: apiKey, BROWSERBASE_PROJECT_ID: projectId } = process.env;
if (!apiKey || !projectId) {
  console.error("Browserbase credentials are not configured");
  process.exit(2);
}
const client = createClient({ apiKey, timeoutMs: 15000 });
let session, browser, releaseOk = false;
const timer = setTimeout(() => { console.error("SMOKE_TIMEOUT"); process.exitCode = 3; }, 90000);
try {
  session = await client.createSession({ projectId, timeoutSeconds: 120, userMetadata: { purpose: "safwan-live-smoke" } });
  browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 15000 });
  const context = browser.contexts()[0] ?? await browser.newContext();
  await context.route("**/*", async route => {
    const u = new URL(route.request().url());
    if (u.protocol === "https:" && u.hostname === "example.com") await route.continue();
    else await route.abort("blockedbyclient");
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
  const title = await page.title();
  const excerpt = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim().slice(0, 4000);
  const shot = await page.screenshot({ type: "jpeg", quality: 55 });
  if (title !== "Example Domain" || !excerpt.includes("Example Domain") ||
      shot.byteLength < 1000 || shot.byteLength > 250000) throw new Error("Read V1 assertions failed");
  console.log("BROWSER_READ_V1_PASS title=Example Domain excerpt_chars=" + excerpt.length + " jpeg_bytes=" + shot.byteLength);
} catch (error) {
  process.exitCode = 1;
  console.error("SMOKE_FAILED " + (error?.name || "error")); // Never log full errors/URLs/secrets
} finally {
  try { await browser?.close(); } catch {}
  if (session?.id) {
    try { await client.release(session.id); releaseOk = true; }
    catch { process.exitCode = 1; }
  }
  console.log(releaseOk ? "SMOKE_RELEASE_REQUESTED" : "SMOKE_RELEASE_NOT_CONFIRMED");
  clearTimeout(timer);
}
