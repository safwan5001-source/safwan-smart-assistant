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

const ROLE_AR = { button: "زر", link: "رابط", textbox: "حقل", searchbox: "حقل بحث", checkbox: "خانة اختيار", radio: "زر اختيار", combobox: "قائمة", switch: "مفتاح", tab: "تبويب" };
/** A short Arabic description that is safe to log and to show: names the tool and the element the CALLER named, never the typed text. */
export function describe(action) {
  const t = action.target;
  const who = !t ? "" : t.by === "role" ? `${ROLE_AR[t.role]} «${t.value}»` : t.by === "label" ? `عنصر بعنوان «${t.value}»` : t.by === "placeholder" ? `حقل نصه الإرشادي «${t.value}»` : `عنصر نصه «${t.value}»`;
  switch (action.tool) {
    case "navigate": return `انتقال إلى ${action.url}`;
    case "click": return `نقر على ${who}`;
    case "type": return `كتابة ${action.text.length} حرفًا في ${who}`;
    default: return "قراءة الصفحة";
  }
}

// ── sensitivity ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Lower-case, strip Arabic diacritics/tatweel, unify alef/ya/ta-marbuta and drop invisible characters, so «الدفع» / «الدَّفْع» / «ادفع» compare alike. */
const CONFUSABLES = { а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ј: "j", ѕ: "s", к: "k", м: "m", н: "h", т: "t", в: "b", ο: "o", α: "a", ν: "v", ρ: "p", ι: "i", κ: "k", τ: "t", Ι: "i", Ο: "o", Α: "a" };
export function norm(value) {
  return String(value ?? "").normalize("NFKC")
    .replace(/\p{Cf}/gu, "")                                 // zero-width, bidi, soft hyphen, joiners: all invisible
    .toLowerCase().replace(/[а-яёa-zα-ω]/gu, (c) => CONFUSABLES[c] ?? c)
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();
}
// Payments, deletion, authentication, account creation, secrets. Matched against EVERY name the element has (label, text, value, id, name,
// placeholder, aria-label, title, href) and against what the caller asked for. Hard deny: this phase does not touch real accounts or money.
const DENY_EN = /\b(pay|pays|paid|paying|payment|payments|checkout|purchase[sd]?|purchasing|buy|buys|buying|bought|order|orders|delete[sd]?|deleting|remove[sd]?|removing|erase[sd]?|destroy|drop|unsubscribe|subscribe|subscription|log ?in|login|log ?out|logout|sign ?in|signin|sign ?out|signout|sign ?up|signup|register|password|passwd|passcode|credit|debit|card|cvv|cvc|iban|otp|2fa|pin|transfer|withdraw|donate|account|wallet|bank|ssn|send money|cancel subscription)\b/;
// Compound / glued forms ("PAYNOW", "deleteall") have no word boundary: for the unambiguous stems the whitespace-free string is searched too.
const SQUASHED = /(payment|paynow|checkout|purchase|buynow|delete|password|passcode|signin|signup|signout|login|logout|unsubscribe|subscription|withdraw|creditcard|cardnumber|cvv)/;
const DENY_AR = /(ادفع|دفع|الدفع|ادفعي|سداد|تسديد|شراء|اشتر|اشتري|احذف|حذف|ازاله|ازل|مسح|تسجيل ?(ال)?دخول|تسجيل ?خروج|دخول|خروج|انشاء ?حساب|حساب|سجل ?(الان|حساب)|كلمه ?(ال)?(سر|مرور)|بطاقه|رمز ?(ال)?(تحقق|امان)|تحويل|سحب|اشتراك|اشترك|تبرع|محفظه|بنك|رقم ?(ال)?(حساب|هويه)|فاتوره)/;
export const isSensitiveWord = (v) => {
  const n = norm(String(v ?? "").replace(/([a-z])([A-Z])/g, "$1 $2")).replace(/[_\-./:=&?]+/g, " ");
  return DENY_EN.test(n) || DENY_AR.test(n) || SQUASHED.test(n.replace(/\s+/g, ""));
};

const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code|transaction-)/;
/** autocomplete is a token list ("billing cc-number"): the field token may follow section/billing/shipping prefixes, so every token is checked. */
const sensitiveAutocomplete = (v) => String(v ?? "").toLowerCase().split(/\s+/).some((t) => SENSITIVE_AUTOCOMPLETE.test(t));
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "tel", "url", "number", ""]);

export const luhn = (digits) => {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let d = digits.charCodeAt(i) - 48; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; }
  return sum % 10 === 0;
};
const toAsciiDigits = (t) => String(t).normalize("NFKC").replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/g, (c) => String(c.charCodeAt(0) - 0x6f0));
/** Text containing a payment-card-looking number: any run of 13-19 digits (spaces, dots, dashes allowed between them), Luhn-valid. Arabic-Indic and fullwidth digits count. */
export const looksLikeCardNumber = (text) => {
  const t = toAsciiDigits(text);
  for (const m of t.matchAll(/\d(?:[ .\-]?\d){12,18}/g)) { const d = m[0].replace(/\D/g, ""); if (d.length >= 13 && d.length <= 19 && luhn(d)) return true; }
  return false;
};

