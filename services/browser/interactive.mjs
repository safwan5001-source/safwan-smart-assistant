// The interactive loop: runs INSIDE browse()'s session (same network guard, same clean-up, same cancellation).
// One action at a time, each of them: validated (actions.mjs) -> element found exactly once, visible, enabled, inside the lab ->
// the control the pointer/focus REALLY reaches is read from an isolated world + the accessibility tree (trusted.mjs: the page cannot lie to
// it) -> classified (deny / approve / allow) -> [explicit user approval, target re-read and compared] -> executed inside an EFFECT WINDOW
// (effects.mjs: only what the user approved may reach the network, whatever the page's scripts try) -> page re-observed (text + JPEG).
// The page is untrusted: everything read from it is reduced to bounded primitives, and nothing from it is ever executed or logged.
import { ActionError, classify, fingerprint, describe, isSensitiveWord } from "./actions.mjs";
import { abortError } from "./jobs.mjs";
import { cleanText } from "./policy.mjs";
import { createTrustedReader } from "./trusted.mjs";

export const MAX_SCREENSHOT_BYTES = 250_000;

/** Every page-facing await gets its own wall-clock bound (a hostile page can make a CDP call crawl far past Playwright's per-call timeout). */
const within = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
/** Never hand a long or query-bearing address onward: origin + path, capped. */
const safeUrl = (raw) => { try { const u = new URL(raw); return (u.origin + u.pathname).slice(0, 240); } catch { return ""; } };
const fail = (code, kind = "failed") => Object.assign(new ActionError(code), { kind });
const fatal = (code) => Object.assign(new Error(code), { code, fatal: true });

function toLocator(page, t) {
  switch (t.by) {
    case "role": return page.getByRole(t.role, { name: t.value, exact: t.exact });
    case "label": return page.getByLabel(t.value, { exact: t.exact });
    case "placeholder": return page.getByPlaceholder(t.value, { exact: t.exact });
    default: return page.getByText(t.value, { exact: t.exact });
  }
}


/** Finds the element EXACTLY once and checks it is usable. Facts about it are NOT read here (see readTarget). */
async function verify(page, action, policy, timeout) {
  if (!policy.canInteract(page.url())) throw fail("not_in_lab", "denied"); // look-only pages (example.com) never receive a click or keystroke
  const loc = toLocator(page, action.target);
  const count = await within(loc.count(), timeout);
  if (count === 0) throw fail("element_not_found");
  if (count > 1) throw fail("element_ambiguous");
  const el = loc.first();
  if (!(await el.isVisible({ timeout }))) throw fail("element_hidden");
  if (!(await el.isEnabled({ timeout }))) throw fail("element_disabled");
  return { loc: el };
}

async function observe(page, interactive) {
  const title = cleanText(await within(page.title(), 5000), 200);
  // cut INSIDE the page: a 60 MB document must not be pulled over CDP into this process before being truncated
  const excerpt = cleanText(await within(page.evaluate(() => String(document.body?.innerText ?? "").slice(0, 6000)), 8000), 4000);
  let shot = null;
  for (const quality of [55, 30]) { // a picture is best-effort in a session: a heavy page degrades to text instead of ending the work
    const buf = await page.screenshot({ type: "jpeg", quality, timeout: 8000 });
    if (buf.length <= MAX_SCREENSHOT_BYTES) { shot = buf; break; }
  }
  interactive.observation({ title, url: safeUrl(page.url()), excerpt, screenshot: shot });
}


const toCode = (e) => {
  if (e instanceof ActionError) return e.code;
  return e?.name === "TimeoutError" ? "action_timeout" : "action_failed"; // never the raw Playwright text: it can quote page content
};

/** What the effect gate may let through for this action (nothing, unless the user's action itself implies it). */
export function windowFor(action, facts) {
  if (action.tool === "navigate") return [{ method: "GET", url: action.url, query: true }];
  if (action.tool !== "click") return [];
  if (facts.tag === "a") return [{ method: "GET", url: facts.href, query: true }];
  if (facts.isSubmit) {
    if (facts.formMethod === "dialog") return [];
    const post = facts.formMethod === "post";
    return [{ method: post ? "POST" : "GET", url: facts.formTarget, query: post }];
  }
  return []; // typing, plain buttons, toggles: the approval covers on-page effects only; no network effect is authorised
}

