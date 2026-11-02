// The effect gate in isolation: every rule, adversarially. (The real-browser proof is test/hostile.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import { createEffectGate, sanitizeDocumentHeaders } from "../effects.mjs";

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
  // document redirects: only inside an action window, only to the authorised URL (with its approved data) or to a query-free page of the same origin
  const w = createEffectGate(); w.begin([{ method: "GET", url: U + "search?record=A", query: false, entries: [["record", "A"]] }]);
  const hop = (to) => w.responseVerdict({ method: "GET", type: "document", status: 302, url: U + "search?record=A", headers: { location: to } }).allow;
  assert.equal(hop(U + "search?record=A"), true); assert.equal(hop(U + "search?record=B"), false, "changed data on the hop"); assert.equal(hop("/browser-lab/other"), true, "query-free same-origin page");
  assert.equal(hop("/browser-lab/other?x=1"), false); assert.equal(hop("https://evil.test/x"), false); assert.equal(hop("//evil.test/x"), false);
  w.end(); assert.equal(hop("/browser-lab/other"), false, "window closed: no redirect at all");
  assert.equal(g.responseVerdict({ method: "GET", type: "image", status: 302, url: U + "i", headers: { location: U + "j" } }).allow, true, "static GET redirects are judged by the query rule and the scope policy");
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

test("GET forms: the query must equal the approved fields (any other query on the same path is refused)", () => {
  const g = createEffectGate();
  g.begin([{ method: "GET", url: U + "search?old=1", query: false, entries: [["record", "A"], ["q", "x y"]] }]);
  assert.equal(g.decide(req({ url: U + "search?record=B&q=x+y" })).allow, false, "a field edited after approval");
  assert.equal(g.decide(req({ url: U + "search?record=A&q=x+y&extra=1" })).allow, false, "a field added");
  assert.equal(g.decide(req({ url: U + "search?q=x+y&record=A" })).allow, false, "reordered/changed shape is refused too");
  assert.equal(g.decide(req({ url: U + "search?record=A&q=x+y" })).allow, true, "exactly the shown data (the action's own old query is replaced by the browser)");
  g.begin([{ method: "GET", url: U + "go", query: false, entries: [] }]);
  assert.equal(g.decide(req({ url: U + "go?smuggled=1" })).allow, false); assert.equal(g.decide(req({ url: U + "go" })).allow, true);
});

test("document headers: hints, rules files, reporting and caching headers are dropped; no-store is added", () => {
  const out = sanitizeDocumentHeaders([{ name: "Content-Type", value: "text/html" }, { name: "Link", value: "<https://x.test/>; rel=preconnect" }, { name: "Speculation-Rules", value: '"/r.json"' },
    { name: "Reporting-Endpoints", value: 'e="https://r.test/"' }, { name: "Report-To", value: "{}" }, { name: "NEL", value: "{}" }, { name: "Refresh", value: "1; url=https://x.test/" },
    { name: "Cache-Control", value: "max-age=600" }, { name: "Content-Length", value: "5" }, { name: "Content-Encoding", value: "br" }, { name: "Set-Cookie", value: "a=b" }]);
  assert.deepEqual(out.map((h) => h.name.toLowerCase()), ["content-type", "set-cookie", "cache-control"]);
  assert.equal(out.at(-1).value, "no-store");
  const g = createEffectGate();
  assert.equal(g.responseVerdict({ method: "GET", type: "document", status: 200, headers: {} }).allow, false, "no Content-Type: not renderable by default");
  assert.equal(g.responseVerdict({ method: "GET", type: "document", status: 204, headers: {} }).allow, true, "204 has no body (our own 'stay on the page' answer)");
});