const ROLE_EQUIV = { textbox: ["textbox", "searchbox"], searchbox: ["searchbox", "textbox"], switch: ["switch", "checkbox"], checkbox: ["checkbox"], radio: ["radio"], button: ["button"], link: ["link"], combobox: ["combobox"], tab: ["tab"] };
/** The element the browser says is there must be the one the caller NAMED (an overlay/decoy sitting on the named element is refused, not typed into). */
export function matchesLocator(target, facts) {
  const has = (hay, needle) => norm(hay).includes(norm(needle));
  const names = [facts.axName, facts.ariaLabel, facts.labelText, facts.title].join(" ");
  switch (target.by) {
    case "role": return (ROLE_EQUIV[target.role] ?? [target.role]).includes(String(facts.axRole || facts.role).toLowerCase()) && (target.exact ? norm(facts.axName) === norm(target.value) : has(facts.axName, target.value));
    case "label": return has(names, target.value);
    case "placeholder": return has(facts.placeholder, target.value);
    default: return has(`${facts.text} ${names}`, target.value);
  }
}

/** Stable identity of a verified element: the approval is for THIS element, and it is checked again right before the action runs. */
export const fingerprint = (facts) => createHash("sha256").update(JSON.stringify([
  facts.tag, facts.type, facts.role, facts.name, facts.text, facts.id, facts.formAction, facts.formTarget, facts.formMethod, facts.inForm, facts.isSubmit, facts.href, facts.hasHandler, facts.axName, facts.axRole, facts.pageUrl, facts.formEnctype, JSON.stringify(facts.formEntries ?? []),
])).digest("hex").slice(0, 16);

/**
 * Decision for an element that has ALREADY been found exactly once, visible and enabled.
 * `facts` are plain values read from the page (see FACTS in interactive.mjs). Returns:
 *   { decision: "deny",    code }            never executed, not approvable
 *   { decision: "approve", kind }            held until the user presses «موافقة» for this exact step
 *   { decision: "allow" }                    executed (navigation inside the lab, checkbox/radio, disclosure, typing in a plain text field)
 */
export function classify(action, facts, { allowUrl }) {
  const names = [facts.axName, facts.name, facts.text, facts.value, facts.id, facts.fieldName, facts.placeholder, facts.ariaLabel, facts.title, facts.labelText, facts.href, facts.autocomplete,
    action.target?.value];
  if (facts.overlong) return { decision: "deny", code: "unsupported_target" }; // a name/label/attribute longer than the cap could hide a sensitive word beyond it
  if (["iframe", "frame", "embed", "object"].includes(facts.tag)) return { decision: "deny", code: "unsupported_target" }; // another document: nothing here was read from it
  if (facts.type === "file") return { decision: "deny", code: "file_upload_blocked" };
  if (facts.type === "password" || sensitiveAutocomplete(facts.autocomplete)) return { decision: "deny", code: "sensitive_field" };
  if (names.some(isSensitiveWord)) return { decision: "deny", code: "sensitive_action" };

  if (action.tool === "type") {
    const editable = facts.tag === "textarea" || (facts.tag === "input" && TEXT_INPUT_TYPES.has(facts.type));
    if (!editable || facts.readOnly || facts.contentEditable) return { decision: "deny", code: "not_editable" };
    if (looksLikeCardNumber(action.text)) return { decision: "deny", code: "sensitive_value" };
    return { decision: "allow" };
  }

  // A POST must carry exactly what the owner is shown, and the gate can only compare urlencoded fields: anything else is not approvable.
  if (action.tool === "click" && facts.isSubmit && facts.formMethod !== "dialog") {
    if (facts.formMethod === "post" && facts.formEnctype && facts.formEnctype !== "application/x-www-form-urlencoded") return { decision: "deny", code: "unsupported_enctype" };
    if (facts.formBodyTooLarge) return { decision: "deny", code: "payload_too_large" };
  }
  // click. `allow` is deliberately narrow: only things whose native behaviour is navigation or local UI state AND that carry no script handler
  // attribute. Anything else (buttons, role=switch, aria-controls buttons, checkboxes inside a form or with onchange...) needs the owner's approval.
  if (facts.tag === "a") {
    if (facts.hasDownload) return { decision: "deny", code: "download_blocked" };
    if (!facts.href || !allowUrl(facts.href)) return { decision: "deny", code: "leaves_scope" };
    return facts.hasHandler ? { decision: "approve", kind: "button" } : { decision: "allow" };
  }
  if (facts.tag === "input" && (facts.type === "checkbox" || facts.type === "radio")) {
    return facts.inForm || facts.hasHandler || facts.isSubmit ? { decision: "approve", kind: "button" } : { decision: "allow" };
  }
  if (facts.tag === "summary" && !facts.hasHandler) return { decision: "allow" };
  return { decision: "approve", kind: facts.isSubmit ? "submit" : "button" };
}
