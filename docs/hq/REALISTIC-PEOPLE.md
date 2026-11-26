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
- Clips are idle, walk, sit, type, talk and stand. They are re-baked onto one host skeleton per sex, and loop points are picked where the pose repeats.
  - Walk is a single gait cycle at 1.35 m/s, the simulation's speed, so feet don't slide.
  - Seated clips put the pelvis on the HQ chair cushion.

| ID | Role | Attire | Outfit avatar | Face |
|---|---|---|---|---|
| MIZAN | المالية | thobe + white ghutra | Male_Adult_21 | Male_Adult_15 |
| MASAR | العمليات | thobe + red shemagh | Male_Adult_19 | Male_Adult_17 |
| MIYAR | الجودة | thobe + white ghutra | Male_Adult_21 | Male_Adult_07 |
| FURAS | المبيعات | thobe + red shemagh | Male_Adult_21 | own |
| SANAD | القانونية | thobe + white ghutra | Male_Adult_19 | own |
| MIMAR | التقنية | shirt and trousers | Business_Male_06 | own |
| BASIRA | ذكاء الأعمال | suit | Business_Male_05 | own |
| HASEEN | الأمن السيبراني | suit | Business_Male_01 | own |
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

## 5. Open items for the owner

1. Approve the casting and attire mix above. Any person can be re-cast by editing `look` in `roster.ts` and running `build.sh humans`.
2. Optional: allow KTX2 texture encoding (needs the KTX-Software tool). This cuts GPU memory by about 4–6× on phones.
3. Optional: a seated typing clip (CMU or Quaternius CC0, retargeted with the same bake step).
