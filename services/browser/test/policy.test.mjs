import test from "node:test";
import assert from "node:assert/strict";
import { cleanText, createPolicy } from "../policy.mjs";

const policy = createPolicy(["example.com"]);

test("parseTarget accepts only https on an allow-listed host, canonicalised", () => {
  assert.equal(policy.parseTarget("https://example.com"), "https://example.com/");
  assert.equal(policy.parseTarget("https://EXAMPLE.com/a/b-c_d.html"), "https://example.com/a/b-c_d.html");
  assert.equal(policy.parseTarget("https://example.com/#"), "https://example.com/"); // empty fragment is dropped, not navigated
  assert.equal(policy.parseTarget("https://example.com:443/x?"), "https://example.com/x"); // default port / empty query normalise away; we navigate to the canonical form
  assert.equal(policy.parseTarget("https://example.com/a/%2e%2e/"), "https://example.com/"); // dot-segments are resolved by the URL parser, never forwarded raw
});

test("parseTarget rejects every way of leaving the allow-list", () => {
  const bad = [
    "http://example.com", "ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x",
    "https://example.com.evil.test/", "https://evil.test/https://example.com", "https://example.com@evil.test/",
    "https://user:pw@example.com/", "https://example.com:8443/", "https://example.com:80/",
    "https://example.com/?x=1", "https://example.com/#frag", "https://example.com/a%00",
    "https://example.com\\@evil.test", "https://example.com.", "https://sub.example.com/", "https://EXAMPLE.COM.evil.test/",
    "https://localhost/", "https://127.0.0.1/", "https://[::1]/", "https://[::ffff:169.254.169.254]/", "https://169.254.169.254/",
    "https://2852039166/", "https://0xa9fea9fe/", "https://10.0.0.1/", "https://safwan-api.railway.internal/",
    "", " ", "https://", "not a url", "https://example.com/" + "a".repeat(200),
  ];
  for (const u of bad) assert.throws(() => policy.parseTarget(u), /not allowed/, u);
  for (const v of [undefined, null, 5, {}, [], ["https://example.com"]]) assert.throws(() => policy.parseTarget(v), /not allowed/);
});

test("allowRequest guards every browser request (redirects, subresources, frames) with no port, https, exact host", () => {
  assert.equal(policy.allowRequest("https://example.com/x.png?y=1"), true);
  for (const u of ["http://example.com/", "https://example.com:444/", "https://evil.test/", "https://user@example.com/", "wss://example.com/",
    "https://169.254.169.254/latest/meta-data/", "http://[::ffff:169.254.169.254]/", "https://metadata.google.internal/", "blob:https://example.com/x",
    "data:image/png;base64,AAAA", "about:blank", "chrome://settings", "garbage"]) assert.equal(policy.allowRequest(u), false, u);
});

test("an empty or whitespace allow-list allows nothing", () => {
  const none = createPolicy(["", "  "]);
  assert.deepEqual(none.hosts, []);
  assert.throws(() => none.parseTarget("https://example.com/"), /not allowed/);
  assert.equal(none.allowRequest("https://example.com/"), false);
});

test("cleanText removes control characters and bidi overrides and bounds the length", () => {
  assert.equal(cleanText("a‮b\u0000c‏d⁦e\n\n  f", 100), "abcde f");
  assert.equal(cleanText("x".repeat(50), 10).length, 10);
  assert.equal(cleanText(undefined, 10), "");
});
