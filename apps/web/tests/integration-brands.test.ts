import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INTEGRATIONS } from "@/lib/integrations";
import { INTEGRATION_BRANDS, NEUTRAL_ICONS, brandFor } from "@/lib/integration-brands";

const publicFile = (src: string) => fileURLToPath(new URL("../public" + src, import.meta.url));

describe("integration brand layer", () => {
  it("has official artwork for every required service", () => {
    for (const id of ["github", "vercel", "railway", "gmail", "google_drive", "google_calendar"]) {
      expect(brandFor(id), id).toBeDefined();
      expect(INTEGRATIONS.some((i) => i.id === id), id).toBe(true);
    }
  });

  it("only references brands and files that exist", () => {
    const ids = new Set(INTEGRATIONS.map((i) => i.id));
    for (const [id, b] of Object.entries(INTEGRATION_BRANDS)) {
      expect(b.id).toBe(id);
      expect(ids.has(id), `unknown integration ${id}`).toBe(true);
      if (b.mark.kind === "image") expect(existsSync(publicFile(b.mark.src)), b.mark.src).toBe(true);
      else { expect(b.mark.path.length).toBeGreaterThan(20); expect(b.mark.color.light).toMatch(/^#[0-9a-f]{6}$/i); expect(b.mark.color.dark).toMatch(/^#[0-9a-f]{6}$/i); }
    }
    for (const id of Object.keys(NEUTRAL_ICONS)) expect(ids.has(id)).toBe(true);
  });

  it("leaves unbranded services to the neutral fallback", () => {
    expect(brandFor("daftra")).toBeUndefined();
    expect(brandFor("does-not-exist")).toBeUndefined();
  });
});
