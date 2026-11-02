// Pure rules: action validation, the lab-scope policy, and the deny / approve / allow classification. No browser needed.
import test from "node:test";
import assert from "node:assert/strict";
import { ActionError, classify, fingerprint, isSensitiveWord, looksLikeCardNumber, norm, parseAction, describe } from "../actions.mjs";
import { createPolicy, parseScopes } from "../policy.mjs";

const policy = createPolicy(["example.com"], ["lab.example.org/browser-lab/"]);
const parse = (raw) => parseAction(raw, policy.parseSessionTarget);
const code = (fn) => { try { fn(); return null; } catch (e) { return e instanceof ActionError ? e.code : "other:" + e.message; } };
const allowUrl = (u) => policy.allowRequest(u);
const facts = (o = {}) => ({ tag: "button", type: "button", role: "", name: "", id: "", text: "Go", value: "", placeholder: "", ariaLabel: "", title: "", labelText: "", autocomplete: "", fieldName: "", href: "",
  hasDownload: false, readOnly: false, contentEditable: false, inForm: false, formAction: "", isSubmit: false, hasDisclosureAttr: false, ...o });
const click = (v = "Go") => ({ tool: "click", target: { by: "role", role: "button", value: v, exact: false } });
const typing = (text = "hello", v = "Name") => ({ tool: "type", target: { by: "label", value: v, exact: false }, text });

test("scopes: host + mandatory prefix, never IPs, internal names or a bare host", () => {
  assert.deepEqual(parseScopes(["lab.example.org/browser-lab/", " "]), [{ host: "lab.example.org", prefix: "/browser-lab/" }]);
  for (const bad of ["lab.example.org", "lab.example.org/", "10.0.0.1/a/", "127.0.0.1/a/", "x.internal/a/", "x.railway.internal/a/", "localhost/a/", "a.local/a/", "lab.example.org:8443/a/",
    "https://lab.example.org/a/", "lab.example.org/a", "lab.example.org/../a/", "lab.example.org/a b/", "lab.example.org/%2e%2e/", "user@lab.example.org/a/", "LAB.example.org/a/", ""]) {
    if (bad === "") continue; // blank entries are skipped
    assert.throws(() => parseScopes([bad]), /invalid interactive scope/, bad);
  }
  assert.equal(createPolicy(["example.com"]).scopes.length, 0, "default = no interactive scope");
});

test("policy: interaction is possible only inside a scope; look-only hosts and the rest of the lab host are not", () => {
  assert.equal(policy.canInteract("https://lab.example.org/browser-lab/index.html"), true);
  assert.equal(policy.canInteract("https://example.com/"), false);
  assert.equal(policy.canInteract("https://lab.example.org/"), false);
  assert.equal(policy.canInteract("https://lab.example.org/browser-lab"), false);
  assert.equal(policy.canInteract("https://lab.example.org/browser-lab/../admin"), false);
  assert.equal(policy.canInteract("http://lab.example.org/browser-lab/x"), false);
  assert.equal(policy.canInteract("https://lab.example.org:8443/browser-lab/x"), false);
  assert.equal(policy.canInteract("https://evil.lab.example.org/browser-lab/x"), false);
  assert.equal(policy.canInteract("https://lab.example.org.evil.test/browser-lab/x"), false);
  assert.equal(policy.canInteract("https://u:p@lab.example.org/browser-lab/x"), false);
  for (const tricky of ["browser-lab/..%2fadmin", "browser-lab/..;/admin", "browser-lab/%5c..%5cadmin", "browser-lab//x", "browser-lab/a%2fb"]) {
    assert.equal(policy.canInteract(`https://lab.example.org/${tricky}`), false, tricky);
    assert.equal(policy.allowRequest(`https://lab.example.org/${tricky}`), false, tricky);
  }
  assert.equal(policy.allowRequest("https://lab.example.org/browser-lab/app.js"), true);
  assert.equal(policy.allowRequest("https://lab.example.org/api/session"), false, "subresources of the lab host outside the prefix are refused");
  assert.equal(policy.allowRequest("https://example.com/anything"), true);
  assert.equal(policy.parseSessionTarget("https://lab.example.org/browser-lab/index.html"), "https://lab.example.org/browser-lab/index.html");
  assert.equal(policy.parseSessionTarget("https://example.com/"), "https://example.com/");
  for (const bad of ["https://lab.example.org/", "https://lab.example.org/browser-lab/a?x=1", "https://lab.example.org/browser-lab/a#h", "https://evil.test/browser-lab/", "javascript:alert(1)", "https://lab.example.org/browser-lab/%2e%2e/x", ""]) {
    assert.throws(() => policy.parseSessionTarget(bad), /URL not allowed/, bad);
  }
  assert.equal(policy.labStartUrl(), "https://lab.example.org/browser-lab/index.html");
  assert.equal(createPolicy(["example.com"]).labStartUrl(), null);
});

