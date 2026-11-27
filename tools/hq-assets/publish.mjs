// BASHT HQ — publish built assets into the web app.
//   node tools/hq-assets/publish.mjs <build-out-dir>
// 1. textures → KTX2 / Basis Universal (KTX-Software `toktx` 4.4.0, Apache-2.0; dev-time only): every GLB texture as ETC1S,
//    the lightmap as UASTC — GPUs keep them compressed (≈ 4–8× less video memory than RGBA on a phone)
// 2. meshopt-compresses every GLB (@gltf-transform/cli, pinned) into apps/web/public/hq-assets/<version>/
// 3. copies the Basis transcoder that ships inside the three package (same origin, no CDN) and the third-party licence
//    notices (realistic people: Microsoft Rocketbox, MIT)
// 3. writes apps/web/lib/hq/assets.generated.ts (the app imports it: no runtime manifest fetch)
// The version folder is a hash of the INPUTS (plan, generator scripts, tool versions): rebuilding unchanged sources gives the
// same version and publish does nothing (no binary churn in git); any real change gets a new immutable folder. The previous
// folder is kept so a client still running the last build keeps its art until it reloads.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = resolve(import.meta.dirname);
const SRC = resolve(process.argv[2] ?? join(HERE, "out"));
const WEB = resolve(HERE, "../../apps/web");
const PUB = join(WEB, "public/hq-assets");
const ROOT = resolve(HERE, "../..");
const GLTF_TRANSFORM = join(ROOT, "node_modules/.bin/gltf-transform"); // pinned in the root package.json / lockfile
const plan = JSON.parse(readFileSync(join(HERE, "layout.json"), "utf8"));
const ids = plan.characters.map((c) => c.id);
// realistic people (build.sh humans) replace the procedural stand-ins of the same id; BASHT stays the authored robot
const humans = existsSync(join(SRC, "humans.json")) ? JSON.parse(readFileSync(join(SRC, "humans.json"), "utf8")) : { avatars: {}, anims: {} };
const humanIds = ids.filter((id) => humans.avatars[id]);
const animLibs = [...new Set(humanIds.map((id) => humans.avatars[id].sex))].sort();
const need = ["building.glb", "lightmap-day.png", "building.json", ...ids.map((id) => `${id}.glb`), ...animLibs.map((s) => `anims-${s}.glb`)];
// KTX-Software: HQ_KTX_BIN (its bin/ folder) or PATH; the exact version is part of the asset version below
const KTX_BIN = process.env.HQ_KTX_BIN;
const env = { ...process.env, PATH: KTX_BIN ? `${KTX_BIN}:${process.env.PATH}` : process.env.PATH };
let toktxVersion;
{
  const r = spawnSync("toktx", ["--version"], { env, encoding: "utf8" }); // prints to stderr
  if (r.error) throw new Error("toktx (KTX-Software 4.4.0) not found: set HQ_KTX_BIN — see tools/hq-assets/README.md");
  toktxVersion = `${r.stdout}${r.stderr}`.trim();
}
if (!/v4\.4\.0/.test(toktxVersion)) throw new Error(`KTX-Software 4.4.0 required, found ${toktxVersion}`);
const BASIS = resolve(WEB, "node_modules/three/examples/jsm/libs/basis"); // the three version the app ships
for (const f of need) if (!existsSync(join(SRC, f))) throw new Error(`missing ${f} in ${SRC} — run build.sh building/characters first`);

// version = hash of everything that determines the art
const inputs = createHash("sha256");
for (const f of ["layout.json", "publish.mjs", ...readdirSync(join(HERE, "blender")).filter((f) => f.endsWith(".py")).sort().map((f) => "blender/" + f)])
  inputs.update(f).update(readFileSync(join(HERE, f)));
inputs.update(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).devDependencies["@gltf-transform/cli"]);
inputs.update(`rocketbox:${humans.rocketbox ?? "-"}`);
inputs.update(`${toktxVersion}|three:${JSON.parse(readFileSync(resolve(WEB, "node_modules/three/package.json"), "utf8")).version}`);
inputs.update(execFileSync(process.env.HQ_BLENDER_PY ?? "python3", ["-c", "import bpy, numpy; print(bpy.app.version_string, numpy.__version__)"]).toString());
const version = "v1-" + inputs.digest("hex").slice(0, 10);
if (existsSync(join(PUB, version)) && !process.argv.includes("--force")) {
  console.log(`up to date: public/hq-assets/${version}/ already holds this exact source (use --force to republish)`);
  process.exit(0);
}

