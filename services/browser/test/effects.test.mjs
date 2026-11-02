// The effect gate in isolation: every rule, adversarially. (The real-browser proof is test/hostile.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import { createEffectGate } from "../effects.mjs";

const U = "https://lab.test/browser-lab/";
const req = (o) => ({ method: "GET", type: "document", navigation: true, url: U + "index.html", ...o });

test("a new session may navigate (its first load); after end() nothing navigates", () => {
  const g = createEffectGate();
  g.begin([{ method: "GET", url: U + "index.html", query: true }]);
  assert.equal(g.decide(req()).allow, true);
  assert.equal(g.decide(req({ url: U + "page2.html" })).allow, false, "a second, different document is not part of that action");
  g.end();
  assert.equal(g.decide(req()).allow, false, "window closed: a script redirect/timer cannot navigate");
  assert.equal(g.isOpen(), false);
});

test("state-changing methods: only the approved method+URL, only once, only as a top-level form navigation", () => {
  const g = createEffectGate();
  g.begin([{ method: "POST", url: U + "submit?record=A", query: true }]);
  assert.equal(g.decide(req({ method: "POST", type: "fetch", navigation: false, url: U + "submit?record=A" })).allow, false, "a fetch POST to the very same URL is still a script request");
  assert.equal(g.decide(req({ method: "POST", url: U + "submit?record=B" })).allow, false, "query differs");
  assert.equal(g.decide(req({ method: "POST", url: U + "other" })).allow, false);
  assert.equal(g.decide(req({ method: "PUT", url: U + "submit?record=A" })).allow, false, "wrong method");
  assert.equal(g.decide(req({ method: "POST", url: "https://evil.test/submit?record=A" })).allow, false, "wrong origin");
  assert.equal(g.decide(req({ method: "POST", url: U + "submit?record=A" })).allow, true);
  assert.equal(g.decide(req({ method: "POST", url: U + "submit?record=A" })).allow, false, "one use");
  const refused = g.end();
  assert.equal(refused.filter((r) => r === "unauthorized_effect").length, 6);
  assert.equal(g.decide(req({ method: "POST" })).allow, false, "nothing authorised once the window is closed");
});

test("no window, no state change: POST/PUT/PATCH/DELETE are refused from the start", () => {
  const g = createEffectGate(); g.end();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) assert.equal(g.decide(req({ method })).allow, false, method);
});

test("script requests are refused even inside a window, approved or not", () => {
  const g = createEffectGate();
  g.begin([{ method: "GET", url: U + "x.html" }, { method: "POST", url: U + "submit" }]);
  for (const type of ["xhr", "fetch", "eventsource", "websocket", "other", "ping", "cspviolationreport", "preflight"]) {
    assert.equal(g.decide({ method: "GET", type, navigation: false, url: U + "api/x" }).allow, false, type);
    assert.equal(g.decide({ method: "POST", type, navigation: false, url: U + "submit" }).allow, false, type);
  }
});

test("static subresources load, but never with a query string", () => {
  const g = createEffectGate(); g.end();
  for (const type of ["stylesheet", "script", "image", "font", "media", "manifest", "texttrack"]) {
    assert.equal(g.decide({ method: "GET", type, navigation: false, url: U + "a.css" }).allow, true, type);
    assert.equal(g.decide({ method: "GET", type, navigation: false, url: U + "a.css?id=1" }).allow, false, type + " with query");
  }
});

test("link / GET-form windows: exact URL (links) or origin+path (GET forms)", () => {
  const g = createEffectGate();
  g.begin([{ method: "GET", url: U + "page2.html", query: true }]);
  assert.equal(g.decide(req({ url: U + "page2.html?x=1" })).allow, false, "a link may not gain a query");
  assert.equal(g.decide(req({ url: U + "page2.html" })).allow, true);
  g.begin([{ method: "GET", url: U + "search" }]);
  assert.equal(g.decide(req({ url: U + "search?q=typed+text" })).allow, true, "a GET form's query is the user's own input");
  assert.equal(g.decide(req({ url: U + "elsewhere?q=1" })).allow, false);
});

test("responses: redirects of state-changing requests, attachments and non-renderable documents are refused", () => {
  const g = createEffectGate();
  assert.equal(g.responseVerdict({ method: "POST", type: "document", status: 307, headers: { location: "/x" } }).allow, false);
  assert.equal(g.responseVerdict({ method: "POST", type: "document", status: 302, headers: {} }).allow, false);
  assert.equal(g.responseVerdict({ method: "GET", type: "document", status: 302, headers: { location: "/x" } }).allow, true, "GET redirects are judged by the scope policy elsewhere");
  assert.equal(g.responseVerdict({ method: "GET", type: "document", status: 200, headers: { "content-disposition": 'attachment; filename="a"' } }).allow, false);
  assert.equal(g.responseVerdict({ method: "GET", type: "image", status: 200, headers: { "content-disposition": " Attachment" } }).allow, false);
  assert.equal(g.responseVerdict({ method: "GET", type: "document", status: 200, headers: { "content-type": "application/octet-stream" } }).allow, false);
  assert.equal(g.responseVerdict({ method: "GET", type: "document", status: 200, headers: { "content-type": "application/pdf" } }).allow, false);
  assert.equal(g.responseVerdict({ method: "GET", type: "document", status: 200, headers: { "content-type": "text/html; charset=utf-8" } }).allow, true);
  assert.equal(g.responseVerdict({ method: "GET", type: "document", status: 200, headers: { "content-type": "text/plain" } }).allow, true);
  assert.equal(g.responseVerdict({ method: "GET", type: "image", status: 200, headers: { "content-type": "image/png" } }).allow, true);
});

test("end() reports what was refused during the window, and clears it", () => {
  const g = createEffectGate();
  g.begin([]);
  g.decide({ method: "GET", type: "fetch", navigation: false, url: U + "a" });
  g.decide({ method: "POST", type: "document", navigation: true, url: U + "a" });
  assert.deepEqual(g.end(), ["script_request", "unauthorized_effect"]);
  assert.deepEqual(g.end(), []);
});
