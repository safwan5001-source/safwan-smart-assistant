// TRUSTED READS (review F1). Facts about the element an action will touch are read from outside the page's reach:
//   * the DOM is read from an ISOLATED world created over CDP (`Page.createIsolatedWorld`): it has its own copies of Element/Node/Document and
//     of every prototype, so a page that redefines `tagName`, `getAttribute`, `href`, `attributes`, `closest`, `innerText`... in its own
//     (main) world changes nothing here. The DOM itself (attributes, structure) is shared and therefore the truth the user also sees;
//   * the accessible NAME and ROLE come from the browser's accessibility tree (`Accessibility.getPartialAXTree`), which already folds in
//     aria-label/aria-labelledby, <img alt>, CSS generated content, ... : the real name a person (or a screen reader) would get;
//   * the element is identified by what the browser HIT-TESTS at the click point (`elementFromPoint`) or has focused (`activeElement`):
//     the thing the user's click/keystroke really reaches, not whatever a locator was believed to resolve to.
// A DOM cannot reveal event listeners, so none of this proves what a click will DO: that limit is enforced by the effect gate (effects.mjs).
const CONTROL = "a[href],button,input,select,textarea,summary,label,[role],[tabindex],[onclick],[contenteditable]";

// Runs with `this` = the element, inside the isolated world. Returns plain values only; never the value of a text field.
function FACTS() {
  const el = this;
  // Anything the deny-rules look at is read in FULL (up to a generous cap) so that a sensitive word cannot hide behind a display-length cut; a value longer than
  // the cap is not silently shortened but flagged (`overlong`), and the target is refused. Only display-only values are cut short.
  let overlong = false;
  const cap = (v, n = 2000) => { const t = String(v ?? "").replace(/\s+/g, " ").trim(); if (t.length > n) overlong = true; return t.slice(0, n); };
  const cut = (v, n = 160) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);   // display only
  const str = (v) => (typeof v === "string" ? v : "");
  const tag = el.localName;
  const form = el.form instanceof HTMLFormElement ? el.form : el.closest("form");
  const type = tag === "input" || tag === "button" ? str(el.type).toLowerCase() : "";
  const buttonLike = tag === "button" || (tag === "input" && ["submit", "image", "button", "reset"].includes(type));
  const isSubmit = (tag === "input" && (type === "submit" || type === "image")) || (tag === "button" && type === "submit" && !!form) || el.hasAttribute("formaction");
  let formAction = "", formTarget = "", formMethod = "";
  if (form || el.hasAttribute("formaction")) {
    try {
      const u = new URL(str(el.getAttribute("formaction")) || str(form && form.getAttribute("action")) || location.href, document.baseURI);
      formAction = u.origin + u.pathname; formTarget = u.href.slice(0, 2048);
    } catch { formAction = "?"; formTarget = "?"; }
    formMethod = cut(el.getAttribute("formmethod") || (form && form.getAttribute("method")) || "get", 10).toLowerCase();
  }
  // What a submit would SEND (urlencoded form data incl. the submitter), as the page's own DOM states it right now: shown to the owner and bound by the gate.
  let formEnctype = "", entries = [], fields = [], formBodyTooLarge = false;
  if (form && isSubmit) {
    formEnctype = cut(el.getAttribute("formenctype") || form.getAttribute("enctype") || "application/x-www-form-urlencoded", 60).toLowerCase();
    try {
      entries = [...new FormData(form, el).entries()].map(([k, v]) => [String(k), typeof v === "string" ? v : "[file:" + cut(v && v.name, 40) + "]"]);
      // Everything that is BOUND must be SHOWN: more fields / longer names or values than the approval card can display are not approvable.
      formBodyTooLarge = JSON.stringify(entries).length > 8000 || entries.length > 12 || entries.some(([k, v]) => k.length > 40 || String(v).length > 60);
      const secret = new Set([...form.elements].filter((c) => c.type === "password").map((c) => c.name));
      fields = entries.slice(0, 12).map(([k, v]) => ({ name: cut(k, 40), value: secret.has(k) ? "••••" : cut(v, 60) }));
    } catch { entries = []; }
  }
  let href = "";
  if (tag === "a") { try { href = new URL(str(el.getAttribute("href")), document.baseURI).href.slice(0, 2048); } catch { href = "?"; } }
  const byId = (ids) => String(ids ?? "").split(/\s+/).filter(Boolean).slice(0, 5).map((i) => { const n = document.getElementById(i); return n ? cap(n.textContent) : ""; }).join(" ");
  const alts = [...el.querySelectorAll("img[alt],svg title,[aria-label]")].slice(0, 5).map((n) => cap(n.getAttribute("alt") || n.getAttribute("aria-label") || n.textContent)).join(" ");
  return {
    tag, type, role: cap(el.getAttribute("role"), 60).toLowerCase(), name: cap(el.getAttribute("name")), id: cap(el.id),
    text: cap(el.textContent), value: buttonLike && tag === "input" ? cap(el.value) : "",
    placeholder: cap(el.getAttribute("placeholder")), ariaLabel: cap(el.getAttribute("aria-label")), title: cap(el.getAttribute("title")),
    labelText: [el.labels ? [...el.labels].map((l) => cap(l.textContent)).join(" ") : "", byId(el.getAttribute("aria-labelledby")), alts].join(" "),
    autocomplete: cap(el.getAttribute("autocomplete")), fieldName: cap(el.getAttribute("name")),
    href, hasDownload: el.hasAttribute("download"), target: cut(el.getAttribute("target"), 20),
    readOnly: el.readOnly === true, contentEditable: el.isContentEditable === true,
    inForm: !!form, formAction: cut(formAction, 160), formTarget, formMethod, isSubmit, formEnctype, formBodyTooLarge, formEntries: formBodyTooLarge ? [] : entries, formFields: fields,
    hasHandler: [...el.attributes].some((a) => /^on/i.test(a.name)),
    hasDisclosureAttr: el.hasAttribute("aria-expanded") || el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-controls"),
    pageUrl: location.origin + location.pathname, overlong,
  };
}

