import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineDetails, StatusBadge, StatusRow } from "@/features/settings/system-status";
import { parseEngineStatus, unknownEngineStatus } from "@/lib/engine-status";
import { STATUS_LABEL, STATUS_LEVELS, UNKNOWN_READING } from "@/lib/status-model";

const SRC = (p: string) => readFileSync(join(resolve(__dirname, ".."), p), "utf8");
const NOW = 1_800_000_000_000;

describe("the badge: icon + text, success colour only for tested_ok", () => {
  it("every level renders its own Arabic text and an svg icon; only tested_ok carries the success class", () => {
    for (const level of STATUS_LEVELS) {
      const html = renderToStaticMarkup(createElement(StatusBadge, { r: { level, checkedAt: NOW } }));
      expect(html, level).toContain(STATUS_LABEL[level]);
      expect(html, level).toContain("<svg");
      expect(/class="badge ok"/.test(html), level).toBe(level === "tested_ok");
    }
  });
  it("no data renders «غير معروف» and no coloured class at all", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { r: UNKNOWN_READING }));
    expect(html).toContain("غير معروف");
    expect(html).toMatch(/class="badge "/);
    expect(html).not.toMatch(/badge (ok|info|warn|danger)/);
  });
  it("a row says when it was last checked, or that it never was", () => {
    const never = renderToStaticMarkup(createElement(StatusRow, { title: "الصوت", r: UNKNOWN_READING, now: NOW }));
    expect(never).toContain("لم يُفحص بعد");
    const seen = renderToStaticMarkup(createElement(StatusRow, { title: "الخادم", r: { level: "tested_ok", checkedAt: NOW - 1000, detail: "الإصدار 1" }, now: NOW }));
    expect(seen).toContain("الإصدار 1");
    expect(seen).toContain("آخر فحص");
  });
});

describe("engine details: only what the engine sent", () => {
  it("nothing from the engine = one calm line, no table of empty values", () => {
    for (const snap of [{ status: null, at: 0 }, { status: unknownEngineStatus(), at: NOW }]) {
      const html = renderToStaticMarkup(createElement(EngineDetails, { snap }));
      expect(html).toContain("لا بيانات من المحرك الآن");
      expect(html).not.toContain("<li");
    }
  });
  it("shows the version, the build, the link, the signing mode, the limits in MB and the capability ids; never a path, host or raw error", () => {
    const status = parseEngineStatus({ ok: true, engine: { version: "2026.5.1", host: "engine.internal" }, wrapper: { commit: "0123456789ab" }, link: { state: "up", lastError: "ws://10.0.0.1" },
      signing: { mode: "optional", active: true, reason: "/run/secret" }, features: ["voice.speak.v2", "media.guard.v1"], attachments: { maxImages: 8, maxImageBytes: 10_485_760 } });
    const html = renderToStaticMarkup(createElement(EngineDetails, { snap: { status, at: NOW } }));
    for (const want of ["2026.5.1", "0123456789ab", "متصل", "اختياري", "voice.speak.v2", "media.guard.v1", "حتى 8 صور", "10 ميجابايت"]) expect(html, want).toContain(want);
    for (const leak of ["engine.internal", "10.0.0.1", "/run/secret", "lastError"]) expect(html, leak).not.toContain(leak);
  });
  it("absent fields are not shown at all (no «غير معروف» filler rows for an older engine)", () => {
    const html = renderToStaticMarkup(createElement(EngineDetails, { snap: { status: parseEngineStatus({ ok: true, wrapper: { commit: null } }), at: NOW } }));
    expect(html).not.toContain("إصدار المحرك");
    expect(html).not.toContain("حدود المرفقات");
    expect(html).not.toContain("القدرات المعلنة");
  });
});

// Source-contract checks: WEAKER than the behavioural tests above (they read the screens' source, they do not render them).
describe("source contract (weaker): no hand-written badge is left in the screens", () => {
  const settings = SRC("features/settings/settings-screen.tsx");
  const dashboard = SRC("features/dashboard/dashboard-screen.tsx");
  const integrations = SRC("features/integrations/integrations-screen.tsx");
  it("settings: the old hard-coded rows and the direct-Claude badge are gone from the main screen; the legacy section is labelled", () => {
    for (const old of ["Windows السحابي", "الحساب والمصادقة", "لا حساب ولا مزامنة بعد", "Claude (الذكاء الاصطناعي)", "aiReady"]) expect(settings, old).not.toContain(old);
    expect(settings).toContain("<SystemStatus />");
    expect(settings).toContain("حول ← التكاملات القديمة");
    expect(settings.indexOf("<ClaudeSettings />")).toBeGreaterThan(settings.indexOf("حول ← التكاملات القديمة"));
  });
  it("dashboard: no «0 من 8», no Claude row, no fixed «قيد التخطيط» or «غير متاحة» badge; the rows come from readings", () => {
    for (const old of ["قيد التخطيط", "مخطط لها", "plannedIntegrations", "connectedIntegrations", "المزامنة", "<strong>Claude</strong>"]) expect(dashboard, old).not.toContain(old);
    expect(dashboard).toMatch(/useReadings\(/);
    expect(dashboard).toContain("جاهزية باشت");
  });
  it("integrations: no hand-written catalogue and no «مخطَّط» list; the engine's capabilities are the source", () => {
    expect(integrations).not.toContain("INTEGRATIONS");
    expect(integrations).not.toContain("قيد التخطيط");
    expect(integrations).toContain("<BashtCapabilities />");
  });
  it("the legacy direct-Claude section no longer calls itself BASHT's main provider", () => {
    const claude = SRC("features/settings/claude-settings.tsx");
    expect(claude).not.toContain("المزوّد الأساسي لباشت");
    expect(claude).toContain("قديم");
  });
});
