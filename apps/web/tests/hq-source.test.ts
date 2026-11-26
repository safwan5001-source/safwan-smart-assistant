import { describe, expect, it } from "vitest";
import { CORE_LINK_AR, HQ_SOURCE, coreLink } from "@/lib/hq/source";

describe("HQ data source (seam for the future BASHT Core Integration)", () => {
  it("is the simulation today — no connection to the engine exists yet", () => {
    expect(HQ_SOURCE).toBe("simulation");
    expect(CORE_LINK_AR.simulation).toContain("غير مربوط");
  });
  it("maps the engine's existing /healthz payload and fails closed on anything unexpected", () => {
    expect(coreLink({ ok: true, gateway: "ready" })).toBe("connected");
    expect(coreLink({ ok: true, gateway: "starting" })).toBe("starting");
    expect(coreLink({ ok: true, gateway: "unconfigured" })).toBe("offline");
    expect(coreLink({ ok: false, gateway: "ready" })).toBe("offline");
    expect(coreLink(null)).toBe("offline");
    expect(coreLink({ ok: true, gateway: "something-new" })).toBe("offline");
  });
});
