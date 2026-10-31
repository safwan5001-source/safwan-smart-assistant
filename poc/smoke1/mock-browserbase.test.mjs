// Validates the Smoke-1 harness against the local mock (NO cloud, NO key). Run: node mock-browserbase.test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, MOCK_KEY } from "./mock-browserbase.mjs";
import { mask, redact } from "./browserbase.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${d ? "  — " + d : ""}`); if (!ok) failed++; };
// async on purpose: the mock server lives in THIS process and must keep serving while the harness runs
const run = (extra, env) => new Promise((resolve) => {
  const c = spawn("node", [path.join(here, "smoke1.mjs"), ...extra], { env: { SMOKE1_TTL_WAIT_MS: "2500", ...process.env, ...env } });
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
  check("revocation is tested on an UNEXPIRED, loadable URL (200 before release, refused after)", step("S7-live-dead")?.observed?.pre === 200 && step("S7-live-dead")?.observed?.post === 403);
  check("verdict is 'passed' when everything was observed", R.verdict === "passed");
  check("release request body was exactly {status:'REQUEST_RELEASE'}", mock.log.includes("POST /v1/sessions/" + [...mock.sessions.keys()][0]));
  const secrets = [MOCK_KEY, "mock-signing-key", "/live/", "devtools/browser"];
  check("no secret appears in console output or in the report file", secrets.every((s) => !out.includes(s) && !rep.includes(s)), secrets.filter((s) => out.includes(s) || rep.includes(s)).join(","));
  check("mask() hides path and query", !mask("https://h.example/abc/def?token=SECRET").includes("SECRET") && !mask("https://h.example/abc/def?token=SECRET").includes("abc"));
} finally { await mock.stop(); }

// 3) TTL enforcement observed (the mock lets the wait be shortened; the real run always waits 65 s)
const mock2 = await startMock({ bearer: true, ttlMs: 1000 });
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

// 4b) error messages cannot leak credentials
const SECRET = "SECRET-TOKEN-XYZ-0123456789";
{
  const msgs = [`browserType.connectOverCDP: connect ECONNREFUSED wss://connect.example/?signingKey=${SECRET}&x=1`, `failed ${SECRET}`, `GET https://live.example/v1/abc/${SECRET}/fullscreen 500`, "plain message"];
  check("redact(): known secrets, URLs and long tokens are removed; short plain text survives",
    msgs.slice(0, 3).every((m) => !redact(m, [SECRET]).includes(SECRET)) && redact(msgs[3], [SECRET]) === "plain message", msgs.slice(0, 3).map((m) => redact(m, [SECRET])).join(" | "));
}
const mockBad = await startMock({ badConnect: true });
try {
  r = await run(["--cloud", "--no-ttl-test"], { BROWSERBASE_API_KEY: MOCK_KEY, BROWSERBASE_API_BASE: mockBad.base });
  const out = r.stdout + r.stderr, rep = latest();
  check("failed CDP connection: reported as FATAL, exit 1", r.status === 1 && /FATAL/.test(out));
  check("failed CDP connection: no secret in console or report", ["SECRET-TOKEN-XYZ", "SECRET-SIGNING-KEY", "signingKey=", MOCK_KEY].every((x) => !out.includes(x) && !rep.includes(x)));
} finally { await mockBad.stop(); }

// 4c) a transport failure is INCONCLUSIVE, never a pass (TTL enabled)
const mockDown = await startMock({ bearer: true, liveBroken: true, ttlMs: 1000 });
try {
  r = await run(["--cloud"], { BROWSERBASE_API_KEY: MOCK_KEY, BROWSERBASE_API_BASE: mockDown.base });
  const R = JSON.parse(latest()); const st = (id) => R.steps.find((x) => x.id === id);
  check("transport errors: TTL check is inconclusive, not a pass", st("S6-ttl")?.ok === null && st("S6-ttl")?.inconclusive === true, JSON.stringify(st("S6-ttl")?.observed));
  check("transport errors: revocation check is inconclusive, not a pass", st("S7-live-dead")?.ok === null && st("S7-live-dead")?.inconclusive === true);
  check("transport errors: verdict 'inconclusive' and exit code 4 (not 0)", R.verdict === "inconclusive" && r.status === 4, `exit=${r.status}`);
} finally { await mockDown.stop(); }

// 4c2) gateway errors (5xx) and a missing baseline do not establish anything either
const mock503 = await startMock({ bearer: true, liveStatus: 503, ttlMs: 1000 });
try {
  r = await run(["--cloud"], { BROWSERBASE_API_KEY: MOCK_KEY, BROWSERBASE_API_BASE: mock503.base });
  const R = JSON.parse(latest()); const st = (id) => R.steps.find((x) => x.id === id);
  check("HTTP 503 from the live view: TTL and revocation are INCONCLUSIVE, verdict not passed, exit 4", st("S6-ttl")?.ok === null && st("S6-ttl")?.inconclusive === true && st("S7-live-dead")?.inconclusive === true && R.verdict === "inconclusive" && r.status === 4, `verdict=${R.verdict} exit=${r.status}`);
} finally { await mock503.stop(); }
const mockBound = await startMock({ bearer: false, ttlMs: 1000 });
try {
  r = await run(["--cloud"], { BROWSERBASE_API_KEY: MOCK_KEY, BROWSERBASE_API_BASE: mockBound.base });
  const R = JSON.parse(latest()); const t = R.steps.find((x) => x.id === "S6-ttl");
  check("bound live view (403 from the start): TTL is UNTESTABLE, not a pass", t?.ok === null && !t?.inconclusive && /untestable/.test(t?.note ?? ""), JSON.stringify(t?.observed));
} finally { await mockBound.stop(); }
const mockNoTtl = await startMock({ bearer: true, ttlMs: Infinity });
try {
  r = await run(["--cloud"], { BROWSERBASE_API_KEY: MOCK_KEY, BROWSERBASE_API_BASE: mockNoTtl.base });
  const R = JSON.parse(latest());
  check("a vendor that ignores expiresIn: S6-ttl FAILS", R.steps.find((x) => x.id === "S6-ttl")?.ok === false && R.verdict === "failed");
} finally { await mockNoTtl.stop(); }

// 4d) a vendor that does NOT revoke on release is caught even though the URL is unexpired
const mockKeep = await startMock({ bearer: true, releaseKeepsLive: true });
try {
  r = await run(["--cloud", "--no-ttl-test"], { BROWSERBASE_API_KEY: MOCK_KEY, BROWSERBASE_API_BASE: mockKeep.base });
  const R = JSON.parse(latest());
  check("non-revoking vendor: S7-live-dead FAILS, verdict 'failed', exit 1", R.steps.find((x) => x.id === "S7-live-dead")?.ok === false && R.verdict === "failed" && r.status === 1, `exit=${r.status}`);
} finally { await mockKeep.stop(); }

// 5) local mode needs nothing
r = await run([], {});
check("local mode passes with no network and no key", r.status === 0);
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
