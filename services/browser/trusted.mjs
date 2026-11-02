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
  const cut = (v, n = 160) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
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
      formBodyTooLarge = JSON.stringify(entries).length > 8000;
      const secret = new Set([...form.elements].filter((c) => c.type === "password").map((c) => c.name));
      fields = entries.slice(0, 12).map(([k, v]) => ({ name: cut(k, 40), value: secret.has(k) ? "••••" : cut(v, 60) }));
      if (entries.length > 12) fields.push({ name: "…", value: "+" + (entries.length - 12) });
    } catch { entries = []; }
  }
  let href = "";
  if (tag === "a") { try { href = new URL(str(el.getAttribute("href")), document.baseURI).href.slice(0, 2048); } catch { href = "?"; } }
  const byId = (ids) => String(ids ?? "").split(/\s+/).filter(Boolean).slice(0, 5).map((i) => { const n = document.getElementById(i); return n ? cut(n.textContent, 80) : ""; }).join(" ");
  const alts = [...el.querySelectorAll("img[alt],svg title,[aria-label]")].slice(0, 5).map((n) => cut(n.getAttribute("alt") || n.getAttribute("aria-label") || n.textContent, 60)).join(" ");
  return {
    tag, type, role: cut(el.getAttribute("role"), 30).toLowerCase(), name: cut(el.getAttribute("name"), 80), id: cut(el.id, 80),
    text: cut(el.textContent, 120), value: buttonLike && tag === "input" ? cut(el.value, 80) : "",
    placeholder: cut(el.getAttribute("placeholder"), 80), ariaLabel: cut(el.getAttribute("aria-label"), 80), title: cut(el.getAttribute("title"), 80),
    labelText: [el.labels ? [...el.labels].map((l) => cut(l.textContent, 80)).join(" ") : "", byId(el.getAttribute("aria-labelledby")), alts].join(" "),
    autocomplete: cut(el.getAttribute("autocomplete"), 40), fieldName: cut(el.getAttribute("name"), 80),
    href, hasDownload: el.hasAttribute("download"), target: cut(el.getAttribute("target"), 20),
    readOnly: el.readOnly === true, contentEditable: el.isContentEditable === true,
    inForm: !!form, formAction: cut(formAction, 160), formTarget, formMethod, isSubmit, formEnctype, formBodyTooLarge, formEntries: formBodyTooLarge ? [] : entries, formFields: fields,
    hasHandler: [...el.attributes].some((a) => /^on/i.test(a.name)),
    hasDisclosureAttr: el.hasAttribute("aria-expanded") || el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-controls"),
    pageUrl: location.origin + location.pathname,
  };
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

  async function read(pick, args) {
    const s = await session();
    const { frameTree } = await s.send("Page.getFrameTree");
    // a fresh world per read: execution contexts die with each document, and nothing the page did earlier can have touched this one
    const { executionContextId } = await s.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: `safwan-trusted-${++counter}`, grantUniveralAccess: false });
    const found = await s.send("Runtime.evaluate", { expression: `${pick}(${args.map((a) => JSON.stringify(a)).join(",")})`, contextId: executionContextId, returnByValue: false, timeout: 3000 });
    if (found.exceptionDetails || !found.result?.objectId) return null;
    const objectId = found.result.objectId;
    try {
      const facts = (await s.send("Runtime.callFunctionOn", { objectId, functionDeclaration: FACTS.toString(), returnByValue: true, silent: true })).result.value;
      let axName = "", axRole = "";
      try {
        const { backendNodeId } = (await s.send("DOM.describeNode", { objectId })).node;
        const ax = (await s.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false })).nodes?.[0];
        axName = String(ax?.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
        axRole = String(ax?.role?.value ?? "").toLowerCase();
      } catch { /* no AX data: the DOM-derived names still apply */ }
      return { ...facts, axName, axRole };
    } finally { s.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  return {
    /** The control under viewport point (x, y): exactly what a click there reaches. */
    atPoint: (x, y) => read(PICK_POINT, [x, y]),
    /** The element that currently has keyboard focus: exactly what typed text goes into. */
    focused: () => read(PICK_FOCUS, []),
  };
}
