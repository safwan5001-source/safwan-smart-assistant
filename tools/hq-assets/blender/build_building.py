"""
BASHT HQ — building generator (Blender, headless).

    tools/hq-assets/build.sh building          # or: python tools/hq-assets/blender/build_building.py --out <dir>

Reads tools/hq-assets/layout.json (exported from apps/web/lib/hq/layout.ts; a unit test keeps it in sync) and builds the
architecture, furniture and finishes, bakes a lightmap with Cycles, and exports:
  building.glb              one mesh per material, UV0 = surface texture, UV1 = lightmap
  lightmap-day.png          baked diffuse lighting (direct + indirect), applied at runtime as material.lightMap (uv channel 1)
Every dimension comes from the plan, so walls and furniture sit exactly where the walking graph and colliders expect them.
"""
import argparse
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402
from common import B, MeshSink, hex_rgba, principled, reset_scene, select_only  # noqa: E402
import textures  # noqa: E402

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, ".."))

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=os.path.join(ROOT, "out"))
ap.add_argument("--samples", type=int, default=96)
ap.add_argument("--lightmap", type=int, default=2048)
ap.add_argument("--no-bake", action="store_true")
args, _ = ap.parse_known_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
os.makedirs(args.out, exist_ok=True)

PLAN = json.load(open(os.path.join(ROOT, "layout.json")))
BLD = PLAN["building"]
T0 = time.time()
reset_scene()

# ── materials (PBR; names are stable ids the web app keys lightmap and night settings on) ─────────────────────────────
M = {
    "marble": principled("marble", "#ece7ee", rough=0.22),
    "oak": principled("oak", "#c59a6d", rough=0.55),
    "carpet_exec": principled("carpet_exec", "#2f1b55", rough=0.95),
    "wall": principled("wall", "#f4f0f7", rough=0.8),
    "wall_accent": principled("wall_accent", "#4b2a83", rough=0.6),
    "gold": principled("gold", "#d4a94e", rough=0.28, metal=1.0),
    "dark": principled("dark", "#2a2236", rough=0.45, metal=0.3),
    "walnut": principled("walnut", "#6e4630", rough=0.45),
    "lacquer": principled("lacquer", "#f6f3ee", rough=0.3),
    "fabric": principled("fabric", "#ece3f1", rough=0.92),
    "velvet": principled("velvet", "#4a2a80", rough=0.85),
    "leather": principled("leather", "#1f1a29", rough=0.42),
    "leaf": principled("leaf", "#4d8a43", rough=0.7),
    "ceramic": principled("ceramic", "#f2ede6", rough=0.35),
    "books": principled("books", "#8b5e3c", rough=0.7),
    "foundation": principled("foundation", "#3a2160", rough=0.6),
    "glass": principled("glass", "#dcd3f7", rough=0.04, alpha=0.18),
    "screen": principled("screen", "#1a1244", rough=0.3, emission="#5b4bd6", emission_strength=2.0),
    "glow": principled("glow", "#ffd88a", rough=0.5, emission="#ffcf7a", emission_strength=6.0),
}
# tileable surface textures (procedural, deterministic) on the big floors; texture repeat in metres per tile
TEXTURED = {"marble": (textures.marble, 4.0), "oak": (textures.oak, 2.0), "carpet_exec": (textures.carpet, 1.5)}
for mname, (fn, _) in TEXTURED.items():
    img = textures.to_blender_image(bpy, "tex_" + mname, fn())
    nt = M[mname].node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Linear"
    nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
S = MeshSink()

# ── floors ───────────────────────────────────────────────────────────────────
S.add_box(M["foundation"], BLD["x0"] - 0.35, BLD["x1"] + 0.35, -0.55, -0.02, BLD["z0"] - 0.35, BLD["z1"] + 0.35, bevel=0.06)
S.add_box(M["marble"], BLD["x0"], BLD["x1"], -0.02, 0.0, BLD["z0"], BLD["z1"])
for o in PLAN["offices"]:
    r = o["rect"]
    y = 0.14 if o["exec"] else 0.02
    S.add_box(M["carpet_exec"] if o["exec"] else M["oak"], r["x0"], r["x1"], 0.0, y, r["z0"], r["z1"])
    if o["exec"]:
        S.add_box(M["gold"], r["x0"], r["x1"], y, y + 0.012, r["z1"] - 0.06, r["z1"])  # gold step nosing
