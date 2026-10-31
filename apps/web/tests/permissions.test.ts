import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODES, RISKS, evaluate } from "@/lib/permissions";

const shared = JSON.parse(readFileSync(new URL("../../../shared/permission-matrix.json", import.meta.url), "utf8")) as {
  matrix: { mode: never; risk: never; verdict: string }[];
};

describe("permission policy", () => {
  it("matches shared/permission-matrix.json (same file the API tests use)", () => {
    expect(shared.matrix).toHaveLength(MODES.length * RISKS.length);
    for (const row of shared.matrix) expect(evaluate(row.mode, row.risk)).toBe(row.verdict);
  });
  it("never auto-allows sensitive actions", () => {
    for (const m of MODES) expect(evaluate(m, "sensitive")).not.toBe("allow");
  });
});
