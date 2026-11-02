// Pure rules for interactive browser actions (no I/O, no Playwright): what an action may look like, and what the page element it
// resolves to is allowed to receive. Everything security-relevant that does not need a browser is here so it is unit-testable.
//
//   parseAction(raw)        strict, bounded validation of a caller-supplied action. Locators are STRUCTURED ({by, role, value}); there is no
//                           free-form selector, so no `>>` chains, `xpath=`, `internal:` engines, `css=` or script strings can be injected.
//   classify(action, facts) decides allow / approve / deny for a resolved element. `deny` is final (payments, deletion, sign-in, secrets,
//                           uploads, leaving the lab); `approve` needs an explicit per-step user approval; `allow` is pure navigation/UI state.
import { createHash } from "node:crypto";

export const TOOLS = ["navigate", "click", "type", "observe"];
export const ROLES = ["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "switch", "tab"];
export const LOCATOR_KINDS = ["role", "label", "placeholder", "text"];
export const LIMITS = Object.freeze({
  maxActions: 20, deadlineMs: 300_000, idleMs: 45_000, approvalMs: 60_000, actionMs: 10_000, maxText: 200, maxName: 80,
});

export class ActionError extends Error {
  constructor(code, status = 400) { super(code); this.name = "ActionError"; this.code = code; this.status = status; }
}

// Control, bidi and zero-width characters: never accepted in anything the caller supplies and then shown back or typed into a page.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
const str = (v, min, max) => typeof v === "string" && v.length >= min && v.length <= max && !UNSAFE.test(v);

export function parseLocator(raw) {
  if (!isPlainObject(raw) || !LOCATOR_KINDS.includes(raw.by)) throw new ActionError("invalid_locator");
  const exact = raw.exact === undefined ? false : raw.exact;
  if (typeof exact !== "boolean" || !str(raw.value, 1, LIMITS.maxName) || !raw.value.trim()) throw new ActionError("invalid_locator");
  if (raw.by === "role") {
    if (!onlyKeys(raw, ["by", "role", "value", "exact"]) || !ROLES.includes(raw.role)) throw new ActionError("invalid_locator");
    return { by: "role", role: raw.role, value: raw.value.trim(), exact };
  }
  if (!onlyKeys(raw, ["by", "value", "exact"])) throw new ActionError("invalid_locator");
  return { by: raw.by, value: raw.value.trim(), exact };
}

/** Validates an action coming from the API. `normalizeUrl` is the policy's parseSessionTarget (throws when the URL is not allowed). */
export function parseAction(raw, normalizeUrl) {
  if (!isPlainObject(raw) || !TOOLS.includes(raw.tool)) throw new ActionError("invalid_action");
  switch (raw.tool) {
    case "observe":
      if (!onlyKeys(raw, ["tool"])) throw new ActionError("invalid_action");
      return { tool: "observe" };
    case "navigate": {
      if (!onlyKeys(raw, ["tool", "url"]) || typeof raw.url !== "string") throw new ActionError("invalid_action");
      let url;
      try { url = normalizeUrl(raw.url); } catch { throw new ActionError("url_not_allowed"); }
      return { tool: "navigate", url };
    }
    case "click":
      if (!onlyKeys(raw, ["tool", "target"])) throw new ActionError("invalid_action");
      return { tool: "click", target: parseLocator(raw.target) };
    case "type":
      if (!onlyKeys(raw, ["tool", "target", "text"]) || typeof raw.text !== "string" || raw.text.length > LIMITS.maxText || UNSAFE.test(raw.text)) throw new ActionError("invalid_action");
      return { tool: "type", target: parseLocator(raw.target), text: raw.text };
    default: throw new ActionError("invalid_action");
  }
}

/** A short description that is safe to log and to show: names the tool and the element the CALLER named, never the typed text. */
export function describe(action) {
  const t = action.target;
  const who = t ? (t.by === "role" ? `${t.role} «${t.value}»` : `${t.by} «${t.value}»`) : "";
  switch (action.tool) {
    case "navigate": return `navigate ${action.url}`;
    case "click": return `click ${who}`;
    case "type": return `type ${action.text.length} chars into ${who}`;
    default: return "observe";
  }
}

// ── sensitivity ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Lower-case, strip Arabic diacritics/tatweel, unify alef/ya/ta-marbuta and drop invisible characters, so «الدفع» / «الدَّفْع» / «ادفع» compare alike. */
export function norm(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase()
    .replace(/[ً-ٰٟـ​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();
}
// Payments, deletion, authentication, account creation, secrets. Matched against EVERY name the element has (label, text, value, id, name,
// placeholder, aria-label, title, href) and against what the caller asked for. Hard deny: this phase does not touch real accounts or money.
const DENY_EN = /\b(pay|payment|payments|checkout|purchase|buy|order|delete|remove|erase|destroy|drop|unsubscribe|subscribe|log ?in|login|log ?out|logout|sign ?in|signin|sign ?up|signup|register|password|passwd|passcode|credit|debit|card|cvv|cvc|iban|otp|2fa|pin|transfer|withdraw|donate|account|wallet|bank|ssn)\b/;
const DENY_AR = /(ادفع|دفع|الدفع|ادفعي|شراء|اشتر|اشتري|احذف|حذف|ازاله|ازل|مسح|تسجيل ?(ال)?دخول|تسجيل ?خروج|دخول|خروج|انشاء ?حساب|حساب|سجل ?(الان|حساب)|كلمه ?(ال)?(سر|مرور)|بطاقه|رمز ?(ال)?(تحقق|امان)|تحويل|سحب|اشتراك|اشترك|تبرع|محفظه|بنك|رقم ?(ال)?(حساب|هويه))/;
export const isSensitiveWord = (v) => { const n = norm(String(v ?? "").replace(/([a-z])([A-Z])/g, "$1 $2")).replace(/[_\-./:=&?]+/g, " "); return DENY_EN.test(n) || DENY_AR.test(n); };

const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code|transaction-)/;
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "tel", "url", "number", ""]);

