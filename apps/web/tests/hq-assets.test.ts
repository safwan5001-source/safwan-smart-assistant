import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { HQ_ASSETS, HQ_ASSETS_TOTAL_BYTES } from "@/lib/hq/assets.generated";
import { AGENT_IDS, AGENTS } from "@/lib/hq/roster";

const PUB = resolve(__dirname, "../public");
const file = (f: string) => join(PUB, HQ_ASSETS.base, f);
type Entry = { kind: "authored" | "human"; file: string; tris: number; anims?: "m" | "f"; model?: string; face?: string };
const entry = (id: (typeof AGENT_IDS)[number]) => HQ_ASSETS.characters[id] as Entry;
const PEOPLE = AGENT_IDS.filter((id) => id !== "BASHT");
const libs: Readonly<Record<string, { file: string; clips: readonly string[]; walkSpeed: number }>> = HQ_ASSETS.anims;
const TRANSCODER = ["basis_transcoder.js", "basis_transcoder.wasm"].map((f) => HQ_ASSETS.transcoder + f);
const allFiles = () => [HQ_ASSETS.building.file, HQ_ASSETS.building.lightmap, ...AGENT_IDS.map((id) => entry(id).file),
  ...Object.values(libs).map((l) => l.file), ...HQ_ASSETS.licenses, ...TRANSCODER];
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
    for (const f of allFiles()) expect(existsSync(file(f)), f).toBe(true);
  });
  it("has 14 characters, one file each, and no two files are the same (no duplicated characters)", () => {
    expect(Object.keys(HQ_ASSETS.characters).sort()).toEqual([...AGENT_IDS].sort());
    const hashes = AGENT_IDS.map((id) => createHash("sha256").update(readFileSync(file(entry(id).file))).digest("hex"));
    expect(new Set(hashes).size).toBe(14);
  });
  it("BASHT is the authored robot: one skinned mesh, its own clips, one extra emissive material for the eyes", () => {
    const j = glbJson(file(entry("BASHT").file));
    expect(entry("BASHT").kind).toBe("authored");
    expect(j.skins?.length).toBe(1);
    expect(j.meshes.length).toBe(1);
    expect(j.materials.length).toBe(2);
    const names = j.nodes.map((n: { name?: string }) => n.name);
    for (const bone of ["hips", "spine", "chest", "head", "thigh.L", "shin.R", "upperarm.L", "hand.R"]) expect(names, bone).toContain(bone);
    expect(j.animations.map((a: { name: string }) => a.name).sort()).toEqual(["idle", "sit", "stand", "talk", "type", "walk"]);
    expect(j.extensionsUsed ?? []).toContain("EXT_meshopt_compression");
  });
  it("the 13 people are realistic avatars: one skinned mesh on the shared biped skeleton, no clips of their own", () => {
    const models = new Set<string>();
    for (const id of PEOPLE) {
      const e = entry(id);
      expect(e.kind, id).toBe("human");
      expect(e.model, id).toMatch(/^(Adults|Professions)\/(Male|Female|Business_Male|Business_Female)_/);
      const look = AGENTS[id].look;
      models.add(look.kind === "human" ? (look.face ?? look.model) : id);
      const sex = e.model!.includes("Female") ? "f" : "m";
      expect(e.anims, id).toBe(sex); // a woman must play the female captures and vice versa
      expect(look.kind === "human" && look.model, id).toBe(e.model);
      const j = glbJson(file(e.file));
      expect(j.skins?.length, id).toBe(1);
      expect(j.meshes.length, id).toBe(1);
      expect(j.animations ?? [], id).toEqual([]);
      const names = j.nodes.map((n: { name?: string }) => n.name);
      expect(names, id).toContain("RB_ROOT"); // the clips' root track binds to this node on every avatar
      for (const bone of ["Bip01 Pelvis", "Bip01 Spine2", "Bip01 Head", "Bip01 L Thigh", "Bip01 R Calf", "Bip01 L UpperArm", "Bip01 R Hand"])
        expect(names, `${id} ${bone}`).toContain(bone);
      // body, head, hair cards / headwear, and for a composed person the headdress crown: ≤ 4 draw calls; no normal maps
      expect(j.materials.length, id).toBeLessThanOrEqual(4);
      expect(j.materials.every((m: { normalTexture?: unknown }) => !m.normalTexture), id).toBe(true);
      // hair cards and lashes are alpha-TESTED (no sorting cost); only cloth that hangs free is double-sided
      for (const m of j.materials as { name: string; alphaMode?: string; doubleSided?: boolean }[]) {
        expect(m.alphaMode === "BLEND", `${id} ${m.name}`).toBe(false);
        if (/_(body|head)$/.test(m.name)) expect(m.doubleSided ?? false, `${id} ${m.name}`).toBe(false);
      }
      // every texture is KTX2 / Basis Universal (stays compressed on the GPU)
      for (const img of j.images) expect(img.mimeType, id).toBe("image/ktx2");
      expect(j.extensionsUsed ?? [], id).toContain("KHR_texture_basisu");
      expect(e.tris, id).toBeLessThan(11_000);
      expect(j.extensionsUsed ?? [], id).toContain("EXT_meshopt_compression");
    }
    expect(models.size).toBe(PEOPLE.length); // nobody shares a face (two people may share an outfit)
    expect(PEOPLE.reduce((n, id) => n + entry(id).tris, 0)).toBeLessThan(120_000); // the whole staff, every frame
  });
  it("one motion-capture library per skeleton carries every clip the simulation plays, at walking speed", () => {
    expect(Object.keys(libs).sort()).toEqual(["f", "m"]);
    for (const [k, lib] of Object.entries(libs)) {
      const j = glbJson(file(lib.file));
      expect(j.skins ?? [], k).toEqual([]);
      expect(j.meshes ?? [], k).toEqual([]);
      expect(j.animations.map((a: { name: string }) => a.name).sort(), k)
        .toEqual(["down_l", "down_r", "idle", "sit", "stand", "talk", "type", "up_l", "up_r", "walk"]);
      // only the root and pelvis travel: any other translation or scale channel is a constant (≤ 2 keys at rest
      // values — the exporter keeps every joint's channels) and the app drops it (lib/hq/people.ts keepTrack)
      const moving = new Set<string>();
      for (const a of j.animations) for (const c of a.channels as { sampler: number; target: { node: number; path: string } }[]) {
        if (c.target.path === "rotation") continue;
        const keys = j.accessors[a.samplers[c.sampler].input].count;
        if (keys > 2) moving.add(`${j.nodes[c.target.node].name}.${c.target.path}`);
      }
      expect([...moving].filter((n) => !/^(RB_ROOT|Bip01 Pelvis)\.translation$/.test(n)), k).toEqual([]);
      expect(moving.has("RB_ROOT.translation"), k).toBe(true); // seat height and in-place walk live on the root
      expect(lib.walkSpeed, k).toBeGreaterThan(1.1); // the simulation walks at 1.35 m/s: the capture must be close
      expect(lib.walkSpeed, k).toBeLessThan(1.6);
    }
  });
  it("ships the Microsoft Rocketbox MIT notice next to the avatars", () => {
    expect(HQ_ASSETS.licenses).toContain("LICENSE-rocketbox.txt");
    const t = readFileSync(file("LICENSE-rocketbox.txt"), "utf8");
    expect(t).toContain("MIT License");
    expect(t).toContain("Copyright (c) 2020 Microsoft");
    expect(t).toContain("Permission is hereby granted, free of charge");
  });
  it("textures are KTX2 / Basis (building and lightmap too) and the transcoder ships next to them (same origin)", () => {
    expect(HQ_ASSETS.textures).toBe("ktx2");
    expect(HQ_ASSETS.building.lightmap).toMatch(/\.ktx2$/);
    const lm = readFileSync(file(HQ_ASSETS.building.lightmap));
    expect(lm.subarray(1, 7).toString("latin1")).toBe("KTX 20"); // «KTX 20» magic
    const b = glbJson(file(HQ_ASSETS.building.file));
    for (const img of b.images ?? []) expect(img.mimeType).toBe("image/ktx2");
    for (const f of TRANSCODER) expect(existsSync(file(f)), f).toBe(true);
  });
  it("the building carries a lightmap UV set and stays inside the iPhone budget", () => {
    const j = glbJson(file(HQ_ASSETS.building.file));
    expect(j.meshes.length).toBeLessThanOrEqual(25); // one mesh per material → ≤ 25 draw calls for the whole building
    const attrs = new Set(j.meshes.flatMap((m: { primitives: { attributes: Record<string, number> }[] }) => m.primitives.flatMap((p) => Object.keys(p.attributes))));
    expect(attrs.has("TEXCOORD_1")).toBe(true);
    expect(HQ_ASSETS.building.tris).toBeLessThan(120_000);
    expect(HQ_ASSETS.building.lightmapScale).toBeGreaterThan(0);
  });
  it("keeps the whole HQ download under 15 MB (first view needs the building + lightmap + characters + clips)", () => {
    expect(HQ_ASSETS_TOTAL_BYTES).toBeLessThan(15e6);
    const sum = allFiles().reduce((s, f) => s + statSync(file(f)).size, 0);
    expect(sum).toBe(HQ_ASSETS_TOTAL_BYTES);
  });
});