// Sets the value of the classified <input>/<textarea> with the NATIVE setter of the isolated world and fires input/change on that very node.
function FILL(text) {
  const proto = this.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(this, text);
  this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

// Picks the control the user's pointer / focus really lands on (a <label> stands for the control it activates).
// Both descend into OPEN shadow roots (elementFromPoint/activeElement stop at the host) and climb out of them again to find the control.
const PICK_POINT = `(function (x, y) {
  var e = document.elementFromPoint(x, y); if (!e) return null;
  for (var i = 0; i < 8; i++) { var r = e.shadowRoot; if (!r) break; var n = r.elementFromPoint(x, y); if (!n || n === e) break; e = n; }
  function up(n) { for (var i = 0; i < 12 && n; i++) { var c = n.closest(${JSON.stringify(CONTROL)}); if (c) return c; var root = n.getRootNode(); n = root && root.host; } return null; }
  var c = up(e) || e; if (c.localName === "label" && c.control) c = c.control; return c; })`;
const PICK_FOCUS = `(function () {
  var e = document.activeElement; if (!e || e === document.body || e === document.documentElement) return null;
  for (var i = 0; i < 8; i++) { var r = e.shadowRoot; if (!r || !r.activeElement) break; e = r.activeElement; }
  return e; })`;

export function createTrustedReader(context, page) {
  let cdp;
  let counter = 0;
  const session = async () => (cdp ??= await context.newCDPSession(page));

  async function read(pick, args, { keep = false } = {}) {
    const s = await session();
    const { frameTree } = await s.send("Page.getFrameTree");
    // a fresh world per read: execution contexts die with each document, and nothing the page did earlier can have touched this one
    const { executionContextId } = await s.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: `safwan-trusted-${++counter}`, grantUniveralAccess: false });
    const found = await s.send("Runtime.evaluate", { expression: `${pick}(${args.map((a) => JSON.stringify(a)).join(",")})`, contextId: executionContextId, returnByValue: false, timeout: 3000 });
    if (found.exceptionDetails || !found.result?.objectId) return null;
    const objectId = found.result.objectId;
    let released = true;
    try {
      const facts = (await s.send("Runtime.callFunctionOn", { objectId, functionDeclaration: FACTS.toString(), returnByValue: true, silent: true })).result.value;
      let axName = "", axRole = "";
      try {
        const { backendNodeId } = (await s.send("DOM.describeNode", { objectId })).node;
        const ax = (await s.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false })).nodes?.[0];
        const rawAx = String(ax?.name?.value ?? "").replace(/\s+/g, " ").trim();
        if (rawAx.length > 2000) facts.overlong = true;
        axName = rawAx.slice(0, 2000);
        axRole = String(ax?.role?.value ?? "").toLowerCase();
      } catch { /* no AX data: the DOM-derived names still apply */ }
      const out = { ...facts, axName, axRole };
      if (keep) { // the exact DOM node that was classified, for acting on it directly (no re-resolution, no dependence on focus)
        released = false;
        Object.defineProperty(out, "handle", { enumerable: false, value: {
          fill: (text) => s.send("Runtime.callFunctionOn", { objectId, functionDeclaration: FILL.toString(), arguments: [{ value: String(text) }], returnByValue: true, silent: true }).then((r) => r.result?.value === true),
          release: () => s.send("Runtime.releaseObject", { objectId }).catch(() => {}),
        } });
      }
      return out;
    } finally { if (released) s.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  return {
    /** The control under viewport point (x, y): exactly what a click there reaches. `keep` returns a handle to act on that very node. */
    atPoint: (x, y, opts) => read(PICK_POINT, [x, y], opts),
    /** The element that currently has keyboard focus: exactly what typed text goes into. */
    focused: () => read(PICK_FOCUS, []),
  };
}
