import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_IDS, AGENTS, ROSTER } from "@/lib/hq/roster";
import { BUILDING, COLLIDERS, FRAMES, FURNITURE, GRAPH, MEETING_SEATS, OFFICES, WALLS, exportPlan, footprint, type Rect } from "@/lib/hq/layout";
import { BODY_R, LANE, findRoute, pointRectDistance, routePoints, segmentRectDistance } from "@/lib/hq/path";

const overlap = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
const inside = (p: readonly [number, number], r: Rect) => p[0] > r.x0 && p[0] < r.x1 && p[1] > r.z0 && p[1] < r.z1;

describe("HQ roster", () => {
  it("has exactly the 14 approved characters, unique ids and names, BASHT the only robot", () => {
    expect(ROSTER.map((a) => a.id)).toEqual([...AGENT_IDS]);
    expect(new Set(ROSTER.map((a) => a.nameAr)).size).toBe(14);
    expect(ROSTER.filter((a) => a.look.kind === "robot").map((a) => a.id)).toEqual(["BASHT"]);
  });
  it("uses the owner-approved role names from the brief", () => {
    expect(AGENTS.MIYAR.role).toBe("الرقابة والجودة");
    expect(AGENTS.BASIRA.role).toBe("ذكاء الأعمال وتحليل البيانات");
    expect(AGENTS.BASHT.role).toBe("المدير التنفيذي");
  });
  it("makes every pair of humans visibly different (colour, silhouette or accessories — not just a different file)", () => {
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const dist = (a: string, b: string) => Math.hypot(...hex(a).map((v, i) => v - hex(b)[i]));
    const humans = ROSTER.flatMap((a) => (a.look.kind === "human" ? [{ id: a.id, ...a.look }] : []));
    const bad: string[] = [];
    for (let i = 0; i < humans.length; i++) for (let j = i + 1; j < humans.length; j++) {
      const a = humans[i], b = humans[j];
      const headA = a.head === "hijab" ? a.accent : a.head, headB = b.head === "hijab" ? b.accent : b.head;
      const cues = [
        a.attire !== b.attire,
        dist(a.outfit, b.outfit) > 40, // robe colour you can tell apart at a glance
        headA !== headB && (a.head !== "hijab" || dist(a.accent, b.accent) > 60),
        Math.abs(a.height - b.height) >= 0.04 || a.build !== b.build,
        a.extras.includes("bisht") !== b.extras.includes("bisht"), // a cloak changes the whole silhouette
        a.extras.filter((x) => !b.extras.includes(x)).length + b.extras.filter((x) => !a.extras.includes(x)).length >= 2,
      ].filter(Boolean).length;
      if (cues < 2) bad.push(`${a.id}~${b.id}`);
    }
    expect(bad).toEqual([]);
  });
  it("gives every person their own realistic face and dresses the team in Saudi business attire", () => {
    const people = ROSTER.flatMap((a) => (a.look.kind === "human" ? [{ id: a.id, ...a.look }] : []));
    const faces = people.map((p) => p.face ?? p.model);
    expect(new Set(faces).size).toBe(13); // a face is never reused, even when two people share an outfit
    for (const p of people) {
      const female = (p.face ?? p.model).includes("Female");
      expect(p.model.includes("Female"), `${p.id}: face and outfit must share a skeleton`).toBe(female);
      if (female) expect(p.head, `${p.id}: women wear the hijab`).toBe("hijab");
      if (p.attire === "thobe") expect(["ghutra", "shemagh"], p.id).toContain(p.head);
      if (p.head === "ghutra" || p.head === "shemagh") expect(p.attire, p.id).toBe("thobe");
    }
    // a mix, as the owner asked: thobes, suits and modest women's wear
    expect(people.filter((p) => p.attire === "thobe").length).toBeGreaterThanOrEqual(4);
    expect(people.filter((p) => p.attire === "suit" && !p.model.includes("Female")).length).toBeGreaterThanOrEqual(2);
  });
  it("gives every human a distinct look (no two characters share outfit, height and build)", () => {
    const keys = ROSTER.flatMap((a) => (a.look.kind === "human" ? [`${a.look.attire}|${a.look.head}|${a.look.outfit}|${a.look.accent}|${a.look.height}|${a.look.build}|${a.look.extras.join("+")}`] : []));
    expect(keys).toHaveLength(13);
    expect(new Set(keys).size).toBe(13);
  });
});

