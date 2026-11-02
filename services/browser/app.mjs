// HTTP surface of the browser worker. Private network only (no public domain); every route except /health needs the shared bearer token.
//
//   GET  /health                       liveness, no secrets
//   POST /v1/jobs        {url}         start a read-only browsing job        -> 202 {job}   (429 busy, 400 URL not allowed)
//   GET  /v1/jobs/:id                  status, steps, result text             -> 200 {job}
//   GET  /v1/jobs/:id/screenshot       the JPEG of a finished job             -> image/jpeg
//   POST /v1/jobs/:id/cancel           really stop it (idempotent)            -> 200 {job}
//   POST /v1/jobs       {url, mode:"interactive"}   start an interactive session (needs BROWSER_INTERACTIVE_SCOPES; 403 interactive_disabled otherwise)
//   POST /v1/jobs/:id/actions        {tool, ...}   queue ONE action: navigate | click | type | observe   -> 202 {job}  (409 busy/limit/not_ready)
//   POST /v1/jobs/:id/actions/:n/approve|reject    decide the step that is waiting for the user
//   POST /v1/jobs/:id/finish                       end the session gracefully (cancel is the hard stop)
//   POST /v1/navigate    {url}         legacy synchronous call used by the owner smoke/read bridges (same policy, same single slot)
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { BusyError, createJobManager } from "./jobs.mjs";
import { createBrowse } from "./browse.mjs";
import { ActionError, LIMITS, parseAction } from "./actions.mjs";

const MAX_BODY = 2048;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createApp({ token, policy, client, projectId, connect, log = console.error, deadlineMs, ttlMs, limits = LIMITS, sessionCsp }) {
  if (!token || token.length < 32) throw new Error("BROWSER_SERVICE_TOKEN must be 32+ characters");
  // Visible ASCII only (no whitespace/newline): a stray trailing newline in the Railway variable can never match an Authorization header
  // (Node trims header values) and makes the API's http.client refuse to send it at all. Refuse to start rather than fail silently.
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("BROWSER_SERVICE_TOKEN must be visible ASCII only (no spaces, newlines or non-ASCII characters)");
  const expected = Buffer.from(token);
  const manager = createJobManager({ run: createBrowse({ client, projectId, policy, connect, log, ...(sessionCsp !== undefined ? { sessionCsp } : {}) }), deadlineMs, ttlMs, limits });

  const authorized = (header) => {
    if (!header?.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(header.slice(7));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const respond = (res, code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(obj));
  };
  async function readJson(req) {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) throw new Error("Request too large"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const isJson = (req) => req.headers["content-type"]?.split(";")[0].trim() === "application/json";

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    try {
      if (path === "/health" && req.method === "GET") return respond(res, 200, { status: "ok", browser: "configured" });

      const m = /^\/v1\/jobs(?:\/([^/]+)(?:\/(screenshot|cancel|finish|actions)(?:\/([0-9]{1,2})\/(approve|reject))?)?)?$/.exec(path);
      const isNavigate = path === "/v1/navigate";
      if (!m && !isNavigate) return respond(res, 404, { error: "not_found" });
      if (!authorized(req.headers.authorization)) return respond(res, 401, { error: "unauthorized" });

      if (isNavigate) {
        if (req.method !== "POST") return respond(res, 404, { error: "not_found" });
        if (!isJson(req)) return respond(res, 415, { error: "json_required" });
        if (manager.isBusy()) return respond(res, 429, { error: "busy" });
        let target;
        try { const input = await readJson(req); target = policy.parseTarget(input.url); } catch { return respond(res, 400, { error: "invalid_request" }); }
        let job;
        try { job = manager.create(target); } catch (e) { if (e instanceof BusyError) return respond(res, 429, { error: "busy" }); throw e; }
        await job.done;
        if (job.status !== "succeeded") return respond(res, 502, { ok: false, error: "browser_execution_failed" });
        const r = job.result;
        return respond(res, 200, { ok: true, title: r.title, url: r.url, excerpt: r.excerpt,
          screenshot: { mimeType: "image/jpeg", base64: r.screenshot.toString("base64"), bytes: r.screenshot.length } });
      }

      const [, id, action, seqText, decision] = m;
      if (!id) { // collection
        if (req.method !== "POST") return respond(res, 404, { error: "not_found" });
        if (!isJson(req)) return respond(res, 415, { error: "json_required" });
        if (manager.isBusy()) return respond(res, 429, { error: "busy" });
        let target, mode = "read";
        try {
          const input = await readJson(req);
          if (input.mode !== undefined && input.mode !== "interactive") throw new Error("mode");
          if (input.mode === "interactive") {
            if (!policy.scopes.length) return respond(res, 403, { error: "interactive_disabled" }); // no lab scope configured: control stays OFF
            mode = "interactive"; target = policy.parseSessionTarget(input.url);
          } else target = policy.parseTarget(input.url);
        } catch { return respond(res, 400, { error: "invalid_request" }); }
        try { return respond(res, 202, { job: manager.view(manager.create(target, { mode })) }); }
        catch (e) { if (e instanceof BusyError) return respond(res, 429, { error: "busy" }); throw e; }
      }
      if (!ID_RE.test(id)) return respond(res, 404, { error: "not_found" });
      if (!action && req.method === "GET") {
        const job = manager.get(id);
        return job ? respond(res, 200, { job: manager.view(job) }) : respond(res, 404, { error: "not_found" });
      }
      if (action === "screenshot" && req.method === "GET") {
        const shot = manager.screenshot(id);
        if (!shot) return respond(res, 404, { error: "not_found" });
        res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": shot.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        return res.end(shot);
      }
      if (action === "actions" && req.method === "POST") {
        try {
          if (seqText === undefined) { // queue a new action
            if (!isJson(req)) return respond(res, 415, { error: "json_required" });
            const parsed = parseAction(await readJson(req), policy.parseSessionTarget);
            return respond(res, 202, { job: manager.view(manager.submitAction(id, parsed)) });
          }
          return respond(res, 200, { job: manager.view(manager.decide(id, Number(seqText), decision === "approve")) });
        } catch (e) {
          if (e instanceof ActionError) return respond(res, e.status, { error: e.code });
          return respond(res, 400, { error: "invalid_request" });
        }
      }
      if (action === "finish" && req.method === "POST") {
        const job = manager.finish(id);
        return job ? respond(res, 200, { job: manager.view(job) }) : respond(res, 404, { error: "not_found" });
      }
      if (action === "cancel" && req.method === "POST") {
        const job = manager.cancel(id);
        return job ? respond(res, 200, { job: manager.view(job) }) : respond(res, 404, { error: "not_found" });
      }
      return respond(res, 404, { error: "not_found" });
    } catch {
      return respond(res, 400, { error: "invalid_request" }); // never echo an exception message
    }
  });
  server.requestTimeout = 60_000;
  return { server, manager };
}
