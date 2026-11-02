import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { installBrowser } from "./setup";
import { runCommand, runQuickCommand } from "@/lib/commands";
import { activityStore, firedStore, noticesStore, prefsStore, remindersStore, tasksStore } from "@/lib/stores";
import { DEFAULT_PREFS, parsePrefs } from "@/lib/notify-prefs";
import { filterNotices, insertNotice, parseNotices, safeHref, unreadCount, type Notice } from "@/lib/notifications";
import { inQuietHours, quietEnd, shouldHold, parseQuiet } from "@/lib/quiet-hours";
import { SOUNDS, CATEGORIES, DEFAULT_TONES, parseTones } from "@/lib/sounds";
import { createAudioPlayer } from "@/lib/audio";
import { arabicNumber, arabicVoice, createSpeaker, durationPhrase, spokenReminder } from "@/lib/speak";
import { deliverAlert, categoryFor } from "@/lib/alerts";
import { runDueReminders } from "@/lib/reminder-engine";
import { createReminder } from "@/lib/reminders";

const riyadh = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h - 3, mi);
const reset = () => { installBrowser(); for (const s of [tasksStore, remindersStore, noticesStore, firedStore, activityStore, prefsStore]) s.reset(); };
beforeEach(reset);

const fakeAudio = (result: "ok" | "blocked" | "error" = "ok") => {
  const plays: { src: string; volume: number }[] = [];
  const create = (src: string) => ({
    src, volume: 1, preload: "", currentTime: 0, pause() {},
    async play() { if (result === "blocked") throw Object.assign(new Error("x"), { name: "NotAllowedError" }); if (result === "error") throw new Error("boom"); plays.push({ src, volume: this.volume }); },
  });
  return { plays, create };
};

describe("sound catalogue = four original, light, valid files", () => {
  const dir = resolve(__dirname, "../public/sounds");
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as { id: string; file: string; durationMs: number; bytes: number; sha256: string }[];
  it("has exactly the four required tones with matching files", () => {
    expect(SOUNDS.map((s) => s.name)).toEqual(["Notification Soft", "Reminder Bell", "Critical Alert", "Success Tone"]);
    expect(manifest.map((m) => m.id)).toEqual(SOUNDS.map((s) => s.id));
    for (const s of SOUNDS) expect(existsSync(resolve(dir, "..", s.file.slice(1)))).toBe(true);
  });
  it("files are real MP3s, small, and match the manifest checksum", () => {
    for (const m of manifest) {
      const buf = readFileSync(resolve(dir, "..", m.file.slice(1)));
      expect(statSync(resolve(dir, "..", m.file.slice(1))).size).toBe(m.bytes);
      expect(buf.length).toBeLessThanOrEqual(24 * 1024);
      expect(createHash("sha256").update(buf).digest("hex")).toBe(m.sha256);
      // MP3 stream: ID3 tag or an MPEG frame sync (0xFFEx)
      const sync = buf.subarray(0, 3).toString() === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
      expect(sync).toBe(true);
    }
    expect(manifest.reduce((n, m) => n + m.bytes, 0)).toBeLessThan(50 * 1024);
  });
  it("durations suit their purpose", () => {
    const d = Object.fromEntries(manifest.map((m) => [m.id, m.durationMs]));
    expect(d["success-tone"]).toBeLessThan(800);
    expect(d["notification-soft"]).toBeGreaterThan(800);
    expect(d["reminder-bell"]).toBeGreaterThan(1500);
  });
  it("each category has a default tone and invalid stored tones fall back", () => {
    expect(CATEGORIES.map((c) => DEFAULT_TONES[c.id])).toEqual(SOUNDS.map((s) => s.id));
    expect(parseTones({ reminder: "evil.mp3", critical: "success-tone" })).toMatchObject({ reminder: "reminder-bell", critical: "success-tone" });
  });
});

