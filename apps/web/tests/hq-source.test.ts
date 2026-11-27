import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_LINK_AR, CORE_STATES, coreLive, parseCoreState } from "@/lib/hq/source";

describe("HQ data source (BASHT Core Integration, step C1: engine status only)", () => {
  it("accepts only the API's known engine states and fails closed on anything else", () => {
    for (const s of CORE_STATES) expect(parseCoreState(s)).toBe(s);
    expect(parseCoreState(undefined)).toBe("unconfigured");
    expect(parseCoreState("ready")).toBe("offline");
    expect(parseCoreState(1)).toBe("offline");
  });
  it("presents BASHT as live only when the engine is connected, and says so honestly otherwise", () => {
    expect(coreLive("connected")).toBe(true);
    for (const s of ["unconfigured", "starting", "offline", "checking"] as const) expect(coreLive(s)).toBe(false);
    expect(CORE_LINK_AR.unconfigured).toContain("غير مربوط");
    expect(CORE_LINK_AR.offline).toContain("تعذّر");
  });
  it("the HQ receives the state as a prop from one wrapper outside the HQ (the HQ itself still never fetches)", () => {
    const page = readFileSync(resolve(__dirname, "../app/hq/page.tsx"), "utf8");
    expect(page).toMatch(/import HqLive from "@\/features\/basht-core\/hq-live"/);
    const live = readFileSync(resolve(__dirname, "../features/basht-core/hq-live.tsx"), "utf8");
    expect(live).toMatch(/useAssistant\(\)/);
    expect(live).not.toMatch(/\bfetch\s*\(/);
  });
});
