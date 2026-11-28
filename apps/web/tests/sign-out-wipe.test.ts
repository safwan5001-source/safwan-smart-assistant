import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { wipeLeftovers } from "@/lib/sign-out";

describe("sign-out wipe report (review: never a silent partial wipe)", () => {
  it("is empty only when everything was cleared", () => {
    expect(wipeLeftovers({ filesCleared: true, serverErased: true })).toEqual([]);
  });
  it("names what stayed on the device", () => {
    expect(wipeLeftovers({ filesCleared: false, serverErased: true })).toHaveLength(1);
    expect(wipeLeftovers({ filesCleared: true, serverErased: false })[0]).toContain("الإشعارات");
    expect(wipeLeftovers({ filesCleared: false, serverErased: false })).toHaveLength(2);
  });
  it("also reports the device copies of photos sent to BASHT when they could not be cleared", () => {
    expect(wipeLeftovers({ filesCleared: true, serverErased: true, attachmentsCleared: true })).toEqual([]);
    expect(wipeLeftovers({ filesCleared: true, serverErased: true, attachmentsCleared: false })[0]).toContain("الصور");
  });
});

describe("sign-out vs the login gate (review: no redirect mid-wipe)", () => {
  it("marks the page as leaving before the sign-out request, and clears the mark if sign-out fails", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    const logout = vi.fn();
    vi.doMock("@/lib/owner-auth", () => ({ authClient: { logout } }));
    const mod = await import("@/lib/sign-out");
    let seen = false;
    logout.mockImplementationOnce(async () => { seen = mod.isLeaving(); throw new Error("offline"); });
    await expect(mod.signOut()).rejects.toThrow();
    expect(seen).toBe(true);
    expect(mod.isLeaving()).toBe(false);
    vi.doUnmock("@/lib/owner-auth");
  });
});