describe("audio player (silent switch, autoplay policy, volume)", () => {
  it("plays the selected tone at the requested volume and asks iOS for the ambient session (respects silent switch)", async () => {
    const f = fakeAudio(); const session = { type: "auto" }; const seen: string[] = [];
    const p = createAudioPlayer({ create: f.create, session, emit: (id, r) => seen.push(`${id}:${r}`) });
    expect(await p.play("reminder-bell", { volume: 0.4 })).toBe("played");
    expect(f.plays).toEqual([{ src: "/sounds/reminder-bell.mp3", volume: 0.4 }]);
    expect(session.type).toBe("ambient");
    expect(p.respectsSilentSwitch()).toBe(true);
    expect(seen).toEqual(["reminder-bell:played"]);
  });
  it("reports platform blocking (autoplay) instead of pretending", async () => {
    const p = createAudioPlayer({ create: fakeAudio("blocked").create, session: null, emit: () => {} });
    expect(await p.play("notification-soft", { volume: 1 })).toBe("blocked");
    expect(p.respectsSilentSwitch()).toBe(false); // honest: no audioSession API here
  });
  it("muted / zero volume never touches the audio element; errors are contained", async () => {
    const f = fakeAudio(); const p = createAudioPlayer({ create: f.create, session: null, emit: () => {} });
    expect(await p.play("success-tone", { volume: 0.5, muted: true })).toBe("muted");
    expect(await p.play("success-tone", { volume: 0 })).toBe("muted");
    expect(f.plays).toHaveLength(0);
    expect(await createAudioPlayer({ create: fakeAudio("error").create, session: null, emit: () => {} }).play("success-tone", { volume: 1 })).toBe("error");
  });
});

describe("Arabic spoken alerts", () => {
  it("produces the spec example: «لديك اجتماع بعد ثلاثين دقيقة»", () => {
    expect(spokenReminder("اجتماع", 30, "lead")).toBe("لديك اجتماع بعد ثلاثين دقيقة");
    expect(spokenReminder("اجتماع الفريق", 15, "lead")).toBe("لديك اجتماع الفريق بعد خمس عشرة دقيقة");
    expect(spokenReminder("أراجع الفواتير", 10, "lead")).toBe("تذكير: أراجع الفواتير، بعد عشر دقائق");
    expect(spokenReminder("اجتماع", 0, "due")).toBe("حان وقت اجتماع");
  });
  it("number & duration grammar", () => {
    expect(arabicNumber(30)).toBe("ثلاثين");
    expect(arabicNumber(25)).toBe("خمسة وعشرين");
    expect(durationPhrase(1)).toBe("دقيقة");
    expect(durationPhrase(2)).toBe("دقيقتين");
    expect(durationPhrase(5)).toBe("خمس دقائق");
    expect(durationPhrase(25)).toBe("خمس وعشرين دقيقة");
    expect(durationPhrase(180)).toBe("ثلاث ساعات");
    expect(durationPhrase(3 * 1440)).toBe("ثلاثة أيام");
    expect(durationPhrase(60)).toBe("ساعة");
    expect(durationPhrase(90)).toBe("ساعة ونصف");
    expect(durationPhrase(120)).toBe("ساعتين");
    expect(durationPhrase(1440)).toBe("يوم");
  });
  it("picks an Arabic voice, and reports honestly when none exists / unsupported", async () => {
    expect(arabicVoice([{ lang: "en-US", name: "A" }, { lang: "ar-EG", name: "B" }, { lang: "ar-SA", name: "C" }])?.name).toBe("C");
    expect(arabicVoice([{ lang: "en-US", name: "A" }])).toBeNull();
    class U { onstart?: () => void; constructor(public text: string) {} }
    const noVoice = createSpeaker({ synth: { getVoices: () => [{ lang: "en-US", name: "x" }], speak() {}, cancel() {} }, Utterance: U as never });
    expect(await noVoice.speak("مرحبا", { volume: 1 })).toBe("no_voice");
    expect(await createSpeaker({ synth: null }).speak("x", { volume: 1 })).toBe("unsupported");
    const spoken: unknown[] = [];
    const ok = createSpeaker({ synth: { getVoices: () => [{ lang: "ar-SA", name: "Majed" }], speak: (u: unknown) => { spoken.push(u); (u as U).onstart?.(); }, cancel() {} }, Utterance: U as never });
    expect(await ok.speak("لديك اجتماع", { volume: 0.5 })).toBe("spoken");
    expect(spoken[0]).toMatchObject({ text: "لديك اجتماع", lang: "ar-SA", volume: 0.5 });
  });
});