const tmp = join(SRC, "_publish");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
// textures: ETC1S at the top quality level (faces and fabrics), mipmapped; then meshopt
const pack = (name) => {
  const mid = join(tmp, `_${name}`);
  execFileSync(GLTF_TRANSFORM, ["etc1s", join(SRC, name), mid, "--quality", "255", "--compression", "2"], { stdio: "inherit", env });
  execFileSync(GLTF_TRANSFORM, ["meshopt", mid, join(tmp, name), "--level", "medium"], { stdio: "inherit", env });
  rmSync(mid);
};
pack("building.glb");
for (const id of ids) pack(`${id}.glb`);
for (const s of animLibs) execFileSync(GLTF_TRANSFORM, ["meshopt", join(SRC, `anims-${s}.glb`), join(tmp, `anims-${s}.glb`), "--level", "medium"], { stdio: "inherit" });
// the lightmap is smooth gradients over large walls: UASTC (ASTC-class quality; ETC1S blocks show on plain walls), with
// rate-distortion optimisation + Zstandard to keep the download near 2 MB
execFileSync("toktx", ["--t2", "--encode", "uastc", "--uastc_quality", "2", "--uastc_rdo_l", "5", "--zcmp", "19", "--genmipmap", "--assign_oetf", "srgb", "--assign_primaries", "bt709",
  join(tmp, "lightmap-day.ktx2"), join(SRC, "lightmap-day.png")], { stdio: "inherit", env });
mkdirSync(join(tmp, "basis"));
for (const f of ["basis_transcoder.js", "basis_transcoder.wasm"]) copyFileSync(join(BASIS, f), join(tmp, "basis", f));
if (humanIds.length) copyFileSync(join(HERE, "licenses/rocketbox-LICENSE.txt"), join(tmp, "LICENSE-rocketbox.txt"));

const files = readdirSync(tmp, { recursive: true }).map(String).filter((f) => statSync(join(tmp, f)).isFile()).sort();
// keep only the version currently published (becomes N-1) and the new one
const previous = (() => { try { return /"base": "\/hq-assets\/(v1-[0-9a-f]+)\//.exec(readFileSync(join(WEB, "lib/hq/assets.generated.ts"), "utf8"))?.[1]; } catch { return undefined; } })();
for (const d of existsSync(PUB) ? readdirSync(PUB) : []) if (d.startsWith("v") && d !== previous) rmSync(join(PUB, d), { recursive: true, force: true });
const dest = join(PUB, version);
mkdirSync(dest, { recursive: true });
mkdirSync(join(dest, "basis"), { recursive: true });
for (const f of files) copyFileSync(join(tmp, f), join(dest, f));
rmSync(tmp, { recursive: true, force: true });

const size = (f) => statSync(join(dest, f)).size;
const b = JSON.parse(readFileSync(join(SRC, "building.json"), "utf8"));
const chars = JSON.parse(readFileSync(join(SRC, "characters.json"), "utf8"));
const manifest = {
  version,
  base: `/hq-assets/${version}/`,
  /** every texture is KTX2 / Basis Universal; the transcoder lives next to the assets */
  textures: "ktx2",
  transcoder: "basis/",
  building: { file: "building.glb", bytes: size("building.glb"), tris: b.tris, lightmap: "lightmap-day.ktx2", lightmapBytes: size("lightmap-day.ktx2"), lightmapScale: Number(b.lightmapScale.toFixed(4)) },
  characters: Object.fromEntries(ids.map((id) => {
    const h = humans.avatars[id];
    return [id, h
      ? { kind: "human", file: `${id}.glb`, bytes: size(`${id}.glb`), tris: h.tris, model: h.model, height: h.height, anims: h.sex }
      : { kind: "authored", file: `${id}.glb`, bytes: size(`${id}.glb`), tris: chars[id].tris }];
  })),
  /** shared motion-capture clip libraries for the people (one per skeleton) */
  anims: Object.fromEntries(animLibs.map((s) => [s, {
    file: `anims-${s}.glb`, bytes: size(`anims-${s}.glb`), clips: Object.keys(humans.anims[s].clips), walkSpeed: humans.anims[s].clips.walk.speed,
    /** sit-down / stand-up takes: duration, the standing end's hip position (seat-local, metres; the seated person faces
     *  +z) and facing (yaw) — the simulation hands over to / from walking there */
    transitions: Object.fromEntries(Object.entries(humans.anims[s].clips).filter(([k]) => /^(up|down)_[lr]$/.test(k))
      .map(([k, c]) => [k, { seconds: c.seconds, stand: c.stand, yaw: c.yaw }])),
  }])),
  licenses: humanIds.length ? ["LICENSE-rocketbox.txt"] : [],
};
const total = files.reduce((s, f) => s + size(f), 0);
writeFileSync(join(WEB, "lib/hq/assets.generated.ts"),
  `/* GENERATED by tools/hq-assets/publish.mjs — do not edit. Rebuild: tools/hq-assets/build.sh all */\n` +
  `export const HQ_ASSETS = ${JSON.stringify(manifest, null, 2)} as const;\n` +
  `export const HQ_ASSETS_TOTAL_BYTES = ${total};\n`);
console.log(`published ${files.length} files (${(total / 1e6).toFixed(2)} MB) → public/hq-assets/${version}/`);
