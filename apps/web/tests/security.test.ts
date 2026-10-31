import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const walk = (dir: string): string[] =>
  (existsSync(dir) ? readdirSync(dir) : []).flatMap((n) => {
    if (["node_modules", ".next", "tests"].includes(n)) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|mjs|css)$/.test(n) ? [p] : [];
  });
const files = [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components")), join(root, "next.config.ts")]
  .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
const source = files.map((f) => [f, readFileSync(f, "utf8")] as const);

describe("browser bundle hygiene", () => {
  it("scans a meaningful amount of source", () => { expect(source.length).toBeGreaterThan(3); });
  it("exposes no secret-looking NEXT_PUBLIC_ variables", () => {
    for (const [f, s] of source) expect(s, f).not.toMatch(/NEXT_PUBLIC_\w*(KEY|SECRET|TOKEN|PASSWORD)/i);
  });
  it("contains no provider API keys or bearer literals", () => {
    for (const [f, s] of source) {
      expect(s, f).not.toMatch(/sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|Bearer\s+[A-Za-z0-9._-]{20,}/);
    }
  });
  it("does not reference server-only env vars", () => {
    for (const [f, s] of source) expect(s, f).not.toMatch(/DEV_AUTH_TOKEN|ENABLE_DEV_AUTH|ASSISTANT_PROVIDER/);
  });
});