describe("quiet hours (per device, Asia/Riyadh)", () => {
  const q = { enabled: true, from: "22:00", to: "07:00", allowCritical: false };
  it("wraps midnight and evaluates in the device zone", () => {
    expect(inQuietHours(riyadh(2026, 11, 3, 23, 30), q, "Asia/Riyadh")).toBe(true);
    expect(inQuietHours(riyadh(2026, 11, 3, 3, 0), q, "Asia/Riyadh")).toBe(true);
    expect(inQuietHours(riyadh(2026, 11, 3, 7, 0), q, "Asia/Riyadh")).toBe(false);
    expect(inQuietHours(riyadh(2026, 11, 3, 12, 0), q, "Asia/Riyadh")).toBe(false);
    expect(inQuietHours(riyadh(2026, 11, 3, 23, 30), { ...q, enabled: false }, "Asia/Riyadh")).toBe(false);
  });
  it("quietEnd is the next 07:00", () => {
    expect(quietEnd(riyadh(2026, 11, 3, 23, 30), q, "Asia/Riyadh")).toBe(riyadh(2026, 11, 4, 7, 0));
    expect(quietEnd(riyadh(2026, 11, 3, 3, 0), q, "Asia/Riyadh")).toBe(riyadh(2026, 11, 3, 7, 0));
    expect(quietEnd(riyadh(2026, 11, 3, 12, 0), q, "Asia/Riyadh")).toBe(riyadh(2026, 11, 3, 12, 0));
  });
  it("critical passes only when the user allowed it", () => {
    const t = riyadh(2026, 11, 3, 23, 30);
    expect(shouldHold(t, q, "Asia/Riyadh", "critical")).toBe(true);
    expect(shouldHold(t, { ...q, allowCritical: true }, "Asia/Riyadh", "critical")).toBe(false);
    expect(shouldHold(t, { ...q, allowCritical: true }, "Asia/Riyadh", "normal")).toBe(true);
    expect(parseQuiet({ enabled: true, from: "bad", to: "25:00" })).toMatchObject({ from: "22:00", to: "07:00" });
  });
});

describe("notification centre domain", () => {
  const mk = (over: Partial<Notice> = {}): Notice => ({ id: crypto.randomUUID(), key: crypto.randomUUID(), type: "system", priority: "normal", title: "t", created: 1, read: false, ...over });
  it("insertion is idempotent by key", () => {
    const a = mk({ key: "k1" });
    const r1 = insertNotice([], a);
    expect(r1.inserted).toBe(true);
    expect(insertNotice(r1.list, mk({ key: "k1" })).inserted).toBe(false);
    expect(insertNotice(r1.list, mk({ key: "k1" })).list).toHaveLength(1);
  });
  it("filters by tab, type, priority and text; unread count ignores archived", () => {
    const list = [mk({ type: "reminder", priority: "high", title: "فواتير", created: 3 }), mk({ type: "security", priority: "critical", created: 2, read: true }), mk({ archived: true, created: 1 })];
    expect(filterNotices(list, { tab: "inbox" })).toHaveLength(2);
    expect(filterNotices(list, { tab: "unread" })).toHaveLength(1);
    expect(filterNotices(list, { tab: "archived" })).toHaveLength(1);
    expect(filterNotices(list, { tab: "inbox", type: "security" })).toHaveLength(1);
    expect(filterNotices(list, { tab: "inbox", priority: "high" })).toHaveLength(1);
    expect(filterNotices(list, { tab: "inbox", query: "فواتير" })).toHaveLength(1);
    expect(unreadCount(list)).toBe(1);
  });
  it("only same-origin paths may be opened from a notification", () => {
    expect(safeHref("/reminders")).toBe("/reminders");
    for (const bad of ["https://evil.com", "//evil.com", "javascript:alert(1)", "/\\evil", "reminders", "/a\nb"]) expect(safeHref(bad)).toBeUndefined();
    expect(parseNotices([{ id: "1", key: "k", type: "system", priority: "low", title: "x", created: 1, read: false, href: "https://evil.com" }])[0].href).toBeUndefined();
  });
});

