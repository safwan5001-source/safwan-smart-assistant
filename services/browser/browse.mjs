// One read-only browsing run against an allow-listed page: open a cloud session, navigate, read text, take a bounded JPEG, release.
// All clean-up happens in `finally`, including the "cancelled while the session was still being created" case.
import { chromium } from "playwright-core";
import { abortError } from "./jobs.mjs";
import { cleanText } from "./policy.mjs";

export const MAX_SCREENSHOT_BYTES = 250_000;
const code = (c) => Object.assign(new Error(c), { code: c });
const header = (list, name) => list?.find((h) => h.name.toLowerCase() === name)?.value;

/**
 * Network guard for one page. Two layers, because Playwright alone is NOT enough:
 *  1. context.route  - sees the initial request of every navigation/subresource/frame and aborts anything off the allow-list.
 *     It is NOT called again for redirect hops after route.continue() (verified: a 302 to another host reached the network).
 *  2. CDP Fetch at the RESPONSE stage - every 3xx is paused BEFORE the browser follows it; a Location outside the allow-list is failed
 *     with BlockedByClient, so the redirected request is never sent. If this layer cannot be installed the job fails (never "best effort").
 * Requests from any page other than the main one (popups, new tabs) are refused outright.
 */
export async function installNetworkGuard(context, page, policy) {
  await context.route("**/*", (route) => {
    let mine = false;
    try { mine = route.request().frame().page() === page; } catch { /* service worker / detached frame: refuse */ }
    if (mine && policy.allowRequest(route.request().url())) return route.continue();
    return route.abort("blockedbyclient");
  });
  const cdp = await context.newCDPSession(page);
  cdp.on("Fetch.requestPaused", async (ev) => {
    try {
      if (ev.responseErrorReason) return await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: ev.responseErrorReason });
      if (ev.responseStatusCode >= 300 && ev.responseStatusCode < 400) {
        const location = header(ev.responseHeaders, "location");
        let next = null;
        try { next = location ? new URL(location, ev.request.url).href : null; } catch { /* unparseable Location: treated as off-list */ }
        if (!next || !policy.allowRequest(next)) return await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" });
      }
      await cdp.send("Fetch.continueResponse", { requestId: ev.requestId });
    } catch {
      await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "Failed" }).catch(() => {}); // fail closed, never leave it open
    }
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });
}

export function createBrowse({ client, projectId, policy, connect = (url) => chromium.connectOverCDP(url, { timeout: 20_000 }), log = console.error }) {
  return async function browse(url, { signal, step, sessionReleased }) {
    let session, browser, creating;

    // Settles with `p`, or rejects the moment the job is aborted (the underlying work may still finish; cleanup below deals with it).
    const raced = (p) => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
        (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
      );
    });
    // Run one stage: mark it, translate any failure into a fixed error code (never the raw message: it can contain connect URLs).
    const stage = async (id, failureCode, fn) => {
      step(id, "running");
      try { const v = await raced(fn()); step(id, "done"); return v; }
      catch (e) { if (signal.aborted) throw abortError(); step(id, "failed"); throw e?.code ? e : code(failureCode); }
    };

    try {
      session = await stage("create_session", "browser_execution_failed", () => (creating = client.createSession({
        projectId, timeoutSeconds: 120, userMetadata: { purpose: "safwan-browser-chat" },
      })));
      let context, page;
      await stage("connect", "browser_execution_failed", async () => {
        browser = await connect(session.connectUrl);
        signal.addEventListener("abort", () => { browser.close().catch(() => {}); }, { once: true }); // kills any in-flight CDP call at once
        context = browser.contexts()[0] ?? await browser.newContext();
        page = context.pages()[0] ?? await context.newPage();
        // Installed BEFORE the first navigation. A failure here fails the job: browsing without the guard is never an option.
        await installNetworkGuard(context, page, policy);
      });
      await stage("navigate", "navigation_failed", async () => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        if (!policy.allowRequest(page.url())) throw code("disallowed_final_url");
      });
      const text = await stage("read", "browser_execution_failed", async () => ({
        title: cleanText(await page.title(), 200),
        excerpt: cleanText(await page.locator("body").innerText({ timeout: 5000 }), 4000),
      }));
      // A screenshot can show anything on the page: kept in memory only, never logged or written to disk.
      const screenshot = await stage("screenshot", "browser_execution_failed", async () => {
        const buf = await page.screenshot({ type: "jpeg", quality: 55, timeout: 10_000 });
        if (buf.length > MAX_SCREENSHOT_BYTES) throw code("screenshot_too_large");
        return buf;
      });
      return { title: text.title, url: page.url(), excerpt: text.excerpt, screenshot };
    } finally {
      step("release", "running");
      try { await browser?.close(); } catch { /* the remote release below ends the session regardless */ }
      // Aborted while createSession was in flight: the session will exist shortly and must still be released.
      if (!session && creating) session = await creating.catch(() => undefined);
      let released = !session; // nothing was ever created: nothing to release
      if (session?.id) {
        try { await client.release(session.id); released = true; } catch { log("Browserbase session release failed"); }
      }
      sessionReleased(released);
      step("release", released ? "done" : "failed");
    }
  };
}
