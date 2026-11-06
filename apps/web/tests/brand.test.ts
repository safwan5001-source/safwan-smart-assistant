import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAND, BRAND_ASSETS, SPLASH, splashImages } from "@/lib/brand";
import { KEYS } from "@/lib/stores";
import { AGENT_STATE_TEXT, SETTLE_MS, agentState, getAgentActivity, setAgentPhase } from "@/lib/agent-activity";

const WEB = resolve(__dirname, "..");
const pub = (url: string) => join(WEB, "public", url);

describe("BASHT brand contract", () => {
  it("keeps every historical storage key, so existing on-device data still loads", () => {
    expect(KEYS).toEqual({
      tasks: "safwan-local-tasks-v1", chats: "safwan-local-chats-v1", activity: "safwan-local-activity-v1",
      theme: "safwan-theme", compact: "safwan-compact", permission: "safwan-permission",
      reminders: "safwan-reminders-v1", notices: "safwan-notices-v1", notifyPrefs: "safwan-notify-prefs-v1",
      fired: "safwan-fired-v1", pushDevice: "safwan-push-device-v1", tombstones: "safwan-reminder-tombstones-v1",
    });
    expect(readFileSync(join(WEB, "lib/files-db.ts"), "utf8")).toContain('"safwan-files-v1"');
  });

  it("ships every asset it references (official-logo derivatives, icons, launch screens)", () => {
    for (const url of Object.values(BRAND_ASSETS)) expect(existsSync(pub(url)), url).toBe(true);
    for (const f of ["icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/favicon-16.png", "icons/favicon-32.png"]) expect(existsSync(pub(f)), f).toBe(true);
    const images = splashImages();
    expect(images).toHaveLength(SPLASH.length * 2);
    for (const { url, media } of images) {
      expect(existsSync(pub(url)), url).toBe(true);
      expect(media).toMatch(/^\(device-width: \d+px\) and \(device-height: \d+px\) and \(-webkit-device-pixel-ratio: [23]\) and \(orientation: portrait\) and \(prefers-color-scheme: (light|dark)\)$/);
    }
    expect(existsSync(join(WEB, "../../docs/brand/source/basht-logo-primary-official.png"))).toBe(true);
  });

  it("no longer shows the old product name anywhere in the UI source", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|js|css|json)$/.test(name) && /مساعد صفوان/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    for (const d of ["app", "components", "features", "lib", "public", "server"]) walk(join(WEB, d));
    expect(hits).toEqual([]);
    expect(BRAND.full).toBe("باشت | BASHT");
  });
});

describe("agent state is derived from real signals only", () => {
  afterEach(() => { setAgentPhase("idle"); vi.useRealTimers(); });

  it("falls back to connection status when nothing is in flight", () => {
    const idle = { phase: "idle" as const, at: 0 };
    expect(agentState({ server: "checking" }, idle)).toBe("connecting");
    expect(agentState({ server: "offline" }, idle)).toBe("offline");
    expect(agentState({ server: "online", assistant: false, version: "1" }, idle)).toBe("notes");
    expect(agentState({ server: "online", assistant: true, version: "1" }, idle)).toBe("ready");
  });

  it("shows work only while it happens, and outcomes only briefly", () => {
    vi.useFakeTimers();
    setAgentPhase("thinking");
    expect(agentState({ server: "online", assistant: true, version: "1" }, getAgentActivity())).toBe("thinking");
    setAgentPhase("failed");
    expect(getAgentActivity().phase).toBe("failed");
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(getAgentActivity().phase).toBe("idle");
  });

  it("has user-facing text for every state", () => {
    for (const s of ["connecting", "offline", "notes", "ready", "thinking", "responding", "done", "failed", "stopped"] as const) {
      expect(AGENT_STATE_TEXT[s].label.length).toBeGreaterThan(0);
    }
  });
});
