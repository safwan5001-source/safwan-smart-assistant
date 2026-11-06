import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BRAND, BRAND_ASSETS, SPLASH, splashImages } from "@/lib/brand";
import { KEYS, tasksStore } from "@/lib/stores";
import { AGENT_STATE_TEXT, SETTLE_MS, agentState, getAgentActivity, phaseForBrowser, phaseForQuick, setAgentPhase, type AgentState } from "@/lib/agent-activity";
import { dayBounds, remindersDueToday } from "@/lib/command-center";
import { VOICE_TEXT, voiceState } from "@/lib/voice-state";
import { runQuickCommand } from "@/lib/commands";
import { AgentOrb, VoiceOrb } from "@/components/ui";
import type { Reminder } from "@/lib/reminders";

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

describe("logo asset files: transparency where it belongs, opaque where iOS requires it", () => {
  /** PNG IHDR colour type: 2 = RGB (opaque), 6 = RGBA. Also returns width/height. */
  const png = (f: string) => { const b = readFileSync(pub(f)); expect(b.subarray(1, 4).toString()).toBe("PNG"); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: b[25] }; };
  /** WebP carries alpha if it is lossless (VP8L, alpha in the bitstream) or extended with the alpha flag (VP8X bit 0x10). */
  const webpHasAlpha = (f: string) => {
    const b = readFileSync(pub(f));
    expect(b.subarray(0, 4).toString() + b.subarray(8, 12).toString()).toBe("RIFFWEBP");
    const chunk = b.subarray(12, 16).toString();
    return chunk === "VP8L" || (chunk === "VP8X" && (b[20] & 0x10) !== 0);
  };

  it("UI marks and wordmarks are transparent (no white box on dark surfaces)", () => {
    for (const url of [BRAND_ASSETS.mark, BRAND_ASSETS.markSm, BRAND_ASSETS.wordmark, BRAND_ASSETS.wordmarkWhite, BRAND_ASSETS.logo]) expect(webpHasAlpha(url), url).toBe(true);
    for (const s of [16, 32, 48]) expect(png(`icons/favicon-${s}.png`)).toEqual({ w: s, h: s, type: 6 });
  });

  it("home-screen icons are opaque squares at the declared sizes (iOS fills transparency with black)", () => {
    expect(png("icons/apple-touch-icon.png")).toEqual({ w: 180, h: 180, type: 2 });
    expect(png("icons/icon-192.png")).toEqual({ w: 192, h: 192, type: 2 });
    expect(png("icons/icon-512.png")).toEqual({ w: 512, h: 512, type: 2 });
    expect(png("icons/icon-maskable-512.png")).toEqual({ w: 512, h: 512, type: 2 });
  });

  it("the generator guards fidelity itself: exact source pixels and a separate ب dot at every wordmark size", () => {
    const gen = readFileSync(join(WEB, "scripts/generate-brand-assets.py"), "utf8");
    expect(gen).toContain("check_untouched(SRC, raw)");
    for (const name of ["basht-wordmark.webp", "basht-wordmark-white.webp", "opengraph wordmark"]) expect(gen).toContain(`check_wordmark("${name}"`);
  });
});

describe("Command Center: «تذكيرات اليوم» covers today only", () => {
  const NOW = new Date(2026, 10, 6, 14, 30).getTime(); // local time
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const r = (id: string, dueAt: number, status: Reminder["status"] = "active"): Reminder =>
    ({ id, title: id, tz: "Asia/Riyadh", repeat: "none", time: "09:00", anchor: "2026-11-06", leadMinutes: 0, priority: "normal", status, dueAt, rev: 1, created: 0, updated: 0 });

  it("bounds are local midnight to the next local midnight", () => {
    const { start, end } = dayBounds(NOW);
    expect(start).toBe(at(6, 0));
    expect(end).toBe(at(7, 0));
  });

  it("counts from 00:00 through 23:59 today and nothing before or after", () => {
    const list = [
      r("yesterday-late", at(5, 23, 59)), r("midnight", at(6, 0)), r("morning-past", at(6, 9)), r("evening", at(6, 21)),
      r("last-minute", at(6, 23, 59)), r("tomorrow-midnight", at(7, 0)), r("next-week", at(13, 9)),
    ];
    expect(remindersDueToday(list, NOW).map((x) => x.id)).toEqual(["midnight", "morning-past", "evening", "last-minute"]);
  });

  it("includes fired (awaiting action) but not paused or completed reminders", () => {
    const list = [r("fired", at(6, 10), "fired"), r("paused", at(6, 11), "paused"), r("done", at(6, 12), "completed")];
    expect(remindersDueToday(list, NOW).map((x) => x.id)).toEqual(["fired"]);
  });

  it("the old rule (anything alerting before tonight, incl. overdue ones) is gone from the dashboard", () => {
    const src = readFileSync(join(WEB, "features/dashboard/dashboard-screen.tsx"), "utf8");
    expect(src).toContain("remindersDueToday(");
    expect(src).not.toMatch(/endOfDay/);
  });
});

describe("Command Center layout: the two-column span exists only where the grid has columns", () => {
  it("no inline grid-column span in the dashboard", () => {
    expect(readFileSync(join(WEB, "features/dashboard/dashboard-screen.tsx"), "utf8")).not.toMatch(/gridColumn/);
  });
  it("span-lg-2 is declared only inside the ≥1000px media query, scoped to the 3-column grid", () => {
    const css = readFileSync(join(WEB, "app/globals.css"), "utf8");
    const rules = css.match(/[^{}]*span-lg-2[^{}]*\{[^}]*\}/g) ?? [];
    expect(rules).toHaveLength(1);
    const rule = rules[0] ?? "";
    const before = css.slice(0, css.indexOf(rule));
    expect(before.slice(before.lastIndexOf("@media")).startsWith("@media (min-width: 1000px)")).toBe(true);
    expect(rule).toContain(".grid-lg-3 > .span-lg-2");
  });
});