export async function runInteractive({ page, context, gate, raced, signal, interactive, policy, log = () => {} }) {
  const { limits, mailbox } = interactive;
  const trusted = createTrustedReader(context, page);
  let lastGood = page.url();                                       // where to return to after a refused redirect
  const sleep = (ms) => raced(new Promise((r) => setTimeout(r, ms)));
  const settle = async () => { await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {}); await sleep(150); };
  const assertInBounds = () => {
    if (page.isClosed()) throw fatal("browser_execution_failed");
    if (!policy.allowRequest(page.url())) throw fatal("disallowed_final_url"); // fail closed: the whole session ends
  };

  /** Holds the step until the user decides (or the window closes). Resolves true / false / "timeout"; rejects if the job is aborted. */
  const askApproval = (seq, kind, summary, extra) => new Promise((resolve, reject) => {
    let done = false;
    const end = (v) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", onAbort); interactive.setPending(null); resolve(v); };
    const onAbort = () => { if (done) return; done = true; clearTimeout(timer); interactive.setPending(null); reject(abortError()); };
    const timer = setTimeout(() => end("timeout"), limits.approvalMs);
    signal.addEventListener("abort", onAbort, { once: true });
    interactive.update(seq, { status: "awaiting_approval" });
    interactive.setPending({ seq, kind, summary, ...extra, expiresAt: Date.now() + limits.approvalMs, resolve: end });
  });

  /** The control the pointer (click) or keyboard focus (type) really reaches, read where the page cannot forge it. */
  async function readTarget(action, loc, t) {
    if (action.tool === "click") {
      await loc.scrollIntoViewIfNeeded({ timeout: t });
      const b1 = await within(loc.boundingBox(), t), b1x = b1 && { x: b1.x, y: b1.y };
      await sleep(80);
      const b2 = await within(loc.boundingBox(), t);
      if (!b1 || !b2 || Math.abs(b1x.x - b2.x) > 1 || Math.abs(b1x.y - b2.y) > 1) throw fail("element_unstable");
      const point = { x: b2.x + b2.width / 2, y: b2.y + b2.height / 2 };
      const facts = await within(trusted.atPoint(point.x, point.y), 6000);
      if (!facts) throw fail("element_not_found");
      return { facts, point };
    }
    await loc.focus({ timeout: t });
    const facts = await within(trusted.focused(), 6000);
    if (!facts) throw fail("not_editable", "denied");
    return { facts };
  }

  /** Runs `fn` inside an effect window for this action; anything the browser refused meanwhile becomes the action's outcome. */
  async function inWindow(allow, fn) {
    gate.begin(allow);
    let refused;
    try { await fn(); await settle(); } finally { refused = gate.end(); }
    // A refused redirect leaves the tab on the browser's error page: put it back where it was (the refusal is still the action's outcome).
    if (refused.length && page.url().startsWith("chrome-error:") && lastGood) {
      gate.begin([{ method: "GET", url: lastGood, query: true }]);
      try { await page.goto(lastGood, { waitUntil: "domcontentloaded", timeout: 10_000 }); } catch { throw fatal("browser_execution_failed"); } finally { gate.end(); }
    }
    if (refused.includes("download_blocked")) throw fail("download_blocked", "denied");
    if (refused.length) throw fail("effect_blocked", "denied");
  }

  async function perform(seq, action) {
    const t = limits.actionMs;
    if (action.tool === "observe") return;
    if (action.tool === "navigate") {
      await inWindow(windowFor(action), () => page.goto(action.url, { waitUntil: "domcontentloaded", timeout: t + 5000 }).catch((e) => { if (signal.aborted) throw e; throw fail("navigation_failed"); }));
      return;
    }
    // What the caller asks for is judged before anything is looked up, so a sensitive request is refused the same way whether or not the element exists.
    if (isSensitiveWord(action.target.value)) throw fail("sensitive_action", "denied");
    const allowUrl = (u) => policy.allowRequest(u);
    const { loc } = await verify(page, action, policy, t);
    const first = await readTarget(action, loc, t);
    const verdict = classify(action, first.facts, { allowUrl });
    if (verdict.decision === "deny") throw fail(verdict.code, "denied");
    // A submit whose effective destination is outside the policy is refused outright: it must never reach the approval panel.
    if (verdict.decision === "approve" && first.facts.formAction && !policy.allowRequest(first.facts.formAction)) throw fail("leaves_scope", "denied");
    if (verdict.decision === "approve") {
      // What the owner is asked to approve is what the browser says the control IS (accessible name, tag, role), and where it really sends.
      const w = windowFor(action, first.facts)[0];
      const el = { tag: first.facts.tag, role: first.facts.axRole || first.facts.role || undefined, text: cleanText(first.facts.axName || first.facts.text || first.facts.value || first.facts.ariaLabel || first.facts.name, 120) };
      const answer = await askApproval(seq, verdict.kind, describe(action), { element: el, submitsTo: first.facts.formAction || undefined, method: w && w.method !== "GET" ? w.method : undefined });
      if (answer !== true) throw fail(answer === "timeout" ? "approval_timeout" : "approval_rejected", "rejected");
      interactive.update(seq, { status: "running" });               // approved: it is executing now
    }
    // Immediately before acting, read the target again and compare: what is touched is what was classified (and, if asked, approved).
    const again = await readTarget(action, (await verify(page, action, policy, t)).loc, t);
    const verdict2 = classify(action, again.facts, { allowUrl });
    if (verdict2.decision === "deny") throw fail(verdict2.code, "denied");
    if (fingerprint(again.facts) !== fingerprint(first.facts)) throw fail("element_changed", "rejected");
    if (action.tool === "click") await inWindow(windowFor(action, again.facts), () => page.mouse.click(again.point.x, again.point.y)); // exactly the point that was classified
    else await inWindow([], () => loc.fill(action.text, { timeout: t }));
  }

  await observe(page, interactive);
  interactive.ready();

  for (;;) {
    const msg = await mailbox.next({ timeoutMs: limits.idleMs, signal });
    if (msg.type === "idle") return { endReason: "idle" };
    if (msg.type === "close") return { endReason: "finished" };
    const { seq, action } = msg;
    interactive.update(seq, { status: "running" });
    let outcome = { status: "done" };
    try {
      await raced(perform(seq, action));
      assertInBounds();
    } catch (e) {
      if (signal.aborted) throw abortError();
      if (e?.fatal) throw e;
      outcome = { status: e instanceof ActionError && e.kind ? e.kind : "failed", error: toCode(e) };
      if (!(e instanceof ActionError)) log(`interactive action failed tool=${action.tool} code=${toCode(e)}`);
      assertInBounds();
    }
    // The picture and text are refreshed BEFORE the step is reported final, so a client that sees "done" always sees the page as it is now.
    try { await raced(observe(page, interactive)); } catch (e) { if (signal.aborted) throw abortError(); throw fatal("browser_execution_failed"); }
    if (policy.allowRequest(page.url())) lastGood = page.url();
    interactive.update(seq, outcome);
    if (interactive.job.actions.length >= limits.maxActions) return { endReason: "limit" };
  }
}