describe("alert delivery (inbox + tone + speech + idempotency)", () => {
  const base = { key: "r1@100", type: "reminder" as const, priority: "normal" as const, title: "تذكير: فواتير", category: "reminder" as const, spoken: "حان وقت التذكير" };
  it("adds to the inbox, plays the chosen tone at the saved volume, and never repeats for the same key", async () => {
    prefsStore.set({ ...DEFAULT_PREFS, volume: 0.3, tones: { ...DEFAULT_PREFS.tones, reminder: "notification-soft" } });
    const calls: unknown[] = [];
    const deps = { audio: { play: async (id: string, o: unknown) => { calls.push([id, o]); return "played" as const; } }, emit: () => {}, now: () => 1000 };
    const a = await deliverAlert(base, deps);
    expect(a).toMatchObject({ duplicate: false, sound: "played" });
    expect(calls).toEqual([["notification-soft", { volume: 0.3 }]]);
    expect(noticesStore.getSnapshot()).toHaveLength(1);
    const b = await deliverAlert(base, deps);
    expect(b.duplicate).toBe(true);
    expect(calls).toHaveLength(1);
    expect(noticesStore.getSnapshot()).toHaveLength(1);
  });
  it("sound off → silent, still in the inbox", async () => {
    prefsStore.set({ ...DEFAULT_PREFS, soundEnabled: false });
    const play = vi.fn();
    const o = await deliverAlert(base, { audio: { play }, emit: () => {} });
    expect(play).not.toHaveBeenCalled(); expect(o.sound).toBe("off"); expect(noticesStore.getSnapshot()).toHaveLength(1);
  });
  it("quiet hours suppress sound and speech but keep the inbox item; critical bypass only if allowed", async () => {
    const night = riyadh(2026, 11, 3, 23, 30);
    prefsStore.set({ ...DEFAULT_PREFS, speak: true, quiet: { enabled: true, from: "22:00", to: "07:00", allowCritical: false } });
    const play = vi.fn(async () => "played" as const), speak = vi.fn(async () => "spoken" as const);
    const o = await deliverAlert(base, { audio: { play }, speak: { speak }, now: () => night, emit: () => {}, visible: () => true });
    expect(o).toMatchObject({ sound: "quiet", speech: "quiet" });
    expect(play).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
    expect(noticesStore.getSnapshot()).toHaveLength(1);
    prefsStore.set({ ...DEFAULT_PREFS, quiet: { enabled: true, from: "22:00", to: "07:00", allowCritical: true } });
    const c = await deliverAlert({ ...base, key: "crit", priority: "critical", category: "critical" }, { audio: { play }, now: () => night, emit: () => {} });
    expect(c.sound).toBe("played");
  });
  it("speech is opt-in, foreground-only", async () => {
    const speak = vi.fn(async () => "spoken" as const);
    await deliverAlert({ ...base, key: "s0" }, { audio: { play: async () => "played" }, speak: { speak }, emit: () => {}, visible: () => true });
    expect(speak).not.toHaveBeenCalled(); // default off
    prefsStore.set({ ...DEFAULT_PREFS, speak: true });
    const hidden = await deliverAlert({ ...base, key: "s1" }, { audio: { play: async () => "played" }, speak: { speak }, emit: () => {}, visible: () => false });
    expect(hidden.speech).toBe("hidden"); expect(speak).not.toHaveBeenCalled();
    const shown = await deliverAlert({ ...base, key: "s2" }, { audio: { play: async () => "played" }, speak: { speak }, emit: () => {}, visible: () => true });
    expect(shown.speech).toBe("spoken"); expect(speak).toHaveBeenCalledWith("حان وقت التذكير", { volume: 0.7 });
  });
  it("reports blocked autoplay so the UI can prompt the user", async () => {
    const o = await deliverAlert({ ...base, key: "b" }, { audio: { play: async () => "blocked" }, emit: () => {} });
    expect(o.sound).toBe("blocked");
  });
  it("category mapping: critical/security → critical tone", () => {
    expect(categoryFor("reminder", "critical")).toBe("critical");
    expect(categoryFor("security", "normal")).toBe("critical");
    expect(categoryFor("reminder", "normal")).toBe("reminder");
    expect(categoryFor("system", "low")).toBe("notification");
  });
  it("prefs parsing is defensive", () => {
    expect(parsePrefs({ volume: 7, tz: "Mars/X", lockScreenContent: "yes" })).toMatchObject({ volume: 1, tz: "Asia/Riyadh", lockScreenContent: false });
    expect(parsePrefs(null).lockScreenContent).toBe(false); // privacy default
  });
});

