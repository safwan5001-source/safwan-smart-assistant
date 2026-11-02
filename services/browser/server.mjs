import { createClient } from "../../poc/smoke1/browserbase.mjs";
import { createApp } from "./app.mjs";
import { createPolicy, parseScopes } from "./policy.mjs";

const port = Number(process.env.PORT || 8080);
const token = process.env.BROWSER_SERVICE_TOKEN;
const apiKey = process.env.BROWSERBASE_API_KEY;
const projectId = process.env.BROWSERBASE_PROJECT_ID;
if (!token || token.length < 32 || !apiKey || !projectId) {
  console.error("Browser service requires BROWSER_SERVICE_TOKEN (32+ chars), BROWSERBASE_API_KEY, and BROWSERBASE_PROJECT_ID");
  process.exit(1);
}
// Interactive control (click/type) exists only inside these `host/prefix/` scopes. Empty (the default) = OFF. An invalid entry refuses to start.
let scopes;
try { scopes = parseScopes((process.env.BROWSER_INTERACTIVE_SCOPES || "").split(",")); } catch { console.error("BROWSER_INTERACTIVE_SCOPES is invalid (expected host/prefix/ entries)"); process.exit(1); }
const policy = createPolicy((process.env.BROWSER_ALLOWED_HOSTS || "example.com").split(","), scopes);
// External egress proxy (docs/BROWSERBASE-EGRESS.md): the only control that can cover sub-resource / prerender / preconnect / WebSocket traffic.
// Interactive scopes are refused unless it is configured: fail closed, never "interactive without egress control".
const proxyServer = process.env.BROWSER_EGRESS_PROXY_SERVER;
let sessionOptions;
if (proxyServer) {
  const { BROWSER_EGRESS_PROXY_USERNAME: username, BROWSER_EGRESS_PROXY_PASSWORD: password } = process.env;
  if (!/^https?:\/\//.test(proxyServer) || !username || !password) { console.error("BROWSER_EGRESS_PROXY_* is invalid (server http(s)://…, username and password are required)"); process.exit(1); }
  sessionOptions = { proxies: [{ type: "external", server: proxyServer, username, password }], allowedDomains: [...new Set([...policy.hosts, ...policy.scopes.map((s) => s.split("/")[0])])] };
}
if (policy.scopes.length && !sessionOptions) { console.error("BROWSER_INTERACTIVE_SCOPES requires BROWSER_EGRESS_PROXY_SERVER/USERNAME/PASSWORD (egress control); refusing to start"); process.exit(1); }
const { server, manager } = createApp({ token, policy, client: createClient({ apiKey }), projectId, ...(sessionOptions ? { sessionOptions } : {}) });

server.listen(port, "0.0.0.0", () => console.log("safwan-browser listening"));

// A redeploy must not leave a paid cloud browser session open: cancel the active job and wait for its release first.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    server.close();
    await manager.shutdown();
    process.exit(0);
  });
}