for key in ("meeting", "library"):
    r = PLAN["zones"][key]["rect"]
    S.add_box(M["oak"], r["x0"], r["x1"], 0.0, 0.02, r["z0"], r["z1"])

# ── walls ────────────────────────────────────────────────────────────────────
CUT_H = 0.9  # doll-house cut: exterior walls on the camera side are low (matches the web app)


def wall_height(w):
    if w["kind"] != "exterior":
        return w["h"]
    return w["h"] if w["z0"] <= BLD["z0"] + 0.01 else CUT_H


for w in PLAN["walls"]:
    h = wall_height(w)
    x0, x1, z0, z1 = w["x0"], w["x1"], w["z0"], w["z1"]
    along_x = (x1 - x0) > (z1 - z0)
    length = (x1 - x0) if along_x else (z1 - z0)
    if w["kind"] == "glass":
        S.add_box(M["glass"], x0 + 0.02 if not along_x else x0, x1 - 0.02 if not along_x else x1, 0.06, h - 0.06, z0 + (0.03 if along_x else 0), z1 - (0.03 if along_x else 0))
        S.add_box(M["gold"], x0, x1, h - 0.06, h, z0, z1)
        S.add_box(M["dark"], x0, x1, 0.0, 0.06, z0, z1)
        n = max(1, round(length / 1.6))
        for i in range(n + 1):
            t = (x0 if along_x else z0) + length * i / n
            if along_x:
                S.add_box(M["gold"], t - 0.022, t + 0.022, 0.0, h, z0 - 0.005, z1 + 0.005)
            else:
                S.add_box(M["gold"], x0 - 0.005, x1 + 0.005, 0.0, h, t - 0.022, t + 0.022)
    else:
        S.add_box(M["wall"], x0, x1, 0.0, h, z0, z1, bevel=0.01)
        S.add_box(M["gold"], x0 - 0.004, x1 + 0.004, h - 0.045, h, z0 - 0.004, z1 + 0.004)
        if w["kind"] == "solid":
            S.add_box(M["wall_accent"], x0 - 0.006, x1 + 0.006, 0.0, 0.95, z0 - 0.006, z1 + 0.006)
            S.add_box(M["gold"], x0 - 0.008, x1 + 0.008, 0.95, 0.975, z0 - 0.008, z1 + 0.008)
            S.add_box(M["glow"], x0 - 0.012, x1 + 0.012, h - 0.17, h - 0.12, z0 - 0.012, z1 + 0.012)
        else:
            S.add_box(M["wall_accent"], x0 - 0.006, x1 + 0.006, 0.0, 0.12, z0 - 0.006, z1 + 0.006)

# ── furniture (local frame: front faces +z, origin on the floor at the item centre) ───────────────────────────────────


def lift(f):
    return 0.14 if f.get("office") == "BASHT" else 0.02


def part(f, mat, lx0, lx1, y0, y1, lz0, lz1, bevel=0.0):
    ax, az = f["at"]
    yb = lift(f)
    S.add_box(M[mat], ax + lx0, ax + lx1, yb + y0, yb + y1, az + lz0, az + lz1, bevel=bevel, rot=f["yaw"], pivot=(ax, az))


def cyl(f, mat, lx, lz, y0, y1, r0, r1=None, segs=20):
    ax, az = f["at"]
    yb = lift(f)
    S.add_cyl(M[mat], ax + lx, az + lz, yb + y0, yb + y1, r0, r1, segs=segs, rot=f["yaw"], pivot=(ax, az))


def sphere(f, mat, lx, y, lz, r, sy=1.0, subdiv=2):
    ax, az = f["at"]
    S.add_sphere(M[mat], ax + lx, lift(f) + y, az + lz, r, sy=sy, subdiv=subdiv, rot=f["yaw"], pivot=(ax, az))