describe("foreground reminder engine", () => {
  const audio = { play: async () => "played" as const };
  it("fires due reminders exactly once, even if the tick runs repeatedly or in two tabs", async () => {
    const now = riyadh(2026, 11, 2, 2, 0);
    const r = createReminder({ title: "مراجعة الفواتير", time: "09:00", date: "2026-11-03" }, now, "r1");
    remindersStore.set([r]);
    expect(await runDueReminders(r.dueAt - 1000, { audio, emit: () => {} })).toBe(0);
    expect(await runDueReminders(r.dueAt + 1000, { audio, emit: () => {} })).toBe(1);
    expect(await runDueReminders(r.dueAt + 2000, { audio, emit: () => {} })).toBe(0);
    expect(noticesStore.getSnapshot()).toHaveLength(1);
    expect(noticesStore.getSnapshot()[0]).toMatchObject({ type: "reminder", href: "/reminders?focus=r1", reminderId: "r1" });
    expect(remindersStore.getSnapshot()[0].status).toBe("fired");
    // simulate a second tab that still holds the OLD state: key-level idempotency prevents a 2nd alert
    remindersStore.set([r]);
    expect(await runDueReminders(r.dueAt + 3000, { audio, emit: () => {} })).toBe(0);
    expect(noticesStore.getSnapshot()).toHaveLength(1);
  });
  it("recurring reminders keep firing day after day with distinct keys", async () => {
    const now = riyadh(2026, 11, 2, 2, 0);
    remindersStore.set([createReminder({ title: "دواء", time: "08:00", date: "2026-11-02", repeat: "daily" }, now, "d1")]);
    let t = riyadh(2026, 11, 2, 8, 0);
    for (let i = 0; i < 3; i++) { expect(await runDueReminders(t + 1000, { audio, emit: () => {} })).toBe(1); t += 86_400_000; }
    expect(new Set(noticesStore.getSnapshot().map((n) => n.key)).size).toBe(3);
  });
  it("lead-time alert text says how long remains", async () => {
    const now = riyadh(2026, 11, 2, 2, 0);
    const r = createReminder({ title: "اجتماع", time: "09:00", date: "2026-11-03", leadMinutes: 30 }, now, "l1");
    remindersStore.set([r]);
    await runDueReminders(r.dueAt - 30 * 60_000, { audio, emit: () => {} });
    expect(noticesStore.getSnapshot()[0].body).toContain("بعد 30 دقيقة");
  });
});

