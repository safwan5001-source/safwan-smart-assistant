// The shipped lab page (apps/web/public/browser-lab) is the thing the owner points BROWSER_INTERACTIVE_SCOPES at. It must be inert
// (no network, no real submission) and must not trip the hard denials, or the interactive session would be unusable on it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isSensitiveWord } from "../actions.mjs";

const dir = new URL("../../../apps/web/public/browser-lab/", import.meta.url);
const pages = ["index.html", "page2.html"].map((f) => [f, fs.readFileSync(new URL(f, dir), "utf8")]);

test("the lab pages make no network requests and open no windows", () => {
  for (const [f, html] of pages) {
    assert.equal(/https?:\/\//i.test(html.replace(/<meta[^>]*>/gi, "")), false, `${f}: no absolute URL`);
    for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /window\.open/, /location\s*(\.|=)/, /<iframe/i, /<script[^>]+src=/i, /<link[^>]+href=/i, /<img[^>]+src=/i, /\saction=/i, /<form[^>]+method=/i, /navigator\./]) {
      assert.equal(bad.test(html), false, `${f}: ${bad}`);
    }
    assert.match(html, /name="robots" content="noindex,nofollow"/);
  }
});

test("every control name on the lab pages is allowed by the hard-denial rules (so the session can be demonstrated)", () => {
  const html = pages[0][1];
  const names = [...html.matchAll(/<(?:button|label|a|h2)[^>]*>([^<]+)</g)].map((m) => m[1].trim()).filter(Boolean);
  const attrs = [...html.matchAll(/\b(?:id|name|placeholder|aria-label|title)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 8);
  for (const n of [...names, ...attrs]) assert.equal(isSensitiveWord(n), false, n);
});

test("the demo form submits nowhere: the handler cancels the submission", () => {
  const html = pages[0][1];
  assert.match(html, /addEventListener\("submit", function \(e\) \{ e\.preventDefault\(\)/);
});