export const luhn = (digits) => {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let d = digits.charCodeAt(i) - 48; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; }
  return sum % 10 === 0;
};
/** Text that looks like a payment card number (13-19 digits, Luhn-valid), however it is grouped. */
export const looksLikeCardNumber = (text) => {
  const compact = String(text).replace(/[\s-]/g, "");
  return /^\d{13,19}$/.test(compact) && luhn(compact);
};

/** Stable identity of a verified element: the approval is for THIS element, and it is checked again right before the action runs. */
export const fingerprint = (facts) => createHash("sha256").update(JSON.stringify([
  facts.tag, facts.type, facts.role, facts.name, facts.text, facts.id, facts.formAction, facts.inForm, facts.isSubmit, facts.href,
])).digest("hex").slice(0, 16);

/**
 * Decision for an element that has ALREADY been found exactly once, visible and enabled.
 * `facts` are plain values read from the page (see FACTS in interactive.mjs). Returns:
 *   { decision: "deny",    code }            never executed, not approvable
 *   { decision: "approve", kind }            held until the user presses «موافقة» for this exact step
 *   { decision: "allow" }                    executed (navigation inside the lab, checkbox/radio, disclosure, typing in a plain text field)
 */
export function classify(action, facts, { allowUrl }) {
  const names = [facts.name, facts.text, facts.value, facts.id, facts.fieldName, facts.placeholder, facts.ariaLabel, facts.title, facts.labelText, facts.href, facts.autocomplete,
    action.target?.value];
  if (facts.type === "file") return { decision: "deny", code: "file_upload_blocked" };
  if (facts.type === "password" || SENSITIVE_AUTOCOMPLETE.test(String(facts.autocomplete ?? "").toLowerCase())) return { decision: "deny", code: "sensitive_field" };
  if (names.some(isSensitiveWord)) return { decision: "deny", code: "sensitive_action" };

  if (action.tool === "type") {
    const editable = facts.tag === "textarea" || (facts.tag === "input" && TEXT_INPUT_TYPES.has(facts.type));
    if (!editable || facts.readOnly || facts.contentEditable) return { decision: "deny", code: "not_editable" };
    if (looksLikeCardNumber(action.text)) return { decision: "deny", code: "sensitive_value" };
    return { decision: "allow" };
  }

  // click
  if (facts.tag === "a") {
    if (facts.hasDownload) return { decision: "deny", code: "download_blocked" };
    if (!facts.href || !allowUrl(facts.href)) return { decision: "deny", code: "leaves_scope" };
    return { decision: "allow" }; // a plain link to a page the policy already permits: just navigation
  }
  if ((facts.tag === "input" && (facts.type === "checkbox" || facts.type === "radio")) || facts.role === "checkbox" || facts.role === "radio" || facts.role === "switch") {
    return facts.isSubmit ? { decision: "approve", kind: "submit" } : { decision: "allow" };
  }
  if (facts.tag === "summary" || (facts.hasDisclosureAttr && !facts.isSubmit)) return { decision: "allow" };
  return { decision: "approve", kind: facts.isSubmit ? "submit" : "button" };
}
