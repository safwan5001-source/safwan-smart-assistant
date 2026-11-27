import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// Review (Codex, round 12): the automatic link made when push is turned on updated neither the row nor the device store, and a
// read of the switch that started before the link finished could show «off» while BASHT alerts were in fact on.
const device = { subscribed: true, id: "dev-1" };
const setPushLinked = vi.fn(async () => true);
vi.mock("@/lib/stores", () => ({ pushDeviceStore: { getSnapshot: () => device } }));
vi.mock("@/lib/basht-approvals", () => ({ approvalsClient: { setPushLinked, pushLinked: vi.fn() }, ApprovalError: class extends Error {} }));
vi.mock("@/lib/hooks", () => ({ useStore: () => device }));
vi.mock("@/components/dialogs", () => ({ useDialogs: () => ({ toast: () => {} }) }));

describe("«تنبيهات باشت» follows the automatic link", () => {
  beforeEach(() => setPushLinked.mockClear());
  it("publishes the link result to the row and moves the sequence a stale read is checked against", async () => {
    const m = await import("@/features/settings/basht-alerts-row");
    const seen: boolean[] = [];
    const off = m.onBashtAlertsLinked((v) => seen.push(v));
    const before = m.bashtAlertsLinkSeq();
    expect(await m.linkBashtAlerts()).toBe(true);
    expect(seen).toEqual([true]);
    expect(m.bashtAlertsLinkSeq()).toBe(before + 1);
    off();
    await m.linkBashtAlerts();
    expect(seen).toEqual([true]); // unsubscribed rows are not called
  });
  it("the row subscribes and ignores a read that started before a link finished", () => {
    const src = readFileSync(new URL("../features/settings/basht-alerts-row.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/useEffect\(\(\) => onBashtAlertsLinked\(\(v\) => \{ setOn\(v\); setNote\(""\); \}\), \[\]\);/);
    expect(src).toMatch(/const seq = linkSeq;[\s\S]*?if \(alive && seq === linkSeq\) \{ setOn\(v\);/);
  });
});
