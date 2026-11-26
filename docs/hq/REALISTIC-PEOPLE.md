# BASHT HQ — Realistic people (HQ characters upgrade)

Status: implemented on `feat/basht-hq-frontend`. HQ is still disabled in production (`NEXT_PUBLIC_HQ_ENABLED`). BASHT stays the
official robot. Nothing was bought, and no account or login-gated service was used.

## 1. Decision

**Microsoft Rocketbox** (MIT) for the avatars and the motion capture. The faces, attire and headwear are composed in our own
reproducible Blender pipeline (`tools/hq-assets/blender/build_humans.py`).

| criterion | Rocketbox |
|---|---|
| Licence | MIT, "Copyright (c) 2020 Microsoft". Commercial use, modification and redistribution are allowed. The notice ships with the files (`public/hq-assets/<ver>/LICENSE-rocketbox.txt`). Built from revision `0943055d`. |
| Realism | Scanned-style faces and textures, real clothing, real-time game quality |
| Rig and motion | One biped skeleton per sex, identical across all adults, with 471 MIT mocap clips on the same skeleton. No retargeting is needed. |
| Phone fit | 6.5–10k triangles per person; colour textures only at 512² WebP; meshopt compression |
| Arab dress | 2 men in thobe and keffiyeh, 2 covered women. Composition (below) extends this to the whole team. |

## 2. Alternatives checked (licence pages read on 2026-11-26)

| Source | Verdict |
|---|---|
| MakeHuman 1.x / MPFB2 (CC0 assets) | Usable licence, but semi-realistic. Kept as the fallback for new faces or bodies. |
| MB-Lab / CharMorph | Rejected: generated models carry AGPL-3. |
| Renderpeople free scans | Rejected: §4.3(b) forbids data that users can "easily download, extract", and a web GLB is that. |
| 3D Scan Store free samples | Rejected: no commercial use without permission. |
| Sketchfab "Standard" | Rejected: §2.2 forbids extractable files. CC0/CC-BY models need an account. |
| Mixamo | Login (Adobe ID), and Adobe staff say raw character/animation files may not be distributed. |
| Ready Player Me | Shut down on 31 Jan 2026. |
| Avaturn, Reallusion CC, MetaHuman | Login/paid, or the terms are unclear for web embedding. Heavy. |
| SMPL-X, AMASS, LAFAN1, ZeroEGGS, Bandai Namco | Rejected: non-commercial or no-derivatives. |
| CMU mocap, Quaternius UAL (CC0), 100STYLE (CC BY) | Usable for future clips, such as typing. |

No source offers free, commercially licensed thobe, ghutra, abaya or hijab assets. That is why they are composed from the two
covered Rocketbox avatars of each sex.

## 3. How the 13 people are made

- `model` sets the outfit avatar and `face` sets another avatar's head (same skeleton), so faces are never reused.
- With `ghutra`, the keffiyeh is re-coloured white; the weave and black agal are kept. With `shemagh`, it stays red-check.
- With `hijab`, the hijab is cut from Female_Adult_06's head and tinted with the person's colour.
- Hair and caps under headwear are removed or tucked inside it (ray test). The hijab drape covers collar and lapels.
- Clips are idle, walk, sit, type, talk and stand. They are re-baked onto one host skeleton per sex.
  - Loops close seamlessly (≤ 3° per joint).
  - Walk is a single gait cycle at 1.35 m/s, the simulation's speed, so feet don't slide.
  - Seated clips keep the feet on the floor and the knees just past the front of the 0.50 m cushion.

| ID | Role | Attire | Outfit avatar | Face |
|---|---|---|---|---|
| MIZAN | المالية | thobe + white ghutra | Male_Adult_21 | Male_Adult_15 |
| MASAR | العمليات | thobe + red shemagh | Male_Adult_19 | Male_Adult_17 |
| MIYAR | الجودة | thobe + white ghutra | Male_Adult_21 | Male_Adult_07 |
| FURAS | المبيعات | thobe + red shemagh | Male_Adult_21 | own |
| SANAD | القانونية | thobe + white ghutra | Male_Adult_19 | own |
| MIMAR | التقنية | shirt and trousers | Business_Male_06 | own |
| BASIRA | ذكاء الأعمال | suit | Business_Male_05 | own |
| HASEEN | الأمن السيبراني | suit | Business_Male_03 | own |
| RAWAJ | التسويق | trouser suit + hijab (rose) | Business_Female_01 | own |
| NASAQ | الإدارة | long cardigan, trousers + hijab (navy) | Female_Adult_09 | own |
| RAFID | المشتريات | trouser suit + hijab (beige) | Business_Female_04 | own |
| WISAL | علاقات العملاء | abaya and headscarf | Female_Adult_10 | own |
| KAFAAT | الموارد البشرية | long dress + hijab | Female_Adult_06 | own |

The tests enforce the following:
- Faces are unique.
- Every woman wears a hijab.
- Thobes always come with a ghutra or shemagh.
- Each woman's face and outfit come from the same skeleton.
- The cast includes at least 4 thobes and at least 2 men's suits.

## 4. Performance (measured, SwiftShader e2e on an iPhone 14 viewport)