describe("HQ floor plan", () => {
  it("gives every character its own office, all inside the building and none overlapping", () => {
    expect(OFFICES.map((o) => o.id).sort()).toEqual([...AGENT_IDS].sort());
    for (const o of OFFICES) {
      expect(o.rect.x0).toBeGreaterThanOrEqual(BUILDING.x0); expect(o.rect.x1).toBeLessThanOrEqual(BUILDING.x1);
      expect(o.rect.z0).toBeGreaterThanOrEqual(BUILDING.z0); expect(o.rect.z1).toBeLessThanOrEqual(BUILDING.z1);
    }
    for (let i = 0; i < OFFICES.length; i++) for (let j = i + 1; j < OFFICES.length; j++)
      expect(overlap(OFFICES[i].rect, OFFICES[j].rect), `${OFFICES[i].id} × ${OFFICES[j].id}`).toBe(false);
  });
  it("makes the executive suite the largest office", () => {
    const area = (r: Rect) => (r.x1 - r.x0) * (r.z1 - r.z0);
    const exec = OFFICES.find((o) => o.exec)!;
    expect(exec.id).toBe("BASHT");
    for (const o of OFFICES) if (!o.exec) expect(area(exec.rect)).toBeGreaterThan(2 * area(o.rect));
  });
  it("puts every seat and desk inside its own office and keeps solid furniture off the walls", () => {
    for (const id of AGENT_IDS) {
      const f = FRAMES[id];
      expect(inside(f.seat.at, f.office.rect), id).toBe(true);
      for (const item of FURNITURE.filter((x) => x.office === id)) {
        const fp = footprint(item);
        expect(fp.x0 >= f.office.rect.x0 - 1e-6 && fp.x1 <= f.office.rect.x1 + 1e-6 && fp.z0 >= f.office.rect.z0 - 1e-6 && fp.z1 <= f.office.rect.z1 + 1e-6, `${id} ${item.kind}`).toBe(true);
      }
    }
    for (const item of FURNITURE.filter((x) => x.solid)) for (const w of WALLS)
      expect(overlap(footprint(item), w), `${item.kind}@${item.at} × wall ${w.x0},${w.z0}`).toBe(false);
  });
  it("keeps every walking edge clear of walls and furniture (halls also leave room for the passing lane)", () => {
    for (const [a, b, kind] of GRAPH.edges) {
      const pa = GRAPH.nodes[a], pb = GRAPH.nodes[b];
      const need = kind === "hall" ? LANE + BODY_R : BODY_R;
      for (const c of COLLIDERS) expect(segmentRectDistance(pa, pb, c), `${a} → ${b}`).toBeGreaterThanOrEqual(need - 1e-6);
    }
  });
  it("connects every desk to every meeting chair and back", () => {
    for (const id of AGENT_IDS) for (let s = 0; s < MEETING_SEATS.length; s++) {
      expect(findRoute(GRAPH, `${id}:seat`, `M:seat${s}`), `${id} → seat ${s}`).not.toBeNull();
    }
  });
  it("routes never pass through another person's office", () => {
    for (const id of AGENT_IDS) {
      const r = findRoute(GRAPH, `${id}:seat`, "M:seat0")!;
      const offices = new Set(r.map((n) => n.split(":")[0]).filter((p) => (AGENT_IDS as readonly string[]).includes(p)));
      expect([...offices], id).toEqual([id]);
    }
  });
  it("lane-shifted hall points stay clear of every collider", () => {
    for (const id of AGENT_IDS) {
      const pts = routePoints(GRAPH, findRoute(GRAPH, `${id}:seat`, "M:seat3")!);
      for (let i = 1; i < pts.length; i++) for (const c of COLLIDERS) {
        if (segmentRectDistance(pts[i - 1], pts[i], c) < BODY_R - 1e-6) throw new Error(`${id} segment ${i} touches collider ${JSON.stringify(c)}`);
      }
      for (const p of pts) for (const c of COLLIDERS) expect(pointRectDistance(p, c)).toBeGreaterThanOrEqual(BODY_R - 1e-6);
    }
  });
});

describe("HQ plan export (tools/hq-assets/layout.json — the Blender generator's input)", () => {
  const file = resolve(__dirname, "../../../tools/hq-assets/layout.json");
  it("is in sync with lib/hq/layout.ts (HQ_WRITE_LAYOUT=1 pnpm test:web regenerates it)", () => {
    const json = JSON.stringify(exportPlan()) + "\n"; // generated input for the Blender scripts: compact
    if (process.env.HQ_WRITE_LAYOUT === "1") writeFileSync(file, json);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(json);
  });
});