def build_item(f):
    k, w, d, h = f["kind"], f["w"], f["d"], f["h"]
    hw, hd = w / 2, d / 2
    if k in ("desk", "exec-desk"):
        top = 0.05 if k == "desk" else 0.07
        part(f, "walnut", -hw, hw, h - top, h, -hd, hd, bevel=0.012)
        part(f, "dark" if k == "desk" else "leather", -hw + 0.03, -hw + 0.09, 0, h - top, -hd + 0.05, hd - 0.05, bevel=0.01)
        part(f, "dark" if k == "desk" else "leather", hw - 0.09, hw - 0.03, 0, h - top, -hd + 0.05, hd - 0.05, bevel=0.01)
        part(f, "dark" if k == "desk" else "leather", -hw + 0.09, hw - 0.09, 0.28, h - top, hd - 0.06, hd - 0.03)
        part(f, "gold", -hw + 0.09, hw - 0.09, h - top - 0.05, h - top - 0.03, hd - 0.03, hd - 0.015)
        if k == "exec-desk":
            part(f, "velvet", -0.45, 0.45, 0.15, h - 0.2, hd - 0.03, hd - 0.01)
        # keyboard and a document tray (the person sits at -z)
        part(f, "dark", -0.22, 0.22, h, h + 0.02, -hd + 0.12, -hd + 0.27, bevel=0.005)
    elif k in ("chair", "exec-chair"):
        mat = "velvet" if k == "chair" else "leather"
        sh = 0.46
        part(f, mat, -0.24, 0.24, sh, sh + 0.08, -0.22, 0.24, bevel=0.03)
        part(f, mat, -0.23, 0.23, sh + 0.08, h, -0.27, -0.19, bevel=0.03)
        if k == "exec-chair":
            part(f, "gold", -0.2, 0.2, h - 0.06, h - 0.035, -0.28, -0.18)
            part(f, mat, -0.3, -0.25, sh + 0.05, sh + 0.25, -0.15, 0.2, bevel=0.02)
            part(f, mat, 0.25, 0.3, sh + 0.05, sh + 0.25, -0.15, 0.2, bevel=0.02)
        cyl(f, "dark", 0, 0, 0.06, sh, 0.03)
        cyl(f, "dark", 0, 0, 0.02, 0.07, 0.26, 0.24, segs=5)  # five-star base
    elif k == "monitor":
        part(f, "dark", -hw, hw, 0.12, h, -0.02, 0.02, bevel=0.008)
        part(f, "screen", -hw + 0.02, hw - 0.02, 0.14, h - 0.02, 0.02, 0.024)
        part(f, "dark", -0.03, 0.03, 0.0, 0.14, -0.04, 0.0)
        part(f, "dark", -0.12, 0.12, 0.0, 0.015, -0.1, 0.06)
    elif k == "cabinet":
        part(f, "lacquer", -hw, hw, 0.04, h, -hd, hd, bevel=0.012)
        part(f, "dark", -hw + 0.02, hw - 0.02, 0.0, 0.04, -hd + 0.02, hd - 0.02)
        for i in (1, 2):
            y = h * i / 3
            part(f, "gold", -hw + 0.06, hw - 0.06, y - 0.008, y + 0.008, hd, hd + 0.008)
        cyl(f, "ceramic", hw * 0.45, 0, h, h + 0.22, 0.06, 0.08, segs=12)
    elif k == "plant":
        r = min(w, d) / 2
        S.add_lathe(M["ceramic"], f["at"][0], f["at"][1], [(r * 0.55, lift(f)), (r * 0.75, lift(f) + 0.05), (r * 0.8, lift(f) + h * 0.3), (r * 0.72, lift(f) + h * 0.32)], segs=20)
        cyl(f, "gold", 0, 0, h * 0.3, h * 0.33, r * 0.82, r * 0.82, segs=20)
        cyl(f, "walnut", 0, 0, h * 0.3, h * 0.55, 0.025, 0.02, segs=6)
        for i in range(9):
            a = i * 2.39996
            rr = r * (0.25 + 0.45 * ((i * 37) % 10) / 10)
            sphere(f, "leaf", math.cos(a) * rr, h * (0.55 + 0.4 * ((i * 53) % 10) / 10), math.sin(a) * rr, r * (0.42 + 0.2 * ((i * 17) % 10) / 10), sy=1.25, subdiv=1)
    elif k == "prop":
        part(f, "lacquer", -hw * 0.8, hw * 0.8, 0, h * 0.7, -hd * 0.8, hd * 0.8, bevel=0.02)
        part(f, "gold", -hw * 0.85, hw * 0.85, h * 0.7, h * 0.74, -hd * 0.85, hd * 0.85)
        sphere(f, "ceramic", 0, h * 0.86, 0, 0.13, sy=1.0)
    elif k in ("sofa", "armchair"):
        mat = "fabric" if k == "sofa" else "velvet"
        part(f, "dark", -hw + 0.05, hw - 0.05, 0.0, 0.08, -hd + 0.05, hd - 0.05)
        part(f, mat, -hw, hw, 0.08, 0.42, -hd, hd, bevel=0.05)
        part(f, mat, -hw, hw, 0.42, h, -hd, -hd + 0.22, bevel=0.06)
        part(f, mat, -hw, -hw + 0.16, 0.42, 0.62, -hd + 0.1, hd, bevel=0.05)
        part(f, mat, hw - 0.16, hw, 0.42, 0.62, -hd + 0.1, hd, bevel=0.05)
        if k == "sofa":
            n = max(2, round(w / 0.9))
            for i in range(n):
                x0 = -hw + 0.18 + i * (w - 0.36) / n
                part(f, "velvet", x0 + 0.03, x0 + (w - 0.36) / n - 0.03, 0.42, 0.52, -hd + 0.24, hd - 0.05, bevel=0.04)
    elif k == "coffee-table":
        if abs(w - d) < 0.05:
            cyl(f, "lacquer", 0, 0, h - 0.04, h, w / 2, w / 2, segs=36)
            cyl(f, "gold", 0, 0, 0.0, h - 0.04, 0.05, 0.08, segs=16)
            cyl(f, "gold", 0, 0, 0.0, 0.02, w / 4, w / 4, segs=24)
        else:
            part(f, "lacquer", -hw, hw, h - 0.04, h, -hd, hd, bevel=0.02)
            part(f, "gold", -hw + 0.08, hw - 0.08, 0, h - 0.04, -hd + 0.08, hd - 0.08)
    elif k == "meeting-table":
        if abs(w - d) < 0.05:
            cyl(f, "walnut", 0, 0, h - 0.05, h, w / 2, w / 2, segs=36)
            cyl(f, "gold", 0, 0, 0.0, h - 0.05, 0.06, 0.06, segs=16)
            cyl(f, "dark", 0, 0, 0.0, 0.03, 0.35, 0.35, segs=24)
        else:
            part(f, "walnut", -hw, hw, h - 0.06, h, -hd, hd, bevel=0.02)
            part(f, "gold", -hw, hw, h - 0.075, h - 0.06, -hd, hd)
            for sx in (-1, 1):
                part(f, "dark", sx * hw * 0.62 - 0.08, sx * hw * 0.62 + 0.08, 0, h - 0.075, -hd * 0.5, hd * 0.5)
    elif k == "bookcase":
        part(f, "walnut", -hw, hw, 0, h, -hd, -hd + 0.03)
        part(f, "walnut", -hw, -hw + 0.04, 0, h, -hd, hd)
        part(f, "walnut", hw - 0.04, hw, 0, h, -hd, hd)
        part(f, "walnut", -hw, hw, h - 0.04, h, -hd, hd)
        shelves = 5
        for s in range(shelves):
            y = s * h / shelves
            part(f, "walnut", -hw + 0.04, hw - 0.04, y, y + 0.03, -hd, hd)
            x = -hw + 0.06
            k2 = s * 7
            while x < hw - 0.12:
                bw = 0.035 + ((k2 * 37) % 5) * 0.01
                bh = h / shelves * (0.55 + ((k2 * 13) % 4) * 0.08)
                part(f, "books", x, x + bw, y + 0.03, y + 0.03 + bh, -hd + 0.05, hd - 0.06)
                x += bw + 0.005
                k2 += 1
    elif k == "rug":
        part(f, "velvet", -hw, hw, 0.0, 0.012, -hd, hd)
        part(f, "gold", -hw + 0.12, hw - 0.12, 0.012, 0.016, -hd + 0.12, -hd + 0.16)
        part(f, "gold", -hw + 0.12, hw - 0.12, 0.012, 0.016, hd - 0.16, hd - 0.12)
    elif k == "screen-wall":
        part(f, "dark", -hw, hw, 0.05, h, -hd, hd, bevel=0.02)
        n = 3
        for i in range(n):
            x0 = -hw + 0.12 + i * (w - 0.24) / n
            part(f, "screen", x0 + 0.04, x0 + (w - 0.24) / n - 0.04, 0.45, h - 0.15, hd, hd + 0.01)
        part(f, "gold", -hw, hw, 0.0, 0.05, -hd - 0.08, hd + 0.08)
    elif k == "command-desk":
        R = w * 0.9
        segs = 9
        for i in range(segs):
            a0 = -0.55 + 1.1 * i / segs
            a1 = -0.55 + 1.1 * (i + 1) / segs
            ax, az = f["at"]
            for (lo, hi, mat, y0, y1) in ((R - d / 2, R + d / 2, "dark", 0.0, h - 0.04), (R - d / 2 - 0.02, R + d / 2 + 0.02, "walnut", h - 0.04, h)):
                verts_plan = []
                for a in (a0, a1):
                    for rr in (lo, hi):
                        verts_plan.append((ax + math.sin(a) * rr, az - R + math.cos(a) * rr))
                xs = [v[0] for v in verts_plan]
                zs = [v[1] for v in verts_plan]
                cxm, czm = sum(xs) / 4, sum(zs) / 4
                am = (a0 + a1) / 2
                seg_len = 2 * R * math.sin((a1 - a0) / 2) + 0.02
                S.add_box(M[mat], cxm - seg_len / 2, cxm + seg_len / 2, y0, y1, czm - (hi - lo) / 2, czm + (hi - lo) / 2, rot=am, pivot=(cxm, czm))
            # glowing gold strip on the front face
            cxm = ax + math.sin((a0 + a1) / 2) * (R + d / 2 + 0.012)
            czm = az - R + math.cos((a0 + a1) / 2) * (R + d / 2 + 0.012)
            seg_len = 2 * R * math.sin((a1 - a0) / 2)
            S.add_box(M["glow"], cxm - seg_len / 2, cxm + seg_len / 2, 0.5, 0.53, czm - 0.006, czm + 0.006, rot=(a0 + a1) / 2, pivot=(cxm, czm))
    elif k == "lounge-ring":
        ax, az = f["at"]
        R = w / 2
        # open towards the south hall (+z): leave a 70° gap centred on +z
        gap = math.radians(70)
        start = math.pi / 2 + gap / 2
        arc = 2 * math.pi - gap
        S.add_lathe(M["fabric"], ax, az, [(R - 0.9, 0.0), (R - 0.9, 0.42), (R - 0.05, 0.42), (R - 0.05, 0.0)], segs=40, arc=arc, start=start)
        S.add_lathe(M["fabric"], ax, az, [(R - 0.25, 0.42), (R - 0.25, h), (R, h), (R, 0.42)], segs=40, arc=arc, start=start)
        S.add_lathe(M["velvet"], ax, az, [(R - 0.85, 0.42), (R - 0.85, 0.52), (R - 0.3, 0.52), (R - 0.3, 0.42)], segs=40, arc=arc, start=start)
        S.add_torus(M["gold"], ax, 0.03, az, R - 0.02, 0.018, segs=40, ring=6, arc=arc, start=start)
    elif k == "reception-desk":
        part(f, "lacquer", -hw, hw, 0.06, h, -hd, hd, bevel=0.03)
        part(f, "walnut", -hw - 0.05, hw + 0.05, h, h + 0.05, -hd - 0.05, hd + 0.05, bevel=0.01)
        part(f, "gold", -hw, hw, 0.14, 0.17, hd, hd + 0.012)
        part(f, "gold", -hw, hw, h - 0.17, h - 0.14, hd, hd + 0.012)
        part(f, "dark", -hw + 0.02, hw - 0.02, 0.0, 0.06, -hd + 0.02, hd - 0.02)
        part(f, "glow", -hw + 0.05, hw - 0.05, 0.06, 0.08, hd - 0.02, hd + 0.005)
    elif k == "brand-wall":
        part(f, "wall_accent", -hw, hw, 0.0, h, -hd, hd, bevel=0.01)
        part(f, "gold", -hw, hw, h, h + 0.06, -hd, hd)
        part(f, "gold", -hw - 0.06, -hw, 0.0, h + 0.06, -hd, hd)
        part(f, "gold", hw, hw + 0.06, 0.0, h + 0.06, -hd, hd)
        part(f, "glow", -hw + 0.1, hw - 0.1, 0.02, 0.05, hd, hd + 0.01)
        part(f, "dark", -0.75, 0.75, 0.45, 2.25, hd, hd + 0.012)  # logo plate (the official logo is applied at runtime)