test("parseAction: strict shape, structured locators only", () => {
  assert.deepEqual(parse({ tool: "observe" }), { tool: "observe" });
  assert.deepEqual(parse({ tool: "navigate", url: "https://lab.example.org/browser-lab/a.html" }), { tool: "navigate", url: "https://lab.example.org/browser-lab/a.html" });
  assert.deepEqual(parse({ tool: "click", target: { by: "role", role: "button", value: " Save " } }), { tool: "click", target: { by: "role", role: "button", value: "Save", exact: false } });
  assert.equal(parse({ tool: "type", target: { by: "label", value: "Name", exact: true }, text: "مرحبا" }).text, "مرحبا");
  const bad = [
    null, [], "click", {}, { tool: "eval", code: "1" }, { tool: "press", key: "Enter" }, { tool: "observe", extra: 1 },
    { tool: "navigate", url: "https://evil.test/" }, { tool: "navigate", url: 5 }, { tool: "navigate" },
    { tool: "click" }, { tool: "click", target: "button" }, { tool: "click", target: { by: "css", value: "#a" } }, { tool: "click", target: { by: "xpath", value: "//a" } },
    { tool: "click", target: { by: "role", role: "button" } }, { tool: "click", target: { by: "role", role: "script", value: "x" } },
    { tool: "click", target: { by: "role", role: "button", value: "x", css: "a" } }, { tool: "click", target: { by: "label", role: "button", value: "x" } },
    { tool: "click", target: { by: "text", value: "" } }, { tool: "click", target: { by: "text", value: "   " } }, { tool: "click", target: { by: "text", value: "a".repeat(81) } },
    { tool: "click", target: { by: "text", value: "a\nb" } }, { tool: "click", target: { by: "text", value: "a‮b" } }, { tool: "click", target: { by: "text", value: "x", exact: "yes" } },
    { tool: "click", target: { by: "text", value: "x" }, approved: true },
    { tool: "type", target: { by: "label", value: "x" } }, { tool: "type", target: { by: "label", value: "x" }, text: "a".repeat(201) },
    { tool: "type", target: { by: "label", value: "x" }, text: "a\nb" }, { tool: "type", target: { by: "label", value: "x" }, text: "a\u0000" }, { tool: "type", target: { by: "label", value: "x" }, text: 5 },
    Object.assign(Object.create({ tool: "observe" }), {}),
  ];
  for (const raw of bad) assert.ok(code(() => parse(raw)), JSON.stringify(raw));
  assert.equal(code(() => parse({ tool: "navigate", url: "https://evil.test/" })), "url_not_allowed");
  assert.equal(describe(parse({ tool: "type", target: { by: "label", value: "Name" }, text: "SECRET-CANARY" })).includes("SECRET"), false, "descriptions never contain typed text");
});

test("norm / sensitive words: English and Arabic, diacritics, alef variants, zero-width tricks", () => {
  for (const w of ["Pay now", "PAYMENT", "Delete account", "Sign in", "log in", "Login", "Checkout", "Buy", "Password", "CVV", "credit card", "ادفع الآن", "الدَّفع", "احذف", "حذف الحساب", "تسجيل الدخول", "تسجيل دخول", "كلمة المرور", "كلمة السر", "بطاقة الائتمان", "شراء", "إنشاء حساب", "p​ay", "ﬁx pay"]) {
    assert.equal(isSensitiveWord(w), true, w);
  }
  for (const w of ["Send", "Next page", "Count", "Name", "Notes", "I agree", "إرسال", "التالي", "الاسم", "ملاحظات", "Submit", "Save", "Search", "Display", "Spayed"]) assert.equal(isSensitiveWord(w), false, w);
  assert.equal(norm("الدَّفْـع"), "الدفع");
});