| | before (procedural) | now |
|---|---|---|
| Draw calls (whole HQ) | 33–37 | 63–67 (budget 150) |
| Triangles (whole HQ) | ~100k | ~150–162k (budget 400k) |
| People on the wire | ~1.3 MB | 13 people ≈ 3.6 MB + clips 0.9 MB |
| Whole HQ download | 3.15 MB | 5.5 MB (budget 15 MB) |

The real-iPhone check (iPhone 12+) is still pending on the owner's device.

## 5. Independent review (round 1) and fixes

An independent reviewer subagent checked the visuals, code, licence and performance of the first build (3aa9390).
- **Blockers:** none.
- **P1 and P2 findings:** all fixed except KTX2 textures, which need your approval for the encoder tool.
- **Licence:** verified OK. No notice files under Assets/ add any conditions, and the shipped notice matches the licence word for word.

| # | Finding | Fix |
|---|---|---|
| P1 | Seated people at the wrong height: men's feet floated 9–13 cm, women's sank 7 cm; cushions cut thighs. | Seated clips are now placed by the feet and knees: feet at standing ankle height, knees 0.30 m forward and centred. The HQ chair cushion is lowered to 0.50 m to match the capture chairs, and men get +2 cm. A test checks feet, pelvis and knees for every seated clip. |
| P1 | Holes in the hijab drapes; shredded hem on KAFAAT; ragged hair cards. | The hijab is cut as connected cloth regions with holes closed, and stray islands dropped. The alpha cut moved from 0.5 to 0.3. KAFAAT's fringe cards are removed. |
| P1 | Loops snapped at the wrap: talk up to 140°, stand ~25°, sit ~20°. | Loop points are chosen on joint positions and rotations. Any residual difference is spread over the whole clip, and every frame is exported. A test requires each joint to wrap within 3°. |
| P2 | Joints with constant motion were dropped and fell back to the bind pose (fingers 4–55°). | Every joint keeps its track. A test checks every non-Nub joint in every clip. |
| P2 | Builds not varied. | The roster's `build` now changes width and depth (slim 0.95 / broad 1.06) on top of height. |
| P2 | One Skeleton per material: 43 skeletons uploaded per frame. | All of a person's materials share one skeleton: 13 per frame. |
| P2 | About 60 MB GPU texture memory. | Open: KTX2 needs the encoder tool (owner approval). |
| P3 | Walk rate ignored body scale; label height; docstring; extras; copyright. | All fixed. `extras` are documented as greybox-only, and the GLBs carry `asset.copyright`. |

### Round 2 (review of 86d353d) and fixes

Round 2 confirmed several round-1 fixes: seamless loops, full joint tracks, the shared skeleton, the licence and the faces.

| # | Finding | Fix |
|---|---|---|
| P1 | Seated women: the hijab or abaya stuck out about 10 cm behind the chair backrest. | Seat depth set per sex: knees 0.42 m forward for women, 0.34 m for men. A test keeps the hips in front of the backrest. Checked in the app from behind the meeting table. |
| P2 | The jacket showed through the hijab drape while the arms moved. | The drape below the chin is inflated 1.5 cm. |
| P2 | Scaled-down men's feet floated 4–5.5 cm when seated. | `seatLift(s)` splits the difference: hips at most about 1.5 cm into the cushion, feet at most about 1.5 cm off the floor. The male capture lift is now 1 cm. A test covers body scales 0.93, 1 and 1.03. |
| P2 | Standing up and sitting down blended through the chair in 0.28 s. | Seated↔walking blends take 0.5 s, so the body rises while it moves clear. A proper stand-up phase needs the simulation to pause at the seat: listed below. |
| P2 | Build width stretched faces (±5–6 %). | Reduced to ±3–4 %. |
| P2 | HASEEN's hair cards looked ragged. | Recast to Business_Male_03, which has modelled hair. |
| P2 | Leftover crown faces cost a 512² texture and a draw call each for 3 people. | Removed (the crown belongs to the keffiyeh mesh). Now 60–64 draw calls and 62 textures. |
| P3 | Walk rate ignored build width. The walk test only checked a formula. The knee threshold was below the cushion edge. Stale comment. Skeleton textures were never freed. | All fixed. The walk test now measures the planted foot's speed from the shipped clip. Knees must reach past 0.24 m. Skeletons are disposed on unmount, and seated actions are precomputed. |

Still open:
- Cloth (thobe or abaya hem) hangs through the cushion when seated. This needs cloth simulation; it is hidden at normal camera angles.
- Body textures are not shared between people who wear the same outfit (separate files).
- KTX2.

## 6. Open items for the owner

1. Approve the casting and attire mix above. Any person can be re-cast by editing `look` in `roster.ts` and running `build.sh humans`.
2. Optional: allow KTX2 texture encoding (needs the KTX-Software tool). This cuts GPU memory by about 4–6× on phones.
3. Optional: a seated typing clip (CMU or Quaternius CC0, retargeted with the same bake step).
4. Optional: a stand-up / sit-down phase. The simulation would hold a person at the chair for about 0.8 s, and Rocketbox's sit-down and stand-up takes would play. It changes the simulation's timing, so it is proposed rather than done.
