import { describe, expect, it, vi } from "vitest";
import { AssistantRequestError, createAssistantService } from "@/lib/assistant";
import { INTEGRATIONS } from "@/lib/integrations";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("assistant service", () => {
  it("reports online with the assistant OFF when /health says so", async () => {
    const svc = createAssistantService(async () => json({ status: "ok", version: "0.2.0", features: { assistant: false } }));
    expect(await svc.status()).toEqual({ server: "online", assistant: false, version: "0.2.0" });
  });
  it("probes the BFF health route, not a public backend path", async () => {
    const f = vi.fn(async () => json({ status: "ok", features: { assistant: false } }));
    await createAssistantService(f as unknown as typeof fetch).status();
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("/api/health");
  });
  it("treats the BFF's degraded 503 as offline", async () => {
    const svc = createAssistantService(async () => json({ status: "degraded", web: "ok", backend: "unconfigured" }, { status: 503 }));
    expect(await svc.status()).toEqual({ server: "offline" });
  });
  it("treats an HTML 404 page (e.g. unrouted /backend) as offline, not online", async () => {
    const svc = createAssistantService(async () => new Response("<html>404</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await svc.status()).toEqual({ server: "offline" });
  });
  it("treats network errors and non-ok as offline", async () => {
    expect(await createAssistantService(async () => { throw new Error("net"); }).status()).toEqual({ server: "offline" });
    expect(await createAssistantService(async () => json({ status: "ok" }, { status: 500 })).status()).toEqual({ server: "offline" });
    expect(await createAssistantService(async () => json({ status: "degraded" })).status()).toEqual({ server: "offline" });
  });
  it("only enables the assistant on an explicit boolean true", async () => {
    const svc = createAssistantService(async () => json({ status: "ok", features: { assistant: "yes" } }));
    expect(await svc.status()).toMatchObject({ assistant: false });
  });
  it("maps failures to fixed Arabic messages, never upstream text", async () => {
    const bad = createAssistantService(async () => json({ error: "budget_daily", detail: "SECRET upstream text" }, { status: 429 }));
    const e = await bad.chat("11111111-1111-4111-8111-111111111111", "hi").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AssistantRequestError);
    expect((e as AssistantRequestError).code).toBe("budget_daily");
    expect((e as Error).message).toMatch(/حد التكلفة اليومي/);
    expect((e as Error).message).not.toMatch(/SECRET/);
  });
});

const ID = "11111111-1111-4111-8111-111111111111";
const ndjson = (lines: unknown[], delayEnd = false) => {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + "\n")); if (!delayEnd) c.close(); },
  }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
};

describe("assistant streaming client", () => {
  it("delivers deltas as they arrive and returns usage on done", async () => {
    const f = vi.fn(async () => ndjson([{ type: "start" }, { type: "delta", text: "مر" }, { type: "delta", text: "حبا" }, { type: "done", usage: { input_tokens: 3, output_tokens: 2, cost_usd: 0.0001 } }]));
    const seen: string[] = [];
    const out = await createAssistantService(f as unknown as typeof fetch).chat(ID, "hi", { onDelta: (_t, all) => seen.push(all) });
    expect(seen).toEqual(["مر", "مرحبا"]);
    expect(out).toEqual({ text: "مرحبا", stopped: false, usage: { input_tokens: 3, output_tokens: 2, cost_usd: 0.0001 } });
    const [url, init] = (f.mock.calls[0] as unknown as [string, RequestInit]);
    expect(url).toBe("/api/assistant/chat");
    expect(JSON.parse(String(init.body))).toEqual({ conversationId: ID, message: "hi" });
  });
  it("handles chunks split in the middle of a line and of a UTF-8 character", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "delta", text: "صفوان" }) + "\n" + JSON.stringify({ type: "done" }) + "\n");
    const res = new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }), { status: 200 });
    expect((await createAssistantService((async () => res) as unknown as typeof fetch).chat(ID, "x")).text).toBe("صفوان");
  });
  it("surfaces a mid-stream error with the partial text, and treats a stream with no 'done' as a failure", async () => {
    const withErr = createAssistantService((async () => ndjson([{ type: "delta", text: "نصف" }, { type: "error", code: "provider_busy" }])) as unknown as typeof fetch);
    const e = await withErr.chat(ID, "x").catch((x: unknown) => x) as AssistantRequestError & { partial: string };
    expect(e.code).toBe("provider_busy"); expect(e.partial).toBe("نصف");
    const cut = createAssistantService((async () => ndjson([{ type: "delta", text: "نصف" }])) as unknown as typeof fetch);
    const e2 = await cut.chat(ID, "x").catch((x: unknown) => x) as AssistantRequestError & { partial: string };
    expect(e2).toBeInstanceOf(AssistantRequestError); expect(e2.partial).toBe("نصف");
  });
  it("Stop: aborting returns the partial text as stopped and cancels the request", async () => {
    const ctl = new AbortController();
    let cancelled = false;
    const f = (async (_u: string, init: RequestInit) => {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(c) { c.enqueue(enc.encode(JSON.stringify({ type: "delta", text: "جزء" }) + "\n")); init.signal?.addEventListener("abort", () => { cancelled = true; c.error(new DOMException("aborted", "AbortError")); }); },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await createAssistantService(f).chat(ID, "x", { signal: ctl.signal, onDelta: () => ctl.abort() });
    expect(cancelled).toBe(true);
    expect(out).toEqual({ text: "جزء", stopped: true });
  });
  it("network failure is a clear error", async () => {
    const e = await createAssistantService((async () => { throw new Error("net"); }) as unknown as typeof fetch).chat(ID, "x").catch((x: unknown) => x);
    expect((e as AssistantRequestError).code).toBe("network");
  });
});

describe("integrations catalogue", () => {
  it("ships every integration as planned (nothing is claimed connected)", () => {
    expect(INTEGRATIONS.every((i) => i.status === "planned")).toBe(true);
  });
});