for f in PLAN["furniture"]:
    build_item(f)

objs = S.build()
# drop faces nobody can see (pointing down, resting near the floor): they would only waste lightmap space
import bmesh as _bm  # noqa: E402
for o in objs:
    bm = _bm.new()
    bm.from_mesh(o.data)
    dead = [f for f in bm.faces if f.normal.z < -0.9 and f.calc_center_median().z < 0.25]
    _bm.ops.delete(bm, geom=dead, context="FACES")
    bm.to_mesh(o.data)
    bm.free()
# Only large surfaces get the baked lightmap (soft light + furniture shadows on floors and walls). Small detailed props
# (leaves, books, chair parts, trims) would shatter the atlas into thousands of tiny islands; the app lights them live.
LIGHTMAPPED = {"marble", "oak", "carpet_exec", "wall", "wall_accent", "walnut", "lacquer", "fabric"}
static = [o for o in objs if o.active_material.name in LIGHTMAPPED]
print(f"[building] geometry built in {time.time() - T0:.1f}s; objects: {len(objs)}")

# ── UVs: UV0 = world-scaled texture coords (tiling surfaces); UV1 = shared lightmap atlas ────────────────────────────
for o in objs:
    me = o.data
    uv0 = me.uv_layers.new(name="UVMap")
    me.uv_layers.active = uv0
    tile = TEXTURED.get(o.active_material.name, (None, 2.0))[1]
    for poly in me.polygons:
        n = poly.normal
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            # triplanar-style projection, 1 unit = 1 metre / 2 (texture tiles every 2 m)
            if abs(n.z) > 0.7:
                uv0.data[li].uv = (v.x / tile, v.y / tile)
            elif abs(n.x) > abs(n.y):
                uv0.data[li].uv = (v.y / tile, v.z / tile)
            else:
                uv0.data[li].uv = (v.x / tile, v.z / tile)

