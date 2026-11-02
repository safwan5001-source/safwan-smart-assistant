// The interactive loop: runs INSIDE browse()'s session (same network guard, same clean-up, same cancellation).
// One action at a time, each of them: validated (actions.mjs) -> element found exactly once, visible, enabled, inside the lab ->
// classified (deny / approve / allow) -> [explicit user approval, element re-verified] -> executed -> page re-observed (text + JPEG).
// The page is untrusted: everything read from it is reduced to bounded primitives, and nothing from it is ever executed or logged.
import { ActionError, classify, fingerprint, describe, isSensitiveWord } from "./actions.mjs";
import { abortError } from "./jobs.mjs";
import { cleanText } from "./policy.mjs";

export const MAX_SCREENSHOT_BYTES = 250_000;

// Runs in the page (main world). Returns primitives only. NOTE: a hostile page could lie to this function; that is why interactive
// control is limited to lab pages the owner controls (docs/CHAT-BROWSER-2.md, "trust boundaries"). It never returns typed values.
const FACTS = (el) => {
  const cut = (v, n = 160) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const str = (v) => (typeof v === "string" ? v : "");
  const tag = el.tagName.toLowerCase();
  const form = el.form instanceof HTMLFormElement ? el.form : el.closest("form");
  const type = tag === "input" || tag === "button" ? str(el.type).toLowerCase() : "";
  const buttonLike = tag === "button" || (tag === "input" && ["submit", "image", "button", "reset"].includes(type));
  const isSubmit = (tag === "input" && (type === "submit" || type === "image")) || (tag === "button" && type === "submit" && !!form) || el.hasAttribute("formaction");
  let formAction = "", formTarget = "";
  // The EFFECTIVE destination: a submitter's own `formaction` overrides the form's `action`. It is what the approval shows and what the fingerprint binds.
  if (form || el.hasAttribute("formaction")) {
    try { const u = new URL(str(el.getAttribute("formaction")) || str(form && form.getAttribute("action")) || location.href, location.href); formAction = u.origin + u.pathname; formTarget = u.href.slice(0, 400); } catch { formAction = "?"; formTarget = "?"; }
  }
  const byId = (ids) => String(ids ?? "").split(/\s+/).filter(Boolean).slice(0, 5).map((i) => { const n = document.getElementById(i); return n ? cut(n.textContent, 80) : ""; }).join(" ");
  const alts = [...el.querySelectorAll("img[alt],svg title,[aria-label]")].slice(0, 5).map((n) => cut(n.getAttribute("alt") || n.getAttribute("aria-label") || n.textContent, 60)).join(" ");
  const labels = [el.labels ? [...el.labels].map((l) => cut(l.textContent, 80)).join(" ") : "", byId(el.getAttribute("aria-labelledby")), alts].join(" ");
  return {
    tag, type, role: cut(el.getAttribute("role"), 30).toLowerCase(), name: cut(el.getAttribute("name"), 80), id: cut(el.id, 80),
    text: cut(el.innerText || el.textContent, 120), value: buttonLike && tag === "input" ? cut(el.value, 80) : "",
    placeholder: cut(el.getAttribute("placeholder"), 80), ariaLabel: cut(el.getAttribute("aria-label"), 80), title: cut(el.getAttribute("title"), 80),
    labelText: labels, autocomplete: cut(el.getAttribute("autocomplete"), 40), fieldName: cut(el.getAttribute("name"), 80),
    href: tag === "a" ? str(el.href) : "", hasDownload: el.hasAttribute("download"),
    readOnly: el.readOnly === true, contentEditable: el.isContentEditable === true,
    inForm: !!form, formAction: cut(formAction, 160), formTarget, isSubmit, formMethod: cut(el.getAttribute("formmethod") || (form && form.getAttribute("method")), 10).toLowerCase(),
    hasHandler: [...el.attributes].some((a) => /^on/i.test(a.name)),
    hasDisclosureAttr: el.hasAttribute("aria-expanded") || el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-controls"),
  };
};

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

