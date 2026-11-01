import { describe, expect, it, vi } from "vitest";
import { AssistantUnavailableError, createAssistantService } from "@/lib/assistant";
import { INTEGRATIONS } from "@/lib/integrations";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("assistant service", () => {
  it("reports online with the assistant OFF when /health says so", async () => {
    const svc = createAssistantService(async () => json({ status: "ok", version: "0.2.0", features: { assistant: false } }));
    expect(await svc.status()).toEqual({ server: "online", assistant: false, version: "0.2.0" });
  });
  it("treats an HTML 404 page (e.g. an unrouted /api path) as offline, not online", async () => {
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
  it("refuses to call respond() unless the server reported a configured assistant", async () => {
    const f = vi.fn();
    const svc = createAssistantService(f as unknown as typeof fetch);
    await expect(svc.respond([{ role: "user", content: "hi" }], { server: "offline" })).rejects.toBeInstanceOf(AssistantUnavailableError);
    await expect(svc.respond([{ role: "user", content: "hi" }], { server: "online", assistant: false, version: "1" })).rejects.toBeInstanceOf(AssistantUnavailableError);
    expect(f).not.toHaveBeenCalled();
  });
  it("returns the reply when configured and maps a 503 to a clear error", async () => {
    const ok = createAssistantService(async () => json({ content: "أهلاً" }));
    expect(await ok.respond([{ role: "user", content: "hi" }], { server: "online", assistant: true, version: "1" })).toBe("أهلاً");
    const bad = createAssistantService(async () => json({}, { status: 503 }));
    await expect(bad.respond([{ role: "user", content: "hi" }], { server: "online", assistant: true, version: "1" })).rejects.toThrow(/غير مفعّل/);
  });
});

describe("integrations catalogue", () => {
  it("ships every integration as planned (nothing is claimed connected)", () => {
    expect(INTEGRATIONS.every((i) => i.status === "planned")).toBe(true);
  });
});
