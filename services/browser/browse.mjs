// One read-only browsing run against an allow-listed page: open a cloud session, navigate, read text, take a bounded JPEG, release.
// All clean-up happens in `finally`, including the "cancelled while the session was still being created" case.
import { chromium } from "playwright-core";
import { abortError } from "./jobs.mjs";
import { cleanText } from "./policy.mjs";
import { runInteractive } from "./interactive.mjs";
import { createEffectGate } from "./effects.mjs";

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
// Runs in EVERY frame before any page script. Closes the channels that neither context.route nor CDP Fetch can see or that race
// (independent review F1/F2): scripted popups, programmatic target=_blank, WebRTC/WebTransport. Defence in depth, not the boundary:
// the real boundary remains a provider-side egress allow-list (docs/CHAT-BROWSER.md).
const HARDEN_PAGE = () => {
  const no = () => null;
  try { Object.defineProperty(window, "open", { value: no, writable: false, configurable: false }); } catch { /* already locked */ }
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]) { try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch { /* ignore */ } }
  const self = (el) => { if (el && el.getAttribute && /^_?(blank|new)/i.test(el.getAttribute("target") || "")) el.setAttribute("target", "_self"); };
  const origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () { self(this); return origSubmit.call(this); };
  for (const type of ["click", "submit", "auxclick"]) document.addEventListener(type, (e) => { const t = e.target; self(t?.closest?.("a,area,form")); }, true);
};

export async function installNetworkGuard(context, page, policy, { onBlock = () => {}, gate = null } = {}) {
  await context.addInitScript(HARDEN_PAGE);
  // A JavaScript dialog would freeze every later Playwright call: answer them all with "cancel" (alert/confirm/prompt/beforeunload).
  page.on("dialog", (d) => { d.dismiss().catch(() => {}); });
  // Nothing may be saved on the (remote) machine. Best effort: not every provider exposes the browser-level target.
  try { await (await context.browser().newBrowserCDPSession()).send("Browser.setDownloadBehavior", { behavior: "deny" }); } catch { /* the network guard still blocks off-list hosts */ }
  // WebSocket handshakes are invisible to route()/Fetch: refuse them all (nothing is forwarded to any server).
  await context.routeWebSocket(/.*/, (ws) => { ws.close({ code: 1008, reason: "blocked" }).catch?.(() => {}); });
  // Backstop: any page other than ours is closed at once.
  context.on("page", (p) => { if (p !== page) p.close().catch(() => {}); });
  await context.route("**/*", (route) => {
    let mine = false;
    try { mine = route.request().frame().page() === page; } catch { /* service worker / detached frame: refuse */ }
    if (mine && policy.allowRequest(route.request().url())) {
      // Interactive sessions: the EFFECT GATE judges method / resource type / navigation from values the browser assigns (effects.mjs).
      const r = route.request();
      if (!gate) return route.continue();
      if (gate.decide({ method: r.method(), type: r.resourceType(), url: r.url(), navigation: r.isNavigationRequest() }).allow) return route.continue();
      // A navigation the gate refuses (script redirect, timer, unapproved form post) becomes "204 No Content": the browser does not navigate, the page
      // stays where it is. (Aborting it would strand the tab on an error page.) Nothing is sent to the network either way.
      onBlock();
      if (r.isNavigationRequest()) return route.fulfill({ status: 204, body: "" });
      return route.abort("blockedbyclient");
    }
    onBlock();
    return route.abort("blockedbyclient");
  });
  const cdp = await context.newCDPSession(page);
  cdp.on("Fetch.requestPaused", async (ev) => {
    try {
      if (ev.responseErrorReason) return await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: ev.responseErrorReason });
      if (gate) { // responses and redirects judged by the gate too: 307/308 replays of a POST, attachments, non-renderable documents
        const headers = Object.fromEntries((ev.responseHeaders ?? []).map((h) => [h.name.toLowerCase(), h.value]));
        if (!gate.responseVerdict({ method: ev.request.method, type: String(ev.resourceType ?? "").toLowerCase(), status: ev.responseStatusCode, headers }).allow) {
          onBlock();
          // an attachment / non-renderable document is replaced by 204: no download, no navigation, no error page. (A redirect cannot be: the browser
          // follows it whatever replaces the 3xx, so it is failed, and the interactive loop returns the tab to the page it came from.)
          if (String(ev.resourceType) === "Document" && !(ev.responseStatusCode >= 300 && ev.responseStatusCode < 400)) return await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 204, responseHeaders: [] });
          return await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" });
        }
      }
      if (ev.responseStatusCode >= 300 && ev.responseStatusCode < 400) {
        const location = header(ev.responseHeaders, "location");
        let next = null;
        try { next = location ? new URL(location, ev.request.url).href : null; } catch { /* unparseable Location: treated as off-list */ }
        if (!next || !policy.allowRequest(next)) { onBlock(); return await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" }); }
      }
      await cdp.send("Fetch.continueResponse", { requestId: ev.requestId });
    } catch {
      await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "Failed" }).catch(() => {}); // fail closed, never leave it open
    }
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });
}

export function createBrowse({ client, projectId, policy, connect = (url) => chromium.connectOverCDP(url, { timeout: 20_000 }), log = console.error }) {
  return async function browse(url, { signal, step, sessionReleased, interactive, sessionSeconds }) {
    let session, browser, creating, gate = null;

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
        projectId, timeoutSeconds: sessionSeconds ?? 120, userMetadata: { purpose: interactive ? "safwan-browser-chat-interactive" : "safwan-browser-chat" },
      })));
      let context, page;
      await stage("connect", "browser_execution_failed", async () => {
        browser = await connect(session.connectUrl);
        if (signal.aborted) { await browser.close().catch(() => {}); throw abortError(); }
        signal.addEventListener("abort", () => { browser.close().catch(() => {}); }, { once: true }); // kills any in-flight CDP call at once
        context = browser.contexts()[0] ?? await browser.newContext();
        page = context.pages()[0] ?? await context.newPage();
        // Installed BEFORE the first navigation. A failure here fails the job: browsing without the guard is never an option.
        gate = interactive ? createEffectGate() : null;
        await installNetworkGuard(context, page, policy, { onBlock: interactive?.blocked, gate });
      });
      await stage("navigate", "navigation_failed", async () => {
        gate?.begin([{ method: "GET", url, query: true }]);       // the start page is the one navigation this window allows
        try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }); } finally { gate?.end(); }
        if (!policy.allowRequest(page.url())) throw code("disallowed_final_url");
      });
      if (interactive) { // the session stays open: one validated action at a time until the user finishes, stops, or a limit is reached
        step("interact", "running");
        const outcome = await runInteractive({ page, context: page.context(), gate, raced, signal, interactive, policy, log });
        step("interact", "done");
        return outcome;
      }
      const text = await stage("read", "browser_execution_failed", async () => ({
        title: cleanText(await page.title(), 200),
        excerpt: cleanText(await page.evaluate(() => String(document.body?.innerText ?? "").slice(0, 6000)), 4000),
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
      // bounded: a hung remote close must not wedge the single slot (the session release below ends the browser anyway)
      try { await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 5000))]); } catch { /* the remote release below ends the session regardless */ }
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