test("looksLikeCardNumber: Luhn-valid 13-19 digits however grouped", () => {
  assert.equal(looksLikeCardNumber("4111 1111 1111 1111"), true);
  assert.equal(looksLikeCardNumber("4111-1111-1111-1111"), true);
  assert.equal(looksLikeCardNumber("4111111111111112"), false);
  assert.equal(looksLikeCardNumber("12345"), false);
  assert.equal(looksLikeCardNumber("hello 4111111111111111"), true, "embedded numbers count");
  assert.equal(looksLikeCardNumber("order 1234567890123"), false);
});

test("classify: deny is final, buttons need approval, plain navigation and plain text fields do not", () => {
  const c = (action, f) => classify(action, f, { allowUrl });
  // hard denials
  assert.deepEqual(c(typing(), facts({ tag: "input", type: "password" })), { decision: "deny", code: "sensitive_field" });
  assert.deepEqual(c(typing(), facts({ tag: "input", type: "text", autocomplete: "cc-number" })), { decision: "deny", code: "sensitive_field" });
  assert.deepEqual(c(typing(), facts({ tag: "input", type: "text", autocomplete: "one-time-code" })), { decision: "deny", code: "sensitive_field" });
  for (const ac of ["billing cc-number", "section-a shipping cc-csc", "SECTION-X BILLING CC-EXP", "work new-password"]) assert.deepEqual(c(typing("123"), facts({ tag: "input", type: "text", autocomplete: ac })), { decision: "deny", code: "sensitive_field" }, ac);
  assert.deepEqual(c(typing(), facts({ tag: "input", type: "text", autocomplete: "billing name" })), { decision: "allow" });
  assert.deepEqual(c(typing(), facts({ tag: "input", type: "text", fieldName: "card_number" })), { decision: "deny", code: "sensitive_action" });
  assert.deepEqual(c(typing(), facts({ tag: "input", type: "text", placeholder: "كلمة المرور" })), { decision: "deny", code: "sensitive_action" });
  assert.deepEqual(c(typing(), facts({ tag: "input", type: "file" })), { decision: "deny", code: "file_upload_blocked" });
  assert.deepEqual(c(typing("4111 1111 1111 1111"), facts({ tag: "input", type: "text" })), { decision: "deny", code: "sensitive_value" });
  assert.deepEqual(c(click("Pay now"), facts({ text: "Pay now" })), { decision: "deny", code: "sensitive_action" });
  assert.deepEqual(c(click("Go"), facts({ text: "Delete item" })), { decision: "deny", code: "sensitive_action" }, "the real element text counts, not only what the caller named");
  assert.deepEqual(c(click("Go"), facts({ tag: "input", type: "submit", value: "تسجيل الدخول", isSubmit: true })), { decision: "deny", code: "sensitive_action" });
  assert.deepEqual(c(click("Go"), facts({ tag: "a", href: "https://lab.example.org/browser-lab/checkout.html", text: "Continue" })), { decision: "deny", code: "sensitive_action" });
  assert.deepEqual(c(click("x"), facts({ tag: "a", href: "https://evil.test/x", text: "x" })), { decision: "deny", code: "leaves_scope" });
  assert.deepEqual(c(click("x"), facts({ tag: "a", href: "javascript:alert(1)", text: "x" })), { decision: "deny", code: "leaves_scope" });
  assert.deepEqual(c(click("x"), facts({ tag: "a", href: "mailto:a@b.c", text: "x" })), { decision: "deny", code: "leaves_scope" });
  assert.deepEqual(c(click("x"), facts({ tag: "a", href: "https://lab.example.org/browser-lab/f.zip", hasDownload: true, text: "x" })), { decision: "deny", code: "download_blocked" });
  assert.deepEqual(c(typing(), facts({ tag: "div", type: "" })), { decision: "deny", code: "not_editable" });
  assert.deepEqual(c(typing(), facts({ tag: "input", type: "text", readOnly: true })), { decision: "deny", code: "not_editable" });
  assert.deepEqual(c(typing(), facts({ tag: "input", type: "checkbox" })), { decision: "deny", code: "not_editable" });
  // allowed without approval
  assert.deepEqual(c(typing(), facts({ tag: "input", type: "text", labelText: "Name" })), { decision: "allow" });
  assert.deepEqual(c(typing(), facts({ tag: "textarea", type: "" })), { decision: "allow" });
  assert.deepEqual(c(click("Next"), facts({ tag: "a", href: "https://lab.example.org/browser-lab/page2.html", text: "Next" })), { decision: "allow" });
  assert.deepEqual(c(click("I agree"), facts({ tag: "input", type: "checkbox", labelText: "I agree" })), { decision: "allow" });
  assert.deepEqual(c(click("More"), facts({ tag: "summary", type: "", text: "More" })), { decision: "allow" });
  // review F2: native navigation / local UI state WITHOUT handler attributes only. Everything that might persist something needs approval.
  for (const f of [{ tag: "input", type: "checkbox", inForm: true }, { tag: "input", type: "checkbox", hasHandler: true }, { tag: "input", type: "radio", hasHandler: true },
    { tag: "a", href: "https://lab.example.org/browser-lab/p.html", hasHandler: true }, { tag: "summary", type: "", hasHandler: true },
    { text: "Save changes", hasDisclosureAttr: true }, { tag: "div", type: "", role: "switch", text: "Dark mode" }, { tag: "button", type: "button", role: "switch", text: "Sync" }]) {
    assert.equal(c(click("x"), facts(f)).decision, "approve", JSON.stringify(f));
  }
  // approval
  assert.deepEqual(c(click("Count"), facts({ text: "Count" })), { decision: "approve", kind: "button" });
  assert.deepEqual(c(click("Send form"), facts({ type: "submit", isSubmit: true, inForm: true, text: "Send form" })), { decision: "approve", kind: "submit" });
  assert.deepEqual(c(click("Menu"), facts({ text: "Menu", hasDisclosureAttr: true, isSubmit: true })), { decision: "approve", kind: "submit" });
  // review F4: homoglyphs, soft hyphens, glued words, inflections, more Arabic, accessible-name sources, card numbers in other shapes
  for (const w of ["Pаy now", "Pa\u00ady", "PAYNOW", "paynow", "deleteall", "Sign out", "signout", "Cancel subscription", "Deleted items", "purchased", "buying", "Send money", "سداد الفاتورة", "تسديد", "فاتورة"]) assert.equal(isSensitiveWord(w), true, w);
  for (const w of ["Confirm", "Spayed", "Display", "Next", "إرسال النموذج", "Notes", "Count"]) assert.equal(isSensitiveWord(w), false, w);
  assert.deepEqual(c(click("Go"), facts({ text: "Continue", labelText: "Delete account" })), { decision: "deny", code: "sensitive_action" }, "img alt / aria-labelledby text counts");
  for (const n of ["4111.1111.1111.1111", "٤١١١ ١١١١ ١١١١ ١١١١", "４１１１１１１１１１１１１１１１", "card 4111 1111 1111 1111 exp 12/30", "4111-1111-1111-1111."]) {
    assert.deepEqual(c(typing(n), facts({ tag: "input", type: "text" })), { decision: "deny", code: "sensitive_value" }, n);
  }
  assert.equal(c(typing("call 0501234567 or 2024-11-02"), facts({ tag: "input", type: "text" })).decision, "allow");
  assert.deepEqual(c(click("Go"), facts({ tag: "div", type: "", role: "button" })), { decision: "approve", kind: "button" });
});

test("fingerprint changes when the element's identity or destination changes", () => {
  const a = facts({ text: "Save", inForm: true, formAction: "https://lab.example.org/browser-lab/save" });
  assert.equal(fingerprint(a), fingerprint({ ...a }));
  for (const patch of [{ text: "Save all" }, { formAction: "https://lab.example.org/browser-lab/other" }, { formMethod: "get" }, { id: "x" }, { type: "submit" }, { href: "https://lab.example.org/browser-lab/x" }]) {
    assert.notEqual(fingerprint({ ...a, ...patch }), fingerprint(a), JSON.stringify(patch));
  }
});
