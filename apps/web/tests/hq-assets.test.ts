import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { HQ_ASSETS, HQ_ASSETS_TOTAL_BYTES } from "@/lib/hq/assets.generated";
import { AGENT_IDS } from "@/lib/hq/roster";

const PUB = resolve(__dirname, "../public");
const file = (f: string) => join(PUB, HQ_ASSETS.base, f);
/** Reads the JSON chunk of a GLB (header 12 bytes, then [len, type] + JSON). */
function glbJson(path: string) {
  const b = readFileSync(path);
  expect(b.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString("utf8"));
}

describe("HQ 3D assets (tools/hq-assets → public/hq-assets)", () => {
  it("ships every file the manifest names, under a content-hashed folder", () => {
    expect(HQ_ASSETS.base).toMatch(/^\/hq-assets\/v1-[0-9a-f]{10}\/$/);
    for (const f of [HQ_ASSETS.building.file, HQ_ASSETS.building.lightmap, ...AGENT_IDS.map((id) => HQ_ASSETS.characters[id].file)])
      expect(existsSync(file(f)), f).toBe(true);
  });
  it("has 14 characters, one file each, and no two files are the same (no duplicated characters)", () => {
    expect(Object.keys(HQ_ASSETS.characters).sort()).toEqual([...AGENT_IDS].sort());
    const hashes = AGENT_IDS.map((id) => createHash("sha256").update(readFileSync(file(HQ_ASSETS.characters[id].file))).digest("hex"));
    expect(new Set(hashes).size).toBe(14);
  });
  it("every character is a single skinned mesh with the shared skeleton and all the clips the app plays", () => {
    for (const id of AGENT_IDS) {
      const j = glbJson(file(HQ_ASSETS.characters[id].file));
      expect(j.skins?.length, id).toBe(1);
      expect(j.meshes.length, id).toBe(1);
      expect(j.materials.length, id).toBe(1); // one draw call per character
      const names = j.nodes.map((n: { name?: string }) => n.name);
      for (const bone of ["hips", "spine", "chest", "head", "thigh.L", "shin.R", "upperarm.L", "hand.R"]) expect(names, `${id} ${bone}`).toContain(bone);
      expect(j.animations.map((a: { name: string }) => a.name).sort(), id).toEqual(["idle", "sit", "stand", "talk", "type", "walk"]);
      expect(j.extensionsUsed ?? [], id).toContain("EXT_meshopt_compression");
    }
  });
  it("the building carries a lightmap UV set and stays inside the iPhone budget", () => {
    const j = glbJson(file(HQ_ASSETS.building.file));
    expect(j.meshes.length).toBeLessThanOrEqual(25); // one mesh per material → ≤ 25 draw calls for the whole building
    const attrs = new Set(j.meshes.flatMap((m: { primitives: { attributes: Record<string, number> }[] }) => m.primitives.flatMap((p) => Object.keys(p.attributes))));
    expect(attrs.has("TEXCOORD_1")).toBe(true);
    expect(HQ_ASSETS.building.tris).toBeLessThan(120_000);
    expect(HQ_ASSETS.building.lightmapScale).toBeGreaterThan(0);
  });
  it("keeps the whole HQ download under 15 MB (first view needs the building + lightmap + characters)", () => {
    expect(HQ_ASSETS_TOTAL_BYTES).toBeLessThan(15e6);
    const sum = [HQ_ASSETS.building.file, HQ_ASSETS.building.lightmap, ...AGENT_IDS.map((id) => HQ_ASSETS.characters[id].file)].reduce((s, f) => s + statSync(file(f)).size, 0);
    expect(sum).toBe(HQ_ASSETS_TOTAL_BYTES);
  });
});