describe("voice listening is kept apart from the agent's state", () => {
  it("maps the microphone only", () => {
    expect(voiceState({ supported: false, listening: false, error: "" })).toBe("unsupported");
    expect(voiceState({ supported: true, listening: true, error: "" })).toBe("listening");
    expect(voiceState({ supported: true, listening: false, error: "x" })).toBe("error");
    expect(voiceState({ supported: true, listening: false, error: "" })).toBe("ready");
  });

  it("the voice face never carries an agent state, and its copy never claims a reply", () => {
    for (const s of ["unsupported", "ready", "listening", "error"] as const) {
      const html = renderToStaticMarkup(createElement(VoiceOrb, { state: s }));
      expect(html).toContain(`data-voice="${s}"`);
      expect(html).not.toContain("data-state");
      expect(VOICE_TEXT[s].title + VOICE_TEXT[s].sub).not.toMatch(/يفكّر|يكتب الرد|يرد الآن/);
    }
    expect(renderToStaticMarkup(createElement(AgentOrb, { state: "ready" }))).not.toContain("data-voice");
    const screen = readFileSync(join(WEB, "features/calls/calls-screen.tsx"), "utf8");
    expect(screen).not.toMatch(/AgentOrb|"responding"/);
  });
});

describe("agent state: a Claude reply is not an executed task", () => {
  beforeEach(() => tasksStore.reset());
  afterEach(() => { setAgentPhase("idle"); vi.useRealTimers(); });

  it("falls back to connection status when nothing is in flight", () => {
    const idle = { phase: "idle" as const, at: 0 };
    expect(agentState({ server: "checking" }, idle)).toBe("connecting");
    expect(agentState({ server: "offline" }, idle)).toBe("offline");
    expect(agentState({ server: "online", assistant: false, version: "1" }, idle)).toBe("notes");
    expect(agentState({ server: "online", assistant: true, version: "1" }, idle)).toBe("ready");
  });

  it("reply and task outcomes have different labels, and the reply one says nothing was executed", () => {
    expect(AGENT_STATE_TEXT.replied.label).not.toBe(AGENT_STATE_TEXT.task_done.label);
    expect(AGENT_STATE_TEXT.reply_failed.label).not.toBe(AGENT_STATE_TEXT.task_failed.label);
    expect(AGENT_STATE_TEXT.replied.detail).toContain("لم يُنفَّذ");
    expect(AGENT_STATE_TEXT.task_done.detail).toContain("إجراء تنفيذي");
    const chat = readFileSync(join(WEB, "features/chat/chat-screen.tsx"), "utf8");
    expect(chat).toContain('setAgentPhase(out.stopped ? "stopped" : "replied")');
    expect(chat).not.toMatch(/setAgentPhase\("done"\)|"task_done"/); // the chat never claims a task from a reply
  });

  it("a quick command that really ran is a task outcome; invalid input is not", async () => {
    const ok = await runQuickCommand("/مهمة مراجعة عقود النقل");
    expect(ok.outcome).toBe("executed");
    expect(phaseForQuick(ok)).toBe("task_done");
    const typo = await runQuickCommand("/مهمة");
    expect(typo.outcome).toBeUndefined();
    expect(phaseForQuick(typo)).toBeNull();
    expect(phaseForQuick({ handled: true, reply: "سؤال توضيحي" })).toBeNull();
    expect(phaseForQuick({ handled: true, outcome: "failed" })).toBe("task_failed");
  });

  it("a browser card counts only on a real started → done transition (reopened cards re-report old outcomes)", () => {
    const started = { url: "", mode: "interactive" as const, state: "started" as const, taskId: "t" };
    expect(phaseForBrowser(started, { state: "done", outcome: "succeeded" })).toBe("task_done");
    expect(phaseForBrowser(started, { state: "done", outcome: "failed" })).toBe("task_failed");
    expect(phaseForBrowser(started, { state: "done", outcome: "cancelled" })).toBe("stopped");
    expect(phaseForBrowser({ ...started, state: "done", outcome: "succeeded" }, { state: "done", outcome: "succeeded" })).toBeNull();
    expect(phaseForBrowser({ ...started, state: "offer" }, { state: "started", taskId: "t" })).toBeNull();
    expect(phaseForBrowser(undefined, { state: "done", outcome: "succeeded" })).toBeNull();
  });

  it("outcomes are shown briefly, then the agent returns to idle", () => {
    vi.useFakeTimers();
    setAgentPhase("thinking");
    expect(agentState({ server: "online", assistant: true, version: "1" }, getAgentActivity())).toBe("thinking");
    for (const p of ["replied", "reply_failed", "task_done", "task_failed", "stopped"] as const) {
      setAgentPhase(p);
      expect(getAgentActivity().phase).toBe(p);
      vi.advanceTimersByTime(SETTLE_MS + 1);
      expect(getAgentActivity().phase).toBe("idle");
    }
  });

  it("has user-facing text for every state", () => {
    const all: AgentState[] = ["connecting", "offline", "notes", "ready", "thinking", "responding", "replied", "reply_failed", "stopped", "task_done", "task_failed"];
    for (const s of all) expect(AGENT_STATE_TEXT[s].label.length).toBeGreaterThan(0);
  });
});