describe("sign-out really wipes the device copies of sent photos (behavioural)", () => {
  async function load(clear: () => Promise<boolean>) {
    const { vi } = await import("vitest");
    vi.resetModules();
    const reset = { reset: vi.fn() };
    const calls: string[] = [];
    const stores = { tasksStore: reset, threadsStore: reset, activityStore: reset, remindersStore: reset, noticesStore: reset, firedStore: reset, prefsStore: reset, tombstonesStore: reset, pushDeviceStore: reset };
    vi.doMock("@/lib/stores", () => stores);
    vi.doMock("@/lib/push-client", () => ({ eraseRemoteDevice: async () => true, suspendSync: () => {}, resumeSync: () => {} }));
    vi.doMock("@/lib/files-db", () => ({ clearFiles: async () => { calls.push("files"); } }));
    vi.doMock("@/lib/owner-auth", () => ({ authClient: { logout: async () => {} }, parseOwnerScope: (v: unknown) => v }));
    vi.doMock("@/lib/local-attachments", () => ({ localAttachments: () => ({ clearAll: () => { calls.push("attachments"); return clear(); } }) }));
    const mod = await import("@/lib/sign-out");
    return { mod, calls, vi };
  }
  const unmock = async () => { const { vi } = await import("vitest"); for (const m of ["stores", "push-client", "files-db", "owner-auth", "local-attachments"]) vi.doUnmock("@/lib/" + m); vi.resetModules(); };

  it("calls the local-copy wipe and AWAITS it before reporting", async () => {
    let release!: (v: boolean) => void;
    const { mod, calls } = await load(() => new Promise<boolean>((r) => { release = r; }));
    let done: Awaited<ReturnType<typeof mod.clearPrivateData>> | null = null;
    const p = mod.clearPrivateData().then((r) => { done = r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain("attachments");
    expect(done).toBeNull(); // still waiting for the wipe: not reported as done
    release(true); await p;
    expect(done).toMatchObject({ attachmentsCleared: true });
    expect(mod.wipeLeftovers(done!)).toEqual([]);
    await unmock();
  });
  it("sign-out (and ending this device's own session) forgets the owner: nothing scoped is read or written until the next sign-in; erase-all keeps the owner known", async () => {
    const { mod } = await load(async () => true);
    const { setOwnerScope, getOwnerScope } = await import("@/lib/owner-scope"); // the same (freshly reset) module instance sign-out uses
    setOwnerScope("0123456789abcdef");
    expect(getOwnerScope()).toBe("0123456789abcdef");
    await mod.clearPrivateData();                                  // settings «erase all local data»: the owner is still signed in
    expect(getOwnerScope()).toBe("0123456789abcdef");
    await mod.endOwnerOnDevice();                                  // ending the owner's session on this device
    expect(getOwnerScope()).toBeNull();
    setOwnerScope("0123456789abcdef");
    await mod.signOut();                                           // the sign-out itself (the logout request is mocked)
    expect(getOwnerScope()).toBeNull();
    await unmock();
  });
  it("«erase all local data» (settings) shows the photo-wipe failure with the same leftover list as sign-out, and says nothing of the kind when it worked", async () => {
    const bad = await load(() => Promise.resolve(false));
    const r = await bad.mod.clearPrivateData();
    expect(r.attachmentsCleared).toBe(false);
    const failed = bad.mod.eraseSummary(r);
    expect(failed.ok).toBe(false);
    for (const name of bad.mod.wipeLeftovers(r)) expect(failed.text).toContain(name);   // the same list sign-out shows
    expect(failed.text).toContain("الصور");
    expect(failed.text).not.toContain("تم مسح البيانات المحلية");
    await unmock();
    const good = await load(() => Promise.resolve(true));
    const ok = good.mod.eraseSummary(await good.mod.clearPrivateData());
    expect(ok).toEqual({ ok: true, text: "تم مسح البيانات المحلية وبيانات الإشعارات على الخادم" });
    await unmock();
  });
  it("eraseSummary: each kind of leftover is named; a push-server-only failure keeps its own wording", async () => {
    const { mod } = await load(async () => true);
    expect(mod.eraseSummary({ filesCleared: true, serverErased: true, attachmentsCleared: true }).ok).toBe(true);
    expect(mod.eraseSummary({ filesCleared: true, serverErased: false, attachmentsCleared: true })).toMatchObject({ ok: false, text: expect.stringContaining("خادم الإشعارات") });
    const both = mod.eraseSummary({ filesCleared: false, serverErased: true, attachmentsCleared: false });
    expect(both.ok).toBe(false); expect(both.text).toContain("الملفات"); expect(both.text).toContain("الصور");
    expect(mod.eraseSummary({ filesCleared: true, serverErased: true })).toMatchObject({ ok: true }); // an older result without the field is not a failure
    await unmock();
  });
  it("ending this device's own session from settings forgets the owner too (source contract)", () => {
    const src = readFileSync(join(resolve(__dirname, ".."), "features/settings/security-settings.tsx"), "utf8");
    expect(src).toContain("markLeaving(); return endOwnerOnDevice(); }");
    expect(src).not.toContain("return clearPrivateData(); }");
  });
  it("the settings screen uses it (source contract)", () => {
    const src = readFileSync(join(resolve(__dirname, ".."), "features/settings/settings-screen.tsx"), "utf8");
    expect(src).toContain("eraseSummary(res.data)");
    expect(src).not.toContain("مكتبة الملفات فلم تُحذف");
  });
  it("reports a wipe that failed, threw or never finished (3 s) as NOT cleared — never as done", async () => {
    for (const mk of [() => Promise.resolve(false), () => Promise.reject(new Error("idb")), () => new Promise<boolean>(() => {})]) {
      const { mod, vi } = await load(mk);
      vi.useFakeTimers();
      const p = mod.clearPrivateData();
      await vi.advanceTimersByTimeAsync(mod.ATTACHMENT_WIPE_MS + 50);
      const r = await p;
      vi.useRealTimers();
      expect(r.attachmentsCleared).toBe(false);
      expect(mod.wipeLeftovers(r).join(" ")).toContain("الصور");
      await unmock();
    }
  });
});
