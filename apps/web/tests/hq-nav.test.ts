import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { morePathsFor, navFor, tabsFor } from "@/lib/nav";
import { HQ_ENABLED } from "@/lib/hq/flag";
import { PREFS_KEY } from "@/features/hq/hq-state";

const WEB = resolve(__dirname, "..");
const hrefs = (items: { href: string }[]) => items.map((i) => i.href);

describe("navigation with the HQ flag", () => {
  it("HQ off: the bottom bar is exactly what shipped before (no regression)", () => {
    expect(hrefs(tabsFor(false))).toEqual(["/", "/tasks", "/chat", "/files", "/more"]);
    expect(hrefs(navFor(false))).not.toContain("/hq");
    expect(morePathsFor(false)).not.toContain("/files");
  });
  it("HQ on: الرئيسية · المهام · باشت · المقر · المزيد, with الملفات moved into المزيد", () => {
    expect(hrefs(tabsFor(true))).toEqual(["/", "/tasks", "/chat", "/hq", "/more"]);
    expect(tabsFor(true).map((t) => t.label)).toEqual(["الرئيسية", "المهام", "المحادثات", "المقر", "المزيد"]);
    expect(morePathsFor(true)).toContain("/files");
    // الملفات is never removed: still a route, still in the sidebar / More list
    expect(hrefs(navFor(true))).toContain("/files");
    expect(hrefs(navFor(true))).toContain("/hq");
  });
  it("is off unless the build sets NEXT_PUBLIC_HQ_ENABLED=1 (and the test run does not set it)", () => {
    expect(process.env.NEXT_PUBLIC_HQ_ENABLED).toBeUndefined();
    expect(HQ_ENABLED).toBe(false);
    expect(readFileSync(join(WEB, "lib/hq/flag.ts"), "utf8")).toMatch(/process\.env\.NEXT_PUBLIC_HQ_ENABLED === "1"/);
  });
});

describe("HQ isolation (simulation only — no real data, no network)", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
  const hqFiles = [...files(join(WEB, "lib/hq")), ...files(join(WEB, "features/hq")), join(WEB, "app/hq/page.tsx")];

  it("never imports the owner's stores, commands, server code or assistant client", () => {
    for (const f of hqFiles) {
      const src = readFileSync(f, "utf8");
      // static AND dynamic imports, including sub-paths
      expect(src, f).not.toMatch(/(from\s+|import\s*\(\s*)["']@\/lib\/(stores|commands|storage|assistant|files-db|notifications|reminders|push-client|browser-client|agent-activity)(["'/])/);
      expect(src, f).not.toMatch(/(from\s+|import\s*\(\s*)["'](@\/server|@\/app\/api)/);
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
    }
  });
  it("loads no third-party script or asset at runtime (no CDN, only same-origin paths)", () => {
    for (const f of hqFiles) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/https?:\/\/(?!www\.w3\.org)|\/\/cdn\./);
      // every loader input is a same-origin path from the generated manifest or the brand assets
      for (const m of src.matchAll(/useLoader\([^,]+,\s*([^,)]+)/g)) expect(m[1], f).toMatch(/assetUrl|URLS|BRAND_ASSETS/);
    }
  });
  it("adds exactly one storage key, for display preferences only", () => {
    expect(PREFS_KEY).toBe("safwan-hq-prefs");
    const keys = hqFiles.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/["'](safwan-[a-z0-9-]+)["']/g)].map((m) => m[1]));
    expect([...new Set(keys)]).toEqual(["safwan-hq-prefs"]);
  });
  it("keeps the 3D engine out of every other page (loaded only by /hq on demand)", () => {
    for (const f of files(WEB).filter((p) => !p.includes("node_modules") && !p.includes("/.next/") && !p.includes("/features/hq/") && !p.includes("/lib/hq/") && !p.includes("/tests/"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from\s+["'](three|@react-three\/fiber|camera-controls)/);
    }
    const screen = readFileSync(join(WEB, "features/hq/hq-screen.tsx"), "utf8");
    expect(screen).toMatch(/dynamic\(\(\) => import\("\.\/scene\/hq-canvas"\), \{\s*ssr: false/);
    expect(screen).not.toMatch(/from\s+["']three/);
  });
});
