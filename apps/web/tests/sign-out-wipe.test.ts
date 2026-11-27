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
});
