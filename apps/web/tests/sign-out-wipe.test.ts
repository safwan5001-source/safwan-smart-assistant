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
