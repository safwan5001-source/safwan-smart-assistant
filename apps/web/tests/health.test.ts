import { describe, expect, it, vi } from "vitest";
import { buildHealth, readBackendUrl } from "@/server/health";

const OK = { status: "ok", version: "0.2.0", features: { assistant: false, connected_integrations: 0, task_execution: false } };
const reply = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const env = { BACKEND_URL: "http://safwan-api.railway.internal:8000" };

describe("readBackendUrl", () => {
  it("accepts plain http(s) origins and rejects everything else", () => {
    expect(readBackendUrl(env)?.href).toBe("http://safwan-api.railway.internal:8000/");
    for (const bad of [undefined, "", "   ", "not a url", "ftp://x", "file:///etc/passwd", "http://u:p@host", "http://host?x=1", "http://host#f"]) {
      expect(readBackendUrl({ BACKEND_URL: bad })).toBeNull();
    }
  });
});

describe("buildHealth (Next.js → FastAPI)", () => {
  it("is unconfigured and sends no request without BACKEND_URL", async () => {
    const f = vi.fn();
    expect(await buildHealth({ env: {}, fetchImpl: f as unknown as typeof fetch })).toEqual({ status: 503, body: { status: "degraded", web: "ok", backend: "unconfigured" } });
    expect(f).not.toHaveBeenCalled();
  });

  it("calls only <base>/health, without following redirects, and reports ok", async () => {
    const f = vi.fn(async () => reply(OK));
    const r = await buildHealth({ env, fetchImpl: f as unknown as typeof fetch });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", web: "ok", backend: "ok", version: "0.2.0", features: OK.features });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://safwan-api.railway.internal:8000/health");
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("GET");
  });

  it("keeps a path prefix on the base URL", async () => {
    const f = vi.fn(async () => reply(OK));
    await buildHealth({ env: { BACKEND_URL: "http://host:8000/svc/" }, fetchImpl: f as unknown as typeof fetch });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("http://host:8000/svc/health");
  });

  it.each([
    [301, "rejected"], [307, "rejected"], [401, "rejected"], [403, "rejected"],
    [429, "unavailable"], [500, "unavailable"], [503, "unavailable"], [404, "invalid_response"], [202, "invalid_response"],
  ] as const)("maps HTTP %i to %s", async (code, expected) => {
    const r = await buildHealth({ env, fetchImpl: (async () => reply("{}", code)) as unknown as typeof fetch });
    expect(r).toEqual({ status: 503, body: { status: "degraded", web: "ok", backend: expected } });
  });

  it("maps network failure and timeout to unreachable", async () => {
    expect((await buildHealth({ env, fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch })).body.backend).toBe("unreachable");
    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    expect((await buildHealth({ env, fetchImpl: hang, timeoutMs: 20 })).body.backend).toBe("unreachable");
  });

  it("rejects malformed, oversized or lying bodies", async () => {
    for (const body of ["<html>not json</html>", "x".repeat(70_000), { status: "degraded", features: OK.features }, { status: "ok" },
      { status: "ok", features: { assistant: "yes", task_execution: false, connected_integrations: 0 } }]) {
      const r = await buildHealth({ env, fetchImpl: (async () => reply(body)) as unknown as typeof fetch });
      expect(r).toEqual({ status: 503, body: { status: "degraded", web: "ok", backend: "invalid_response" } });
    }
  });

  it("counts bytes, not UTF-16 units: a multibyte body over 64 KB is rejected", async () => {
    const body = JSON.stringify({ ...OK, pad: "é".repeat(40_000) }); // ~40k chars but ~80 KB on the wire
    expect(body.length).toBeLessThan(64 * 1024);
    const r = await buildHealth({ env, fetchImpl: (async () => reply(body)) as unknown as typeof fetch });
    expect(r.body.backend).toBe("invalid_response");
  });

  it("stops reading and cancels an endless stream instead of buffering it", async () => {
    let pulled = 0, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(new Uint8Array(16 * 1024)); },
      cancel() { cancelled = true; },
    });
    const r = await buildHealth({ env, fetchImpl: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch });
    expect(r.body.backend).toBe("invalid_response");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10); // ~64 KB cap / 16 KB chunks, plus the queue's lookahead
  });

  it("rejects early on a declared Content-Length over the cap", async () => {
    const res = new Response("{}", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } });
    expect((await buildHealth({ env, fetchImpl: (async () => res) as unknown as typeof fetch })).body.backend).toBe("invalid_response");
  });

  it("never leaks the API address, status codes or error text", async () => {
    const r = await buildHealth({ env, fetchImpl: (async () => { throw new Error("connect ECONNREFUSED safwan-api.railway.internal:8000"); }) as unknown as typeof fetch });
    expect(JSON.stringify(r)).not.toMatch(/railway|internal|8000|ECONN/);
  });
});
