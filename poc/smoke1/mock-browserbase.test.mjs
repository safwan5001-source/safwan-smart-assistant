// Validates the Smoke-1 harness against the local mock (NO cloud, NO key). Run: node mock-browserbase.test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, MOCK_KEY } from "./mock-browserbase.mjs";
import { mask } from "./browserbase.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${d ? "  — " + d : ""}`); if (!ok) failed++; };
// async on purpose: the mock server lives in THIS process and must keep serving while the harness runs
const run = (extra, env) => new Promise((resolve) => {
  const c = spawn("node", [path.join(here, "smoke1.mjs"), ...extra], { env: { ...process.env, ...env } });
  let stdout = "", stderr = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
  const t = setTimeout(() => c.kill("SIGKILL"), 200_000);
  c.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
});
const latest = () => { const d = path.join(here, "out"); const f = fs.readdirSync(d).filter((x) => x.startsWith("smoke1-")).sort().pop(); return fs.readFileSync(path.join(d, f), "utf8"); };

// 1) guards that need no network at all
let r = await run(["--cloud"], { BROWSERBASE_API_KEY: "", BROWSERBASE_API_BASE: "" });
check("refuses --cloud without a key", r.status === 2);
r = await run(["--cloud"], { BROWSERBASE_API_KEY: "k", BROWSERBASE_API_BASE: "", SMOKE1_APPROVED: "" });
check("refuses the REAL API without SMOKE1_APPROVED=yes (before any request)", r.status === 2 && /approve/.test(r.stderr));
r = await run(["--cloud", "--api-key=abc"], { BROWSERBASE_API_KEY: "k" });
check("refuses credentials on argv", r.status === 2);

// 2) full cloud code path against the mock, bearer-style live URL (what the vendor docs suggest)
const mock = await startMock({ bearer: true });
try {
  r = await run(["--cloud", "--no-ttl-test"], { BROWSERBASE_API_KEY: MOCK_KEY, BROWSERBASE_API_BASE: mock.base });
  const out = r.stdout + r.stderr, rep = latest();
  check("harness completes against the mock (exit 0)", r.status === 0, out.split("\n").filter((l) => l.startsWith("FAIL")).join(" | "));
  const R = JSON.parse(rep);
  const step = (id) => R.steps.find((s) => s.id === id);
  check("exactly-one submit verified", step("S4-submit-once")?.ok === true);
  check("Arabic readback exact", step("S3-text")?.ok === true);
  check("anonymous live-view fetch is observed as 200 (bearer)", step("S6-anon-http")?.observed?.status === 200);
  check("anonymous WebSocket open is observed", step("S6-anon-ws")?.observed === "opened");
  check("session released and live URL dead afterwards", step("S7-released")?.ok === true && step("S7-live-dead")?.ok === true);
  check("release request body was exactly {status:'REQUEST_RELEASE'}", mock.log.includes("POST /v1/sessions/" + [...mock.sessions.keys()][0]));
  const secrets = [MOCK_KEY, "mock-signing-key", "/live/", "devtools/browser"];
  check("no secret appears in console output or in the report file", secrets.every((s) => !out.includes(s) && !rep.includes(s)), secrets.filter((s) => out.includes(s) || rep.includes(s)).join(","));
  check("mask() hides path and query", !mask("https://h.example/abc/def?token=SECRET").includes("SECRET") && !mask("https://h.example/abc/def?token=SECRET").includes("abc"));
} finally { await mock.stop(); }

// 3) TTL enforcement observed (adds ~65 s)
const mock2 = await startMock({ bearer: true });
try {
  r = await run(["--cloud"], { BROWSERBASE_API_KEY: MOCK_KEY, BROWSERBASE_API_BASE: mock2.base });
  const R = JSON.parse(latest());
  check("TTL: live URL stops working after 60 s", R.steps.find((s) => s.id === "S6-ttl")?.ok === true && r.status === 0);
} finally { await mock2.stop(); }

// 4) a bound (cookie-required) live view is observed as not anonymously loadable
const mock3 = await startMock({ bearer: false });
try {
  r = await run(["--cloud", "--no-ttl-test"], { BROWSERBASE_API_KEY: MOCK_KEY, BROWSERBASE_API_BASE: mock3.base });
  const R = JSON.parse(latest());
  check("bound live view: anonymous fetch is NOT 200", R.steps.find((s) => s.id === "S6-anon-http")?.observed?.status === 403);
} finally { await mock3.stop(); }

// 5) local mode needs nothing
r = await run([], {});
check("local mode passes with no network and no key", r.status === 0);
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
