# BASHT HQ — 3D asset pipeline

All HQ art is **generated from code** (no purchased assets, no external artists): Blender running headless as a Python
module (`bpy`), driven by the same floor plan the web app, the walking graph and the collision tests use. The 13 people
are built from **Microsoft Rocketbox** (MIT licence: realistic avatars + motion capture), composed and re-encoded by code;
the BASHT robot is modelled from scratch.

```
apps/web/lib/hq/layout.ts + roster.ts ──(HQ_WRITE_LAYOUT=1 pnpm test:web)──► tools/hq-assets/layout.json
                                                                                 │
                    blender/build_building.py ◄──────────────────────────────────┤
                    blender/build_characters.py ◄────────────────────────────────┤   (BASHT)
                    blender/build_humans.py ◄────────────────────────────────────┘   (13 people; needs $ROCKETBOX)
                                 │  building.glb + lightmap-day.webp, <ID>.glb × 14, anims-m/f.glb
                                 ▼
                    publish.mjs ── meshopt (@gltf-transform/cli, pinned) ──► apps/web/public/hq-assets/v1-<hash>/
                                                                         └─► apps/web/lib/hq/assets.generated.ts
```

## Setup (once)

```bash
python3 -m venv ~/.hq-venv && ~/.hq-venv/bin/pip install -r tools/hq-assets/requirements.txt   # Blender 5.3 as a module
export HQ_BLENDER_PY=~/.hq-venv/bin/python
git clone https://github.com/microsoft/Microsoft-Rocketbox ~/Microsoft-Rocketbox                 # ≈ 4 GB, no LFS needed
git -C ~/Microsoft-Rocketbox checkout 0943055db6ec570bcef9f2c8b41c9e5467c808f9                  # the revision we built from
export ROCKETBOX=~/Microsoft-Rocketbox
```

## Build

| command | what | time (4 CPU cores) |
|---|---|---|
| `tools/hq-assets/build.sh building` | architecture, furniture, materials; Cycles bake of a 2048² lightmap (direct + indirect light) | ≈ 6 min |
| `tools/hq-assets/build.sh characters` | BASHT: skinned robot + 6 clips (idle, walk, sit, type, talk, stand) | ≈ 1 s |
| `tools/hq-assets/build.sh humans` | 13 realistic people (Rocketbox, composed per `roster.ts`) + one mocap clip library per skeleton | ≈ 1 min |
| `tools/hq-assets/build.sh lineup` | QA render of all characters (idle, walk) | ≈ 1 min |
| `tools/hq-assets/build.sh publish` | compress + copy into the app, regenerate `assets.generated.ts` | ≈ 30 s |
| `tools/hq-assets/build.sh all` | everything above except the lineup | |

## Design rules

- **The plan is the only source of geometry.** Walls, furniture and seats come from `layout.json`; nothing is placed by
  hand, so art can never disagree with the colliders and walking routes the tests verify.
- **Building = one mesh per material** (19 meshes). Static surfaces carry a second UV set (`TEXCOORD_1`) into one shared
  lightmap atlas; the app renders them with an unlit material × the baked light, so phones compute no lighting.
- **People (realistic)** — see "Realistic people" below.
- **BASHT = one skinned mesh** (per-corner colours + emissive eyes), 3.3 k triangles, bone names
  (`root, hips, spine, chest, neck, head, upperarm/forearm/hand.L/R, thigh/shin/foot.L/R`). Poses are authored as
  rotations about the character's own axes and converted to each bone's local frame, so they never depend on bone roll.
  Robes use a dedicated weighting rule so a thobe/abaya swings as one garment instead of splitting into trousers.
- **Identity:** BASHT is modelled after the official mascot (purple robot, white dasmal with the red band, cyan smiling
  eyes, jambiya). The official logo itself is never re-drawn: the app applies `public/brand/basht-logo.webp` as a texture.
- **No duplicates:** every character file is built from its own roster entry; `apps/web/tests/hq-assets.test.ts` fails if
  two characters share a file hash.

## Realistic people (`blender/build_humans.py`)

Source: [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) — 115 rigged avatars and 471 motion-capture
clips, **MIT licence** (commercial use, modification and redistribution allowed; the notice must travel with the files —
`publish.mjs` ships `LICENSE-rocketbox.txt` next to the GLBs). Alternatives were researched and rejected for licence or
quality reasons (MakeHuman/MPFB2: CC0 but semi-realistic; MB-Lab/CharMorph: AGPL output; Renderpeople, Sketchfab
"Standard", Mixamo: clauses against shipping extractable files in a web app; Ready Player Me: shut down Jan 2026;
SMPL-X/AMASS/LAFAN1/Bandai Namco: non-commercial). Details: `docs/hq/REALISTIC-PEOPLE.md`.

How a person is made, from `look` in `apps/web/lib/hq/roster.ts`:

| field | effect |
|---|---|
| `model` | the outfit avatar (`Assets/Avatars/<model>`): body, clothes, shoes |
| `face` (optional) | another avatar of the same skeleton whose head replaces the outfit avatar's — faces are never reused |
| `head: "ghutra"` | the outfit's keffiyeh is re-coloured to a white ghutra (weave shading and black agal kept) |
| `head: "shemagh"` | the keffiyeh stays the red-check shemagh |
| `head: "hijab"` | a hijab cut from Female_Adult_06's head (cloth-coloured faces), tinted with `accent`; skipped for avatars already covered |

Under any headwear, hair cards above the brows are removed, hair or caps on the head shell are re-coloured as forehead skin
and every head vertex that would poke through the headwear is pulled 6 mm inside it (ray test from the skull centre); a
hijab's drape also tucks the collar and lapels under it. All Rocketbox adults of one sex share an identical skeleton, so
heads, headwear and clips move between them with no retargeting.

Clips (one GLB per skeleton, played by every person of that sex): `idle`, `walk` (a single gait cycle at 1.35 m/s — the
simulation's speed, so feet don't slide), `sit`, `type`, `talk` (seated, pelvis placed on the HQ chair cushion), `stand`.
Each Rocketbox take imports with its own rest pose, so clips are re-baked visually onto one host skeleton; loop points
are chosen where the pose repeats; only the root and pelvis keep translation keys (bone lengths stay the wearer's).

Phone budget: ≤ 10 k triangles and ≤ 4 materials per person (body, head, headwear/hair cards, crown), colour textures
only (head/body/cloth 512², no normal maps), WebP, meshopt — 13 people ≈ 3.6 MB on the wire.

## Known limits (and the planned upgrade)

| limit | why | next step |
|---|---|---|
| WebP lightmap, not KTX2 | `toktx` (KTX-Software) is not installable here | encode KTX2/UASTC in CI when the tool is available; three's KTX2Loader is ready |
| Night = dimmed day bake + glowing coves | one bake keeps the download small | a second (night) bake if the owner wants a stronger night mood |
| People are 2010s real-time quality | Rocketbox is the best freely licensed realistic set; MetaHuman-class quality needs paid/login-gated tools | KTX2 textures and a facial (`_facial.fbx`, ARKit/visemes) build when lip-sync is wanted |
| No typing capture | Rocketbox has seated idles and gestures, not keyboard typing | a CC0/CMU typing take retargeted with the same bake step |
