import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createClient } from "../../../poc/smoke1/browserbase.mjs";

const capture = () => { const sent = []; return { sent, fetchImpl: async (_u, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ id: "s", connectUrl: "wss://x" }) }; } }; };

test("createSession sends proxies/allowedDomains only when given (default body unchanged)", async () => {
  const c = capture(); const client = createClient({ apiKey: "k", fetchImpl: c.fetchImpl });
  await client.createSession({ projectId: "p", timeoutSeconds: 60 });
  assert.equal("proxies" in c.sent[0], false); assert.equal("allowedDomains" in c.sent[0].browserSettings, false);
  const proxies = [{ type: "external", server: "https://p.example", username: "u", password: "w" }];
  await client.createSession({ projectId: "p", timeoutSeconds: 60, proxies, allowedDomains: ["lab.example"] });
  assert.deepEqual(c.sent[1].proxies, proxies); assert.deepEqual(c.sent[1].browserSettings.allowedDomains, ["lab.example"]);
  assert.equal("domainPattern" in c.sent[1].proxies[0], false); // no pattern: EVERYTHING must go through the proxy
});

function start(env) {
  const child = spawn(process.execPath, ["server.mjs"], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(33000 + Math.floor(Math.random() * 5000)), BROWSER_SERVICE_TOKEN: "t".repeat(40), BROWSERBASE_API_KEY: "dummy", BROWSERBASE_PROJECT_ID: "dummy", ...env } });
  let err = ""; child.stderr.on("data", (d) => { err += d; });
  return { child, err: () => err };
}
test("interactive scopes without an egress proxy refuse to start (fail closed)", async () => {
  const s = start({ BROWSER_INTERACTIVE_SCOPES: "lab.example/browser-lab/" });
  const [code] = await once(s.child, "exit");
  assert.equal(code, 1); assert.match(s.err(), /requires BROWSER_EGRESS_PROXY/);
});
test("an incomplete egress proxy configuration refuses to start", async () => {
  const s = start({ BROWSER_EGRESS_PROXY_SERVER: "https://p.example" });
  const [code] = await once(s.child, "exit");
  assert.equal(code, 1); assert.match(s.err(), /BROWSER_EGRESS_PROXY_\* is invalid/);
});
test("interactive scopes with a complete proxy configuration start", async () => {
  const s = start({ BROWSER_INTERACTIVE_SCOPES: "lab.example/browser-lab/", BROWSER_EGRESS_PROXY_SERVER: "https://p.example", BROWSER_EGRESS_PROXY_USERNAME: "u", BROWSER_EGRESS_PROXY_PASSWORD: "w" });
  await new Promise((r) => { s.child.stdout.on("data", r); s.child.on("exit", r); });
  assert.equal(s.child.exitCode, null); s.child.kill("SIGTERM"); await once(s.child, "exit");
});
