# BASHT HQ — 3D asset pipeline

All HQ art is **generated from code** (no purchased assets, no external artists): Blender running headless as a Python
module (`bpy`), driven by the same floor plan the web app, the walking graph and the collision tests use.

```
apps/web/lib/hq/layout.ts + roster.ts ──(HQ_WRITE_LAYOUT=1 pnpm test:web)──► tools/hq-assets/layout.json
                                                                                 │
                    blender/build_building.py ◄──────────────────────────────────┤
                    blender/build_characters.py ◄────────────────────────────────┘
                                 │  building.glb + lightmap-day.webp, <ID>.glb × 14
                                 ▼
                    publish.mjs ── meshopt (@gltf-transform/cli, pinned) ──► apps/web/public/hq-assets/v1-<hash>/
                                                                         └─► apps/web/lib/hq/assets.generated.ts
```

## Setup (once)

```bash
python3 -m venv ~/.hq-venv && ~/.hq-venv/bin/pip install bpy==5.3.0 numpy   # Blender 5.3 as a module, CPU only
export HQ_BLENDER_PY=~/.hq-venv/bin/python
```

## Build

| command | what | time (4 CPU cores) |
|---|---|---|
| `tools/hq-assets/build.sh building` | architecture, furniture, materials; Cycles bake of a 2048² lightmap (direct + indirect light) | ≈ 6 min |
| `tools/hq-assets/build.sh characters` | 14 skinned characters + 6 clips each (idle, walk, sit, type, talk, stand) | ≈ 10 s |
| `tools/hq-assets/build.sh lineup` | QA render of all characters (idle, walk) | ≈ 1 min |
| `tools/hq-assets/build.sh publish` | compress + copy into the app, regenerate `assets.generated.ts` | ≈ 30 s |
| `tools/hq-assets/build.sh all` | everything above except the lineup | |

## Design rules

- **The plan is the only source of geometry.** Walls, furniture and seats come from `layout.json`; nothing is placed by
  hand, so art can never disagree with the colliders and walking routes the tests verify.
- **Building = one mesh per material** (19 meshes). Static surfaces carry a second UV set (`TEXCOORD_1`) into one shared
  lightmap atlas; the app renders them with an unlit material × the baked light, so phones compute no lighting.
- **Characters = one skinned mesh + one material each** (per-corner colours), 2.7–4.2 k triangles, shared bone names
  (`root, hips, spine, chest, neck, head, upperarm/forearm/hand.L/R, thigh/shin/foot.L/R`). Poses are authored as
  rotations about the character's own axes and converted to each bone's local frame, so they never depend on bone roll.
  Robes use a dedicated weighting rule so a thobe/abaya swings as one garment instead of splitting into trousers.
- **Identity:** BASHT is modelled after the official mascot (purple robot, white dasmal with the red band, cyan smiling
  eyes, jambiya). The official logo itself is never re-drawn: the app applies `public/brand/basht-logo.webp` as a texture.
- **No duplicates:** every character file is built from its own roster entry; `apps/web/tests/hq-assets.test.ts` fails if
  two characters share a file hash.

## Known limits (and the planned upgrade)

| limit | why | next step |
|---|---|---|
| WebP lightmap, not KTX2 | `toktx` (KTX-Software) is not installable here | encode KTX2/UASTC in CI when the tool is available; three's KTX2Loader is ready |
| Night = dimmed day bake + glowing coves | one bake keeps the download small | a second (night) bake if the owner wants a stronger night mood |
| Stylised characters, procedural faces | generated from primitives in code | sculpt-quality heads and cloth folds are the main visual gap to the reference renders |
