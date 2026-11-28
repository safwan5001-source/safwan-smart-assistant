import { describe, expect, it } from "vitest";
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
    vi.doMock("@/lib/owner-auth", () => ({ authClient: { logout: async () => {} } }));
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
