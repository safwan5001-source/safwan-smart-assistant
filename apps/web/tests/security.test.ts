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
const CLIENT_DIRS = ["lib", "components", "features"];
const files = [...walk(join(root, "app")), ...CLIENT_DIRS.flatMap((d) => walk(join(root, d))), join(root, "next.config.ts")]
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
    for (const [f, s] of source) expect(s, f).not.toMatch(/DEV_AUTH_TOKEN|ENABLE_DEV_AUTH|ASSISTANT_PROVIDER|SERVICE_AUTH_SECRET|BACKEND_URL|DATABASE_URL/);
  });
  it("keeps the server tier out of anything a browser can load", () => {
    const clientish = source.filter(([f]) => !/[\\/]app[\\/]api[\\/]/.test(f));
    for (const [f, s] of clientish) expect(s, f).not.toMatch(/from\s+["']@\/server\/|from\s+["'][./]+\/server\//);
  });
  it("marks every server module server-only so a client import fails the build", () => {
    const serverFiles = walk(join(root, "server"));
    expect(serverFiles.length).toBeGreaterThan(2);
    for (const f of serverFiles) expect(readFileSync(f, "utf8"), f).toMatch(/^import "server-only";/m);
  });
  it("every API route exports exactly the HTTP methods it is allowed to, and never accepts a backend target from the request", () => {
    // Independent review IR-W5: the previous check only matched `export function POST|PUT|...`, so
    // `export { handler as POST }` (what the notify route uses) went unnoticed and the test passed vacuously.
    const METHOD = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS";
    const exportedMethods = (src: string): string[] => {
      const found = new Set<string>();
      for (const m of src.matchAll(new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+(${METHOD})\\b`, "g"))) found.add(m[1]);
      for (const block of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const m of block[1].matchAll(new RegExp(`\\bas\\s+(${METHOD})\\b|(?:^|,)\\s*(${METHOD})\\s*(?:,|$)`, "g"))) found.add(m[1] ?? m[2]);
      }
      return [...found].sort();
    };
    // The notification API is the only route with writes (bearer-token devices, see docs/NOTIFICATIONS.md); everything else is GET only.
    const allowed = (f: string): string[] => (/[\\/]api[\\/]notify[\\/]/.test(f) ? ["DELETE", "GET", "POST", "PUT"] : ["GET"]);
    const routes = walk(join(root, "app", "api")).filter((f) => /route\.ts$/.test(f));
    expect(routes.length).toBeGreaterThan(0);
    for (const f of routes) {
      const s = readFileSync(f, "utf8");
      expect(exportedMethods(s), f).toEqual(allowed(f));
      expect(s, f).not.toMatch(/searchParams|request\.url|req\.url|\.json\(\)/);
    }
  });
});