# every static surface gets its own island in ONE shared lightmap atlas (multi-object edit mode packs them together)
for o in static:
    o.data.uv_layers.active = o.data.uv_layers.new(name="lightmap")
select_only(static)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
t = time.time()
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0008, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.uv.select_all(action="SELECT")
bpy.ops.uv.average_islands_scale()  # equal texel density everywhere (the big floor gets the area it deserves)
bpy.ops.uv.pack_islands(margin=0.0015, rotate=True)
bpy.ops.object.mode_set(mode="OBJECT")
print(f"[building] lightmap UVs in {time.time() - t:.1f}s")

# ── lighting for the bake: warm sun + bright sky, open roof (doll-house view, like the reference) ───────────────────
world = bpy.data.worlds.new("sky")
bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = hex_rgba("#e9e4ff")
bg.inputs["Strength"].default_value = 1.15
sun_data = bpy.data.lights.new("sun", type="SUN")
sun_data.energy = 3.2
sun_data.color = hex_rgba("#fff0d8")[:3]
sun_data.angle = math.radians(8)
sun = bpy.data.objects.new("sun", sun_data)
bpy.context.scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(38), math.radians(-18), math.radians(28))
# warm cove lights above the offices (soft fill like the reference's interior glow)
for o in PLAN["offices"]:
    r = o["rect"]
    ld = bpy.data.lights.new("cove_" + o["id"], type="AREA")
    ld.energy = 180 if o["exec"] else 90
    ld.color = hex_rgba("#ffd9a0")[:3]
    ld.shape = "RECTANGLE"
    ld.size, ld.size_y = (r["x1"] - r["x0"]) * 0.8, (r["z1"] - r["z0"]) * 0.8
    ob = bpy.data.objects.new(ld.name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = B((r["x0"] + r["x1"]) / 2, 3.1, (r["z0"] + r["z1"]) / 2)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = args.samples
scene.cycles.use_denoising = True
scene.render.bake.use_pass_color = False
scene.render.bake.use_pass_direct = True
scene.render.bake.use_pass_indirect = True
scene.render.bake.margin = 4

img = bpy.data.images.new("lightmap-day", args.lightmap, args.lightmap, float_buffer=True)
mats_static = {o.active_material for o in static}
for mat in mats_static:
    nt = mat.node_tree
    node = nt.nodes.new("ShaderNodeTexImage")
    node.name = "BAKE_TARGET"
    node.image = img
    nt.nodes.active = node
select_only(static)
lm_scale = 1.0
if not args.no_bake:
    t = time.time()
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, use_clear=True, margin=4)
    print(f"[building] baked {args.lightmap}² lightmap @ {args.samples} spp in {time.time() - t:.1f}s")
    import numpy as np
    px = np.empty(args.lightmap * args.lightmap * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(args.lightmap, args.lightmap, 4)
    rgb = px[..., :3]
    lit = rgb[rgb.sum(axis=2) > 1e-4]
    p99 = float(np.percentile(lit, 99.5)) if lit.size else 1.0
    lm_scale = max(p99, 1e-3)
    rgb = rgb / lm_scale
    # gentle 3x3 blur to calm sampling noise (islands are padded by the bake margin)
    k = np.pad(rgb, ((1, 1), (1, 1), (0, 0)), mode="edge")
    rgb = sum(k[1 + dy:1 + dy + args.lightmap, 1 + dx:1 + dx + args.lightmap] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9.0
    rgb = np.clip(rgb, 0, 1) ** (1 / 2.2)  # store gamma-encoded in 8 bits; the app decodes it (sRGB texture)
    px[..., :3] = rgb
    px[..., 3] = 1.0
    out_img = bpy.data.images.new("lightmap-out", args.lightmap, args.lightmap)
    out_img.pixels.foreach_set(px.ravel())
    out_img.filepath_raw = os.path.join(args.out, "lightmap-day.png")
    out_img.file_format = "PNG"
    out_img.save()
    # what the app ships (≈7× smaller); Standard view transform = no tone change on the way out
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.image_settings.file_format = "WEBP"
    scene.render.image_settings.quality = 90
    scene.render.image_settings.color_mode = "RGB"
    out_img.save_render(os.path.join(args.out, "lightmap-day.webp"), scene=scene)
for mat in mats_static:
    n = mat.node_tree.nodes.get("BAKE_TARGET")
    if n:
        mat.node_tree.nodes.remove(n)
for o in static:
    o.data.uv_layers.active = o.data.uv_layers["UVMap"]

# ── export ───────────────────────────────────────────────────────────────────
for o in objs:
    o.data.name = o.name
select_only(objs)
glb = os.path.join(args.out, "building.glb")
bpy.ops.export_scene.gltf(
    filepath=glb, export_format="GLB", use_selection=True, export_apply=True, export_texcoords=True, export_normals=True,
    export_materials="EXPORT", export_image_format="WEBP", export_image_quality=88, export_yup=True, export_extras=False, export_cameras=False, export_lights=False,
)
tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
print(f"[building] exported {glb} ({os.path.getsize(glb) / 1e6:.2f} MB, {len(objs)} meshes, {tris} tris) in {time.time() - T0:.1f}s total")
json.dump({"tris": tris, "meshes": len(objs), "lightmapScale": lm_scale, "materials": [o.active_material.name for o in objs]}, open(os.path.join(args.out, "building.json"), "w"), indent=1)