describe("commands: reminders + notification centre", () => {
  it("create → edit → snooze → complete → delete through the command gate", async () => {
    const add = await runCommand("reminders.add", { title: "مراجعة", date: "2099-01-01", time: "09:00", priority: "high" });
    expect(add.status).toBe("executed");
    const id = remindersStore.getSnapshot()[0].id;
    expect((await runCommand("reminders.update", { id, patch: { title: "مراجعة 2", time: "10:00" } })).status).toBe("executed");
    expect(remindersStore.getSnapshot()[0]).toMatchObject({ title: "مراجعة 2", time: "10:00" });
    expect((await runCommand("reminders.snooze", { id, minutes: 10 })).status).toBe("executed");
    expect(remindersStore.getSnapshot()[0].snoozeUntil).toBeTypeOf("number");
    expect((await runCommand("reminders.pause", { id })).status).toBe("executed");
    expect((await runCommand("reminders.resume", { id })).status).toBe("executed");
    expect((await runCommand("reminders.complete", { id })).status).toBe("executed");
    expect(remindersStore.getSnapshot()[0].status).toBe("completed");
    expect((await runCommand("reminders.remove", { id })).status).toBe("executed");
    expect(remindersStore.getSnapshot()).toEqual([]);
  });
  it("invalid input is rejected without touching data; review mode is read-only", async () => {
    expect((await runCommand("reminders.add", { title: " ", date: "2099-01-01", time: "09:00" })).status).toBe("invalid");
    expect((await runCommand("reminders.add", { title: "x", date: "2001-01-01", time: "09:00" })).status).toBe("invalid");
    expect((await runCommand("reminders.snooze", { id: "nope", minutes: 5 })).status).toBe("invalid");
    expect((await runCommand("reminders.add", { title: "x", date: "2099-01-01", time: "09:00" }, { mode: "review" })).status).toBe("denied");
    expect(remindersStore.getSnapshot()).toEqual([]);
  });
  it("completing / snoozing a reminder marks its notifications as read", async () => {
    await runCommand("reminders.add", { title: "x", date: "2099-01-01", time: "09:00" });
    const id = remindersStore.getSnapshot()[0].id;
    noticesStore.set([{ id: "n1", key: "k", type: "reminder", priority: "normal", title: "t", created: 1, read: false, reminderId: id }]);
    await runCommand("reminders.complete", { id });
    expect(noticesStore.getSnapshot()[0].read).toBe(true);
  });
  it("notification actions: read/unread, archive/restore, open, delete, clear archived (needs approval)", async () => {
    noticesStore.set([
      { id: "a", key: "ka", type: "system", priority: "normal", title: "A", created: 3, read: false, href: "/tasks" },
      { id: "b", key: "kb", type: "security", priority: "critical", title: "B", created: 2, read: false },
    ]);
    await runCommand("notifications.mark_read", { id: "a", read: true });
    expect(noticesStore.getSnapshot().find((n) => n.id === "a")!.read).toBe(true);
    await runCommand("notifications.mark_read", { id: "a", read: false });
    expect(noticesStore.getSnapshot().find((n) => n.id === "a")!.read).toBe(false);
    const open = await runCommand("notifications.open", { id: "a" });
    expect(open).toMatchObject({ status: "executed", data: "/tasks" });
    expect(noticesStore.getSnapshot().find((n) => n.id === "a")!.read).toBe(true);
    await runCommand("notifications.archive", { id: "b" });
    expect(noticesStore.getSnapshot().find((n) => n.id === "b")).toMatchObject({ archived: true, read: true });
    expect((await runCommand("notifications.clear_archived", {})).status).toBe("approval_required");
    expect((await runCommand("notifications.clear_archived", {}, { approved: true })).status).toBe("executed");
    expect(noticesStore.getSnapshot().map((n) => n.id)).toEqual(["a"]);
    await runCommand("notifications.mark_all_read", {});
    await runCommand("notifications.remove", { id: "a" });
    expect(noticesStore.getSnapshot()).toEqual([]);
    expect((await runCommand("notifications.remove", { id: "ghost" })).status).toBe("invalid");
  });
  it("completing a task plays the success tone path and logs an inbox item", async () => {
    await runCommand("tasks.add", { title: "إرسال التقرير" });
    const id = tasksStore.getSnapshot()[0].id;
    await runCommand("tasks.toggle", { id });
    await new Promise((r) => setTimeout(r, 20));
    expect(noticesStore.getSnapshot()[0]).toMatchObject({ type: "task", priority: "low", body: "إرسال التقرير" });
    await runCommand("tasks.toggle", { id }); // un-complete: no new notice
    await new Promise((r) => setTimeout(r, 20));
    expect(noticesStore.getSnapshot()).toHaveLength(1);
  });
  it("erase_all also wipes reminders, notifications and preferences", async () => {
    await runCommand("reminders.add", { title: "x", date: "2099-01-01", time: "09:00" });
    prefsStore.set({ ...DEFAULT_PREFS, speak: true });
    noticesStore.set([{ id: "a", key: "ka", type: "system", priority: "normal", title: "A", created: 1, read: false }]);
    await runCommand("data.erase_all", {}, { approved: true });
    expect(remindersStore.getSnapshot()).toEqual([]); expect(noticesStore.getSnapshot()).toEqual([]); expect(prefsStore.getSnapshot().speak).toBe(false);
  });
});

describe("chat integration (typed or dictated)", () => {
  it("«ذكرني بعد 30 دقيقة …» creates the reminder immediately", async () => {
    const r = await runQuickCommand("ذكرني بعد 30 دقيقة أتصل بأحمد");
    expect(r.handled).toBe(true);
    expect(r.reminderCreated?.title).toBe("أتصل بأحمد");
    expect(remindersStore.getSnapshot()).toHaveLength(1);
    expect(remindersStore.getSnapshot()[0].dueAt - Date.now()).toBeGreaterThan(29 * 60_000);
  });
  it("ambiguous commands are NOT saved: they return a clarification", async () => {
    const r = await runQuickCommand("ذكرني بكرة الساعة 9 أراجع الفواتير");
    expect(r.handled).toBe(true);
    expect(r.reminderOffer?.clarification.reason).toBe("period");
    expect(r.reply).toContain("صباحاً أم مساءً");
    expect(remindersStore.getSnapshot()).toEqual([]);
  });
  it("ordinary chat is untouched", async () => {
    expect((await runQuickCommand("مرحبا")).handled).toBe(false);
    expect((await runQuickCommand("/مهمة اختبار")).handled).toBe(true);
  });
});
