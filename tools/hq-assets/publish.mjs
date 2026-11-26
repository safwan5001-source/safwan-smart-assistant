// BASHT HQ — publish built assets into the web app.
//   node tools/hq-assets/publish.mjs <build-out-dir>
// 1. meshopt-compresses every GLB (@gltf-transform/cli, pinned) into apps/web/public/hq-assets/<version>/
// 2. copies the lightmap and the third-party licence notices (realistic people: Microsoft Rocketbox, MIT)
// 3. writes apps/web/lib/hq/assets.generated.ts (the app imports it: no runtime manifest fetch)
// The version folder is a hash of the INPUTS (plan, generator scripts, tool versions): rebuilding unchanged sources gives the
// same version and publish does nothing (no binary churn in git); any real change gets a new immutable folder. The previous
// folder is kept so a client still running the last build keeps its art until it reloads.
import { execFileSync } from "node:child_process";
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
const need = ["building.glb", "lightmap-day.webp", "building.json", ...ids.map((id) => `${id}.glb`), ...animLibs.map((s) => `anims-${s}.glb`)];
for (const f of need) if (!existsSync(join(SRC, f))) throw new Error(`missing ${f} in ${SRC} — run build.sh building/characters first`);

// version = hash of everything that determines the art
const inputs = createHash("sha256");
for (const f of ["layout.json", "publish.mjs", ...readdirSync(join(HERE, "blender")).filter((f) => f.endsWith(".py")).sort().map((f) => "blender/" + f)])
  inputs.update(f).update(readFileSync(join(HERE, f)));
inputs.update(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).devDependencies["@gltf-transform/cli"]);
inputs.update(`rocketbox:${humans.rocketbox ?? "-"}`);
inputs.update(execFileSync(process.env.HQ_BLENDER_PY ?? "python3", ["-c", "import bpy, numpy; print(bpy.app.version_string, numpy.__version__)"]).toString());
const version = "v1-" + inputs.digest("hex").slice(0, 10);
if (existsSync(join(PUB, version)) && !process.argv.includes("--force")) {
  console.log(`up to date: public/hq-assets/${version}/ already holds this exact source (use --force to republish)`);
  process.exit(0);
}

const tmp = join(SRC, "_publish");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const meshopt = (name) => {
  execFileSync(GLTF_TRANSFORM, ["meshopt", join(SRC, name), join(tmp, name), "--level", "medium"], { stdio: "inherit" });
};
meshopt("building.glb");
for (const id of ids) meshopt(`${id}.glb`);
for (const s of animLibs) meshopt(`anims-${s}.glb`);
copyFileSync(join(SRC, "lightmap-day.webp"), join(tmp, "lightmap-day.webp"));
if (humanIds.length) copyFileSync(join(HERE, "licenses/rocketbox-LICENSE.txt"), join(tmp, "LICENSE-rocketbox.txt"));

const files = readdirSync(tmp).sort();
// keep only the version currently published (becomes N-1) and the new one
const previous = (() => { try { return /"base": "\/hq-assets\/(v1-[0-9a-f]+)\//.exec(readFileSync(join(WEB, "lib/hq/assets.generated.ts"), "utf8"))?.[1]; } catch { return undefined; } })();
for (const d of existsSync(PUB) ? readdirSync(PUB) : []) if (d.startsWith("v") && d !== previous) rmSync(join(PUB, d), { recursive: true, force: true });
const dest = join(PUB, version);
mkdirSync(dest, { recursive: true });
for (const f of files) copyFileSync(join(tmp, f), join(dest, f));
rmSync(tmp, { recursive: true, force: true });

const size = (f) => statSync(join(dest, f)).size;
const b = JSON.parse(readFileSync(join(SRC, "building.json"), "utf8"));
const chars = JSON.parse(readFileSync(join(SRC, "characters.json"), "utf8"));
const manifest = {
  version,
  base: `/hq-assets/${version}/`,
  building: { file: "building.glb", bytes: size("building.glb"), tris: b.tris, lightmap: "lightmap-day.webp", lightmapBytes: size("lightmap-day.webp"), lightmapScale: Number(b.lightmapScale.toFixed(4)) },
  characters: Object.fromEntries(ids.map((id) => {
    const h = humans.avatars[id];
    return [id, h
      ? { kind: "human", file: `${id}.glb`, bytes: size(`${id}.glb`), tris: h.tris, model: h.model, height: h.height, anims: h.sex }
      : { kind: "authored", file: `${id}.glb`, bytes: size(`${id}.glb`), tris: chars[id].tris }];
  })),
  /** shared motion-capture clip libraries for the people (one per skeleton) */
  anims: Object.fromEntries(animLibs.map((s) => [s, { file: `anims-${s}.glb`, bytes: size(`anims-${s}.glb`), clips: Object.keys(humans.anims[s].clips), walkSpeed: humans.anims[s].clips.walk.speed }])),
  licenses: humanIds.length ? ["LICENSE-rocketbox.txt"] : [],
};
const total = files.reduce((s, f) => s + size(f), 0);
writeFileSync(join(WEB, "lib/hq/assets.generated.ts"),
  `/* GENERATED by tools/hq-assets/publish.mjs — do not edit. Rebuild: tools/hq-assets/build.sh all */\n` +
  `export const HQ_ASSETS = ${JSON.stringify(manifest, null, 2)} as const;\n` +
  `export const HQ_ASSETS_TOTAL_BYTES = ${total};\n`);
console.log(`published ${files.length} files (${(total / 1e6).toFixed(2)} MB) → public/hq-assets/${version}/`);