/** Finds the element EXACTLY once, checks it is usable, and reads its facts. Throws a fixed-code error otherwise. */
async function verify(page, action, policy, timeout) {
  if (!policy.canInteract(page.url())) throw fail("not_in_lab", "denied"); // look-only pages (example.com) never receive a click or keystroke
  const loc = toLocator(page, action.target);
  const count = await within(loc.count(), timeout);
  if (count === 0) throw fail("element_not_found");
  if (count > 1) throw fail("element_ambiguous");
  const el = loc.first();
  if (!(await el.isVisible({ timeout }))) throw fail("element_hidden");
  if (!(await el.isEnabled({ timeout }))) throw fail("element_disabled");
  const facts = await within(el.evaluate(FACTS, undefined, { timeout }), timeout + 2000);
  return { loc: el, facts };
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

export async function runInteractive({ page, raced, signal, interactive, policy, log = () => {} }) {
  const { limits, mailbox } = interactive;
  const settle = () => raced(new Promise((r) => setTimeout(r, 150)));
  const assertInBounds = () => {
    if (page.isClosed()) throw fatal("browser_execution_failed");
    if (!policy.allowRequest(page.url())) throw fatal("disallowed_final_url"); // fail closed: the whole session ends
  };

  /** Holds the step until the user decides (or the window closes). Resolves true / false / "timeout"; rejects if the job is aborted. */
  const askApproval = (seq, kind, summary, submitsTo, element) => new Promise((resolve, reject) => {
    let done = false;
    const end = (v) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", onAbort); interactive.setPending(null); resolve(v); };
    const onAbort = () => { if (done) return; done = true; clearTimeout(timer); interactive.setPending(null); reject(abortError()); };
    const timer = setTimeout(() => end("timeout"), limits.approvalMs);
    signal.addEventListener("abort", onAbort, { once: true });
    interactive.update(seq, { status: "awaiting_approval" });
    interactive.setPending({ seq, kind, summary, submitsTo, element, expiresAt: Date.now() + limits.approvalMs, resolve: end });
  });

  async function perform(seq, action) {
    const t = limits.actionMs;
    if (action.tool === "observe") return;
    if (action.tool === "navigate") {
      await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: t + 5000 }).catch((e) => { if (signal.aborted) throw e; throw fail("navigation_failed"); });
      await settle();
      return;
    }
    // What the caller asks for is judged before anything is looked up, so a sensitive request is refused the same way whether or not the element exists.
    if (isSensitiveWord(action.target.value)) throw fail("sensitive_action", "denied");
    const first = await verify(page, action, policy, t);
    const verdict = classify(action, first.facts, { allowUrl: (u) => policy.allowRequest(u) });
    if (verdict.decision === "deny") throw fail(verdict.code, "denied");
    // A submit whose effective destination is outside the policy is refused outright: it must never reach the approval panel (or the API's view validation).
    if (verdict.decision === "approve" && first.facts.formAction && !policy.allowRequest(first.facts.formAction)) throw fail("leaves_scope", "denied");
    if (verdict.decision === "approve") {
      // What the owner is asked to approve is the RESOLVED element (not the substring they typed): its real text, tag and role.
      const el = { tag: first.facts.tag, role: first.facts.role || undefined, text: cleanText(first.facts.text || first.facts.value || first.facts.ariaLabel || first.facts.name, 120) };
      const answer = await askApproval(seq, verdict.kind, describe(action), first.facts.formAction || undefined, el);
      if (answer !== true) throw fail(answer === "timeout" ? "approval_timeout" : "approval_rejected", "rejected");
      interactive.update(seq, { status: "running" });               // approved: it is executing now
    }
    // Immediately before acting, look again and compare: the element that is clicked/typed into is the one that was classified (and, if asked, approved).
    const again = await verify(page, action, policy, t);
    const verdict2 = classify(action, again.facts, { allowUrl: (u) => policy.allowRequest(u) });
    if (verdict2.decision === "deny") throw fail(verdict2.code, "denied");
    if (fingerprint(again.facts) !== fingerprint(first.facts)) throw fail("element_changed", "rejected");
    first.loc = again.loc;
    if (action.tool === "click") await first.loc.click({ timeout: t, noWaitAfter: false });
    else await first.loc.fill(action.text, { timeout: t });
    await settle();
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
    interactive.update(seq, outcome);
    if (interactive.job.actions.length >= limits.maxActions) return { endReason: "limit" };
  }
}
