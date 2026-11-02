import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const token = "t".repeat(40);
const port = 32000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL(".", import.meta.url).pathname,
  env: { ...process.env, PORT: String(port), BROWSER_SERVICE_TOKEN: token,
    BROWSERBASE_API_KEY: "dummy-test-key", BROWSERBASE_PROJECT_ID: "dummy-project",
    BROWSER_ALLOWED_HOSTS: "example.com" },
  stdio: ["ignore", "pipe", "pipe"],
});
async function ready() {
  for (let i=0;i<50;i++) {
    if (child.exitCode !== null) throw new Error("browser server quit early");
    try { const r = await fetch(base + "/health"); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("browser server did not become ready");
}
async function post(url, bearer = token, contentType = "application/json") {
  return fetch(base + "/v1/navigate", {
    method: "POST", headers: { "content-type": contentType, ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
    body: JSON.stringify({ url }),
  });
}
test("permanent worker safeguards do not require a real Browserbase session", async t => {
  t.after(() => child.kill("SIGTERM"));
  await ready();
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await post("https://example.com", "")).status, 401);
  assert.equal((await post("https://example.com", "wrong")).status, 401);
  assert.equal((await post("https://example.com", token, "text/plain")).status, 415);
  for (const url of ["http://example.com", "https://localhost/", "https://127.0.0.1/", "https://example.com.evil.test/", "https://example.com:443/", "https://user:pass@example.com/", "file:///etc/passwd", "https://evil.test/"]) {
    assert.equal((await post(url)).status, 400, url);
  }
  assert.equal((await fetch(base + "/does-not-exist")).status, 404);
});
