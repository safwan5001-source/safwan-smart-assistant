"""
BASHT HQ — character generator (Blender, headless).

    tools/hq-assets/build.sh characters [ID ...]

For every character in tools/hq-assets/layout.json ("characters", sourced from apps/web/lib/hq/roster.ts) this builds:
  - one skinned mesh with per-corner colours (ONE material → one draw call per character),
  - an armature with the shared bone names (see BONES), procedural skin weights (no bone-heat failure modes),
  - the animation clips the web app plays: idle, walk, sit, type, talk (rotation tracks + hips height),
and exports <ID>.glb. Characters are built from their own proportions and look, so no two files are alike.

Plan axes: x east, y up, z south; a character faces +z (towards the camera) in its own frame. Blender: (x, -z, y).
"""
import argparse
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import bpy  # noqa: E402  (must be imported before bmesh)
import bmesh  # noqa: E402
from mathutils import Euler, Matrix, Quaternion, Vector  # noqa: E402
from common import B, hex_rgba, reset_scene, select_only  # noqa: E402

HERE = os.path.dirname(__file__)
ROOT = os.path.abspath(os.path.join(HERE, ".."))
ap = argparse.ArgumentParser()
ap.add_argument("--out", default=os.path.join(ROOT, "out"))
ap.add_argument("--only", nargs="*", default=[])
ap.add_argument("--preview", action="store_true", help="also render a Cycles preview PNG per character")
args, _ = ap.parse_known_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
os.makedirs(args.out, exist_ok=True)
PLAN = json.load(open(os.path.join(ROOT, "layout.json")))

FPS = 24
SEAT_TOP = 0.54  # top of the HQ chair cushions (tools/hq-assets/blender/build_building.py: 0.46 + 0.08)


def sit_hips(J):
    """Seated hip height for THIS body: thighs level on the cushion, shins hanging to just above the floor."""
    shin = J["shin.L"][1] - J["foot.L"][1]
    return max(SEAT_TOP + 0.05, shin + J["foot.L"][1] - 0.01)

# ── geometry builder with per-corner colours and per-vertex bone candidates ──────────────────────────────────────────


class Body:
    def __init__(self):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.color.new("Col")
        # each vertex stores the id of the part that made it (a mesh attribute survives every later bevel/renumbering)
        self.part = self.bm.verts.layers.int.new("part")
        self.binds = [None]  # part id → {bone: weight} | [candidate bones] | "ROBE"
        self.glow = set()  # part ids whose faces use material slot 1 (emissive), e.g. BASHT's eyes

    def _finish(self, verts, color, bind):
        bm = self.bm
        pid = len(self.binds)
        self.binds.append(bind)
        for v in verts:
            v[self.part] = pid
        self.last_part = pid
        c = hex_rgba(color)
        faces = sorted({f for v in verts for f in v.link_faces}, key=lambda f: f.index)  # sorted: byte-identical rebuilds
        for f in faces:
            for loop in f.loops:
                loop[self.col] = c
        return verts

    def xform(self, verts, m):
        bmesh.ops.transform(self.bm, matrix=m, verts=verts)

    def sphere(self, color, bind, x, y, z, r, sx=1, sy=1, sz=1, subdiv=2):
        v = bmesh.ops.create_icosphere(self.bm, subdivisions=subdiv, radius=r)["verts"]
        bmesh.ops.scale(self.bm, vec=Vector((sx, sz, sy)), verts=v)
        bmesh.ops.translate(self.bm, vec=B(x, y, z), verts=v)
        return self._finish(v, color, bind)

    def box(self, color, bind, x0, x1, y0, y1, z0, z1, bevel=0.0):
        v = bmesh.ops.create_cube(self.bm, size=1.0)["verts"]
        bmesh.ops.scale(self.bm, vec=Vector((x1 - x0, z1 - z0, y1 - y0)), verts=v)
        bmesh.ops.translate(self.bm, vec=B((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), verts=v)
        if bevel:
            self.bm.edges.index_update()
            edges = sorted({e for vv in v for e in vv.link_edges}, key=lambda e: e.index)
            res = bmesh.ops.bevel(self.bm, geom=edges, offset=bevel, segments=2, affect="EDGES")
            seen, out = set(), []
            for vv in list(v) + list(res["verts"]):
                if vv.is_valid and id(vv) not in seen:
                    seen.add(id(vv)); out.append(vv)
            v = out
        return self._finish(v, color, bind)

    def capsule(self, color, bind, a, b, r0, r1=None, segs=12):
        """Tapered tube between plan points a and b (rounded ends)."""
        r1 = r0 if r1 is None else r1
        A, Bv = B(*a), B(*b)
        d = Bv - A
        length = d.length
        v = bmesh.ops.create_cone(self.bm, cap_ends=True, segments=segs, radius1=r0, radius2=r1, depth=length)["verts"]
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        self.xform(v, Matrix.Translation((A + Bv) / 2) @ q.to_matrix().to_4x4())
        out = list(v)
        out += self.sphere(color, bind, *a, r0, subdiv=1)
        out += self.sphere(color, bind, *b, r1, subdiv=1)
        return self._finish(v, color, bind)

    def lathe(self, color, bind, cx, cz, profile, segs=28, arc=2 * math.pi, start=0.0, cap_top=False, stripes=None):
        """Revolve [(radius, y), ...] around the vertical axis at (cx, cz). `start` is measured from +x towards +z."""
        bm = self.bm
        full = arc >= 2 * math.pi - 1e-6
        cols = segs if full else segs + 1
        grid = []
        for i in range(cols):
            a = start + arc * i / segs
            grid.append([bm.verts.new(B(cx + r * math.cos(a), y, cz + r * math.sin(a))) for r, y in profile])
        faces = []
        for i in range(segs):
            c0, c1 = grid[i], grid[(i + 1) % cols]
            for j in range(len(profile) - 1):
                faces.append(bm.faces.new((c0[j], c1[j], c1[j + 1], c0[j + 1])))
        if cap_top:
            top = [col[-1] for col in grid]
            if len(top) >= 3:
                faces.append(bm.faces.new(top[::-1]))
        verts = [v for col in grid for v in col]
        self._finish(verts, color, bind)
        if stripes:  # (color_a, color_b, every_n): a woven check pattern for the shemagh
            ca, cb, n = stripes
            for fi, f in enumerate(faces):
                i, j = divmod(fi, max(1, len(profile) - 1))
                c = hex_rgba(ca if ((i // n) + (j // max(1, n // 2))) % 2 else cb)
                for loop in f.loops:
                    loop[self.col] = c
        return verts

    def torus(self, color, bind, x, y, z, R, r, segs=28, ring=8, sx=1.0):
        bm = self.bm
        rings = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            rings.append([bm.verts.new(B(x + (R + r * math.cos(t)) * math.cos(a) * sx, y + r * math.sin(t), z + (R + r * math.cos(t)) * math.sin(a)))
                          for t in (2 * math.pi * j / ring for j in range(ring))])
        for i in range(segs):
            a_, b_ = rings[i], rings[(i + 1) % segs]
            for j in range(ring):
                bm.faces.new((a_[j], a_[(j + 1) % ring], b_[(j + 1) % ring], b_[j]))
        return self._finish([v for rr in rings for v in rr], color, bind)


# ── skeleton (shared names; the web app binds clips by these) ────────────────────────────────────────────────────────
BONES = ["root", "hips", "spine", "chest", "neck", "head", "upperarm.L", "forearm.L", "hand.L", "upperarm.R", "forearm.R", "hand.R",
         "thigh.L", "shin.L", "foot.L", "thigh.R", "shin.R", "foot.R"]
PARENT = {"hips": "root", "spine": "hips", "chest": "spine", "neck": "chest", "head": "neck", "upperarm.L": "chest", "forearm.L": "upperarm.L",
          "hand.L": "forearm.L", "upperarm.R": "chest", "forearm.R": "upperarm.R", "hand.R": "forearm.R", "thigh.L": "hips", "shin.L": "thigh.L",
          "foot.L": "shin.L", "thigh.R": "hips", "shin.R": "thigh.R", "foot.R": "shin.R"}


def joints(H, wide):
    """Joint positions in plan coords for a character of height H. `wide` scales shoulders/hips. L = character's left (+x)."""
    s = H / 1.75
    sh = 0.185 * s * wide
    hip = 0.09 * s * wide
    J = {
        "root": (0, 0, 0), "hips": (0, 0.95 * s, 0), "spine": (0, 1.08 * s, 0), "chest": (0, 1.25 * s, 0), "neck": (0, 1.45 * s, 0),
        "head": (0, 1.53 * s, 0), "head_top": (0, 1.75 * s, 0),
        "upperarm.L": (sh, 1.42 * s, 0), "forearm.L": (sh + 0.06 * s, 1.14 * s, 0.0), "hand.L": (sh + 0.09 * s, 0.88 * s, 0.03 * s), "hand_end.L": (sh + 0.1 * s, 0.78 * s, 0.04 * s),
        "thigh.L": (hip, 0.93 * s, 0), "shin.L": (hip + 0.005, 0.52 * s, 0.01), "foot.L": (hip + 0.01, 0.09 * s, 0), "foot_end.L": (hip + 0.01, 0.02, 0.17 * s),
    }
    for k in list(J):
        if k.endswith(".L"):
            x, y, z = J[k]
            J[k[:-2] + ".R"] = (-x, y, z)
    return J


TAILS = {"root": "hips", "hips": "spine", "spine": "chest", "chest": "neck", "neck": "head", "head": "head_top", "upperarm.L": "forearm.L",
         "forearm.L": "hand.L", "hand.L": "hand_end.L", "upperarm.R": "forearm.R", "forearm.R": "hand.R", "hand.R": "hand_end.R",
         "thigh.L": "shin.L", "shin.L": "foot.L", "foot.L": "foot_end.L", "thigh.R": "shin.R", "shin.R": "foot.R", "foot.R": "foot_end.R"}


def make_armature(name, J):
    arm = bpy.data.armatures.new(name + "_rig")
    ob = bpy.data.objects.new(name + "_rig", arm)
    bpy.context.scene.collection.objects.link(ob)
    select_only([ob])
    bpy.ops.object.mode_set(mode="EDIT")
    eb = {}
    for b in BONES:
        e = arm.edit_bones.new(b)
        head = B(*J[b]) if b != "root" else B(0, 0, 0)
        tail = B(*J[TAILS[b]]) if b != "root" else B(0, 0.12, 0)
        if (tail - head).length < 1e-3:
            tail = head + Vector((0, 0, 0.05))
        e.head, e.tail = head, tail
        e.roll = 0
        eb[b] = e
    for b, p in PARENT.items():
        eb[b].parent = eb[p]
        eb[b].use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    return ob


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (p - (a + ab * t)).length


def skin(mesh_ob, rig_ob, body, J):
    """Procedural weights: each part lists its candidate bones; weight ∝ 1/d^4 to each bone's segment, top 3 kept."""
    me = mesh_ob.data
    groups = {b: mesh_ob.vertex_groups.new(name=b) for b in BONES}
    segs = {b: (B(*J[b]) if b != "root" else B(0, 0, 0), B(*J[TAILS[b]]) if b != "root" else B(0, 0.1, 0)) for b in BONES}
    part = me.attributes["part"].data
    for vi in range(len(me.vertices)):
        bind = body.binds[part[vi].value]
        if True:
            p = me.vertices[vi].co
            if isinstance(bind, dict):
                for b, w in bind.items():
                    groups[b].add([vi], w, "REPLACE")
                continue
            if bind == "ROBE":
                # a robe swings as ONE garment: above the hips it follows the torso; below, it blends from the hips towards
                # the leg on its side (never more than 70%), so walking sways the hem instead of splitting it into trousers
                hy, ky = J["hips"][1], J["shin.L"][1]
                y, x = p.z, p.x
                if y >= hy:
                    ws = sorted(((1.0 / (seg_dist(p, *segs[b]) + 0.015) ** 4, b) for b in TORSO), reverse=True)[:2]
                    tot = sum(w for w, _ in ws)
                    for w, b in ws:
                        groups[b].add([vi], w / tot, "REPLACE")
                    continue
                t = min(1.0, max(0.0, (hy - y) / max(hy - ky, 1e-3)))
                side = min(1.0, max(0.0, 0.5 + x / 0.22))  # 1 = character's left (+x)
                leg = 0.7 * t ** 0.8
                low = min(1.0, max(0.0, (ky - y) / max(ky, 1e-3)))  # below the knee a little shin influence
                ws = sorted(((w, bone) for bone, w in (("hips", 1 - leg), ("thigh.L", leg * side * (1 - 0.3 * low)), ("thigh.R", leg * (1 - side) * (1 - 0.3 * low)),
                                                   ("shin.L", leg * side * 0.3 * low), ("shin.R", leg * (1 - side) * 0.3 * low)) if w > 1e-4), reverse=True)[:4]
                tot = sum(w for w, _ in ws)
                for w, bone in ws:
                    groups[bone].add([vi], w / tot, "REPLACE")
                continue
            ws = []
            for b in bind:
                d = seg_dist(p, *segs[b]) + 0.015
                ws.append((1.0 / d ** 4, b))
            ws.sort(reverse=True)
            ws = ws[:3]
            tot = sum(w for w, _ in ws)
            for w, b in ws:
                groups[b].add([vi], w / tot, "REPLACE")
    mod = mesh_ob.modifiers.new("rig", "ARMATURE")
    mod.object = rig_ob
    mesh_ob.parent = rig_ob


# ── humans ────────────────────────────────────────────────────────────────────────────────────────────────────────────
TORSO = ["hips", "spine", "chest"]
ROBE = ["hips", "spine", "thigh.L", "thigh.R", "shin.L", "shin.R"]


def shade(hexc, k):
    r, g, b = (int(hexc[i:i + 2], 16) for i in (1, 3, 5))
    f = lambda c: max(0, min(255, int(c * k)))  # noqa: E731
    return "#%02x%02x%02x" % (f(r), f(g), f(b))


def build_human(ch):
    L = ch["look"]
    H = L["height"]
    s = H / 1.75
    wide = {"slim": 0.92, "regular": 1.0, "broad": 1.12}[L["build"]]
    J = joints(H, wide)
    body = Body()
    skin_c, out_c, acc_c = L["skin"], L["outfit"], L["accent"]
    dark = "#1d1820"
    abaya = L["attire"] == "abaya"
    extras = set(L["extras"])

    # robe (thobe / abaya): shoulders → ankles, slightly flared; neckline accent
    rr = lambda v: v * s * wide  # noqa: E731
    profile = [(rr(0.17), 0.07 * s), (rr(0.165), 0.3 * s), (rr(0.16), 0.6 * s), (rr(0.165), 0.92 * s), (rr(0.155), 1.1 * s), (rr(0.165), 1.28 * s),
               (rr(0.16), 1.38 * s), (rr(0.12), 1.44 * s), (rr(0.065), 1.47 * s)]
    body.lathe(out_c, "ROBE", 0, 0, profile, segs=26)
    if not abaya:
        body.box(acc_c if L["head"] != "ghutra" else shade(out_c, 0.85), {"chest": 1.0}, -0.012, 0.012, 1.18 * s, 1.43 * s, rr(0.135), rr(0.15))  # placket
    else:
        body.lathe(acc_c, "ROBE", 0, 0, [(rr(0.172), 0.07 * s), (rr(0.174), 0.13 * s)], segs=26)  # hem trim
    # sleeves + hands
    for side in ("L", "R"):
        sh, el, wr = J["upperarm." + side], J["forearm." + side], J["hand." + side]
        body.capsule(out_c, ["upperarm." + side, "chest"], sh, el, rr(0.056), rr(0.05))
        body.capsule(out_c, ["forearm." + side, "upperarm." + side], el, wr, rr(0.05), rr(0.054))
        body.sphere(skin_c, {"hand." + side: 1.0}, wr[0], wr[1] - 0.05 * s, wr[2] + 0.01, 0.045 * s, sx=0.85, sy=1.3, sz=0.7)
        if "watch" in extras and side == "L":
            body.torus("#d4a017", {"forearm.L": 0.7, "hand.L": 0.3}, wr[0], wr[1] + 0.01, wr[2], 0.05 * s, 0.009, segs=14, ring=5)
    # shoes peeking out
    for side in ("L", "R"):
        fx = J["foot." + side][0]
        body.box(dark, {"foot." + side: 1.0}, fx - 0.045 * s, fx + 0.045 * s, 0.0, 0.07 * s, -0.04 * s, 0.15 * s, bevel=0.02)
        body.capsule(out_c if not abaya else shade(out_c, 0.9), ["shin." + side, "foot." + side], (fx, 0.4 * s, 0.0), (fx, 0.1 * s, 0.01), rr(0.06), rr(0.055))

    # head: neck, skull, ears, nose, eyes, brows, facial hair
    hx, hy, hz = 0, 1.6 * s, 0.0
    body.capsule(skin_c, ["neck", "head"], (0, 1.43 * s, 0), (0, 1.55 * s, 0.005), 0.05 * s)
    body.sphere(skin_c, {"head": 1.0}, hx, hy, hz, 0.112 * s, sx=0.92, sy=1.12, sz=1.0, subdiv=3)
    body.sphere(skin_c, {"head": 1.0}, hx, hy - 0.05 * s, hz + 0.03 * s, 0.07 * s, sx=1.05, sy=0.8, sz=1.0, subdiv=2)  # jaw
    body.sphere(shade(skin_c, 0.95), {"head": 1.0}, hx, hy - 0.005 * s, hz + 0.105 * s, 0.022 * s, sx=0.75, sy=1.35, sz=1.0)  # nose
    for ex in (0.038, -0.038):
        body.sphere("#f6f3ee", {"head": 1.0}, hx + ex * s, hy + 0.02 * s, hz + 0.088 * s, 0.017 * s, sz=0.6)
        body.sphere("#24170f", {"head": 1.0}, hx + ex * s, hy + 0.02 * s, hz + 0.099 * s, 0.009 * s, sz=0.5)
        body.box("#2a1c14", {"head": 1.0}, hx + ex * s - 0.022 * s, hx + ex * s + 0.022 * s, hy + 0.048 * s, hy + 0.056 * s, hz + 0.085 * s, hz + 0.1 * s)
    body.box(shade(skin_c, 0.78), {"head": 1.0}, hx - 0.022 * s, hx + 0.022 * s, hy - 0.052 * s, hy - 0.045 * s, hz + 0.092 * s, hz + 0.1 * s)  # lips
    if not abaya:
        for ex in (0.098, -0.098):
            body.sphere(skin_c, {"head": 1.0}, hx + ex * s, hy + 0.005 * s, hz, 0.025 * s, sx=0.45, sy=1.2)
    if "beard" in extras:
        body.sphere("#1f1712", {"head": 1.0}, hx, hy - 0.07 * s, hz + 0.045 * s, 0.072 * s, sx=1.15, sy=0.75, sz=0.95)
    if "beard" in extras or "moustache" in extras:
        body.box("#1f1712", {"head": 1.0}, hx - 0.035 * s, hx + 0.035 * s, hy - 0.035 * s, hy - 0.022 * s, hz + 0.093 * s, hz + 0.108 * s, bevel=0.004)
    if "glasses" in extras:
        for ex in (0.038, -0.038):
            body.torus("#20161d", {"head": 1.0}, hx + ex * s, hy + 0.02 * s, hz + 0.104 * s, 0.026 * s, 0.0035, segs=16, ring=4)
        body.box("#20161d", {"head": 1.0}, -0.012 * s, 0.012 * s, hy + 0.019 * s, hy + 0.024 * s, hz + 0.104 * s, hz + 0.108 * s)
    if "headset" in extras:
        body.torus("#1f2937", {"head": 1.0}, hx, hy + 0.02 * s, hz, 0.112 * s, 0.009, segs=20, ring=5)
        body.sphere("#1f2937", {"head": 1.0}, hx + 0.11 * s, hy, hz, 0.03 * s, sx=0.5)
        body.capsule("#1f2937", ["head"], (0.1 * s, hy - 0.01 * s, 0.02 * s), (0.04 * s, hy - 0.06 * s, 0.1 * s), 0.006)

    # head covering
    head_c = {"shemagh": "#f7f5f1", "ghutra": "#f8f7f3", "hijab": acc_c}[L["head"]]
    face_gap = math.radians(110)
    start = math.pi / 2 + face_gap / 2  # leave the face (+z) open
    arc = 2 * math.pi - face_gap
    if L["head"] in ("shemagh", "ghutra"):
        cloth = [(0.045 * s, 1.765 * s), (0.1 * s, 1.75 * s), (0.122 * s, 1.68 * s), (0.13 * s, 1.58 * s), (0.155 * s, 1.47 * s), (0.2 * s, 1.36 * s), (0.215 * s, 1.27 * s)]
        stripes = ("#c62f36", "#f7f5f1", 2) if L["head"] == "shemagh" else None
        body.lathe(head_c, ["head", "neck", "chest"], 0, -0.005, cloth, segs=30, arc=arc, start=start, stripes=stripes)
        body.lathe(head_c, {"head": 1.0}, 0, -0.005, [(0.105 * s, 1.66 * s), (0.112 * s, 1.73 * s), (0.04 * s, 1.765 * s)], segs=24, cap_top=True)  # crown
        # agal: double black cord
        body.torus("#151216", {"head": 1.0}, 0, 1.705 * s, -0.008, 0.112 * s, 0.011, segs=26, ring=6)
        body.torus("#151216", {"head": 1.0}, 0, 1.728 * s, -0.012, 0.106 * s, 0.01, segs=26, ring=6)
    else:
        hij = [(0.05 * s, 1.77 * s), (0.105 * s, 1.745 * s), (0.124 * s, 1.67 * s), (0.122 * s, 1.56 * s), (0.11 * s, 1.47 * s), (0.17 * s, 1.4 * s), (0.2 * s, 1.33 * s)]
        hface = math.radians(80)
        body.lathe(acc_c, ["head", "neck", "chest"], 0, -0.004, hij, segs=30, arc=2 * math.pi - hface, start=math.pi / 2 + hface / 2)
        body.lathe(acc_c, {"head": 1.0}, 0, -0.004, [(0.104 * s, 1.69 * s), (0.11 * s, 1.74 * s), (0.04 * s, 1.772 * s)], segs=24, cap_top=True)
        body.lathe(shade(acc_c, 0.8), {"head": 1.0}, 0, -0.004, [(0.113 * s, 1.655 * s), (0.116 * s, 1.67 * s)], segs=24, arc=2 * math.pi - hface, start=math.pi / 2 + hface / 2)
    if "bisht" in extras:
        cloak = [(rr(0.2), 0.25 * s), (rr(0.2), 0.7 * s), (rr(0.195), 1.1 * s), (rr(0.21), 1.32 * s), (rr(0.17), 1.42 * s)]
        bgap = math.radians(60)
        body.lathe("#3b2417", "ROBE", 0, -0.01, cloak, segs=28, arc=2 * math.pi - bgap, start=math.pi / 2 + bgap / 2)
        for sgn in (1, -1):  # gold zari trim along the opening
            a = math.pi / 2 + sgn * bgap / 2
            body.capsule("#d4a017", "ROBE", (rr(0.212) * math.cos(a), 1.33 * s, rr(0.212) * math.sin(a)), (rr(0.2) * math.cos(a), 0.3 * s, rr(0.2) * math.sin(a)), 0.012, segs=6)
    if "lanyard" in extras:
        body.box("#f8fafc", {"chest": 1.0}, -0.035 * s, 0.035 * s, 1.15 * s, 1.24 * s, rr(0.16), rr(0.168))
    if "tablet" in extras:
        wr = J["hand.L"]
        body.box("#1f2937", {"hand.L": 1.0}, wr[0] - 0.09 * s, wr[0] + 0.02 * s, wr[1] - 0.1 * s, wr[1] + 0.04 * s, wr[2] + 0.02, wr[2] + 0.03)
    return body, J


# ── BASHT (official mascot: purple robot, white dasmal with the red band, cyan smiling eyes, jambiya) ──────────────────
def build_robot():
    J = joints(1.62, 1.08)
    s = 1.62 / 1.75
    body = Body()
    P, P2, W, R, G, CY, DK = "#7c3aed", "#6d28d9", "#f5f3ff", "#d91b38", "#d4a017", "#22d3ee", "#0d0a1a"
    body.lathe(P, ["hips", "spine", "chest"], 0, 0, [(0.17, 0.82), (0.2, 0.9), (0.24, 1.05), (0.25, 1.22), (0.22, 1.36), (0.12, 1.44), (0.06, 1.47)], segs=28)
    body.lathe(W, ["spine", "chest"], 0, 0.0, [(0.252, 1.06), (0.262, 1.14), (0.262, 1.24), (0.235, 1.33)], segs=20, arc=math.radians(100), start=math.pi / 2 - math.radians(50))  # chest plate
    body.torus(G, {"hips": 0.7, "spine": 0.3}, 0, 0.9, 0, 0.2, 0.025, segs=28, ring=6)  # belt
    # jambiya: silver hilt + curved purple sheath with white diamonds (as in the logo)
    body.box("#cfd3dc", {"hips": 1.0}, -0.03, 0.03, 0.9, 1.02, 0.2, 0.235, bevel=0.01)
    body.sphere(P2, {"hips": 1.0}, 0, 0.84, 0.215, 0.07, sx=1.25, sy=0.6, sz=0.45)
    for dx in (-0.035, 0, 0.035):
        body.box(W, {"hips": 1.0}, dx - 0.01, dx + 0.01, 0.835, 0.855, 0.245, 0.25)
    # head: rounded purple shell, dark visor, cyan smiling eyes
    hy = 1.72
    body.capsule(P2, ["neck", "head"], (0, 1.44, 0), (0, 1.53, 0), 0.07)
    body.sphere(P, {"head": 1.0}, 0, hy, 0, 0.27, sx=1.05, sy=0.92, sz=0.95, subdiv=3)
    body.sphere(DK, {"head": 1.0}, 0, hy - 0.02, 0.07, 0.2, sx=1.15, sy=0.78, sz=0.95, subdiv=3)
    for ex in (0.085, -0.085):
        for k in range(7):  # happy closed-eye arcs, built from small beads (emissive cyan in the app)
            a = math.pi * (0.15 + 0.7 * k / 6)
            body.sphere(CY, {"head": 1.0}, ex + math.cos(a) * 0.045, hy - 0.005 + math.sin(a) * 0.03, 0.255, 0.012, subdiv=1)
            body.glow.add(body.last_part)
    # dasmal (Yemeni head-wrap) + red band
    body.lathe(W, {"head": 1.0}, 0, -0.01, [(0.27, hy + 0.06), (0.29, hy + 0.12), (0.27, hy + 0.2), (0.2, hy + 0.26), (0.08, hy + 0.29)], segs=32, cap_top=True)
    body.lathe(R, {"head": 1.0}, 0, -0.01, [(0.285, hy + 0.085), (0.292, hy + 0.12), (0.288, hy + 0.155)], segs=32, stripes=(R, "#f5f3ff", 3))
    # arms and legs
    for side in ("L", "R"):
        body.capsule(P2, ["upperarm." + side, "chest"], J["upperarm." + side], J["forearm." + side], 0.065)
        body.capsule(P, ["forearm." + side], J["forearm." + side], J["hand." + side], 0.06, 0.058)
        wr = J["hand." + side]
        body.sphere(W, {"hand." + side: 1.0}, wr[0], wr[1] - 0.04, wr[2], 0.065, subdiv=2)
        body.capsule(P2, ["thigh." + side, "hips"], J["thigh." + side], J["shin." + side], 0.085)
        body.capsule(P, ["shin." + side], J["shin." + side], J["foot." + side], 0.075)
        fx = J["foot." + side][0]
        body.box(W, {"foot." + side: 1.0}, fx - 0.07, fx + 0.07, 0.0, 0.1, -0.06, 0.16, bevel=0.03)
    return body, J


# ── animation clips (keyframed pose-bone rotations + hips height) ─────────────────────────────────────────────────────
def q(x=0.0, y=0.0, z=0.0):
    """A joint rotation in DEGREES about the character's own axes (Blender armature space; the character faces -Y):
    x < 0 swings a limb forward (thigh up to sit, arm forward); x > 0 tips the head/chest forward; y rolls; z turns (yaw).
    Converted to each bone's local frame in make_clips, so the signs never depend on bone roll."""
    return Euler((math.radians(x), math.radians(y), math.radians(z)), "XYZ").to_matrix()


def make_clips(rig, J, robot=False):
    pb = rig.pose.bones
    rest = {b.name: b.matrix_local.to_3x3() for b in rig.data.bones}
    for b in pb:
        b.rotation_mode = "QUATERNION"
    hips_rest = J["hips"][1]
    ad = rig.animation_data_create()
    clips = {}

    def local(bname, Rw):
        M = rest[bname]
        return (M.inverted() @ Rw @ M).to_quaternion()

    def clip(name, length, frames):
        act = bpy.data.actions.new(name)
        ad.action = act
        for t, pose in frames:
            f = 1 + round(t * FPS)
            for b in pb:
                b.rotation_quaternion = (1, 0, 0, 0)
                b.location = (0, 0, 0)
            for bname, val in pose.items():
                if bname == "hips_y":
                    pb["hips"].location = (0, val - hips_rest, 0)  # hips bone points up: its local +Y is world up
                else:
                    pb[bname].rotation_quaternion = local(bname, val)
            for b in pb:
                b.keyframe_insert("rotation_quaternion", frame=f)
            pb["hips"].keyframe_insert("location", frame=f)
        clips[name] = (act, length)

    seat = {"hips_y": sit_hips(J), "thigh.L": q(x=-90, z=-4), "thigh.R": q(x=-90, z=4), "shin.L": q(x=90), "shin.R": q(x=90)}
    lap = {"upperarm.L": q(x=-26, y=0, z=0), "upperarm.R": q(x=-26), "forearm.L": q(x=-58), "forearm.R": q(x=-58)}
    clip("idle", 2.0, [(t, {"hips_y": hips_rest, "chest": q(x=1.5 * math.sin(t * math.pi)), "head": q(z=6 * math.sin(t * math.pi)),
                            "upperarm.L": q(y=-6), "upperarm.R": q(y=6)}) for t in (0, 0.5, 1.0, 1.5, 2.0)])
    walk = []
    for i in range(9):
        t = i / 8
        a = math.sin(2 * math.pi * t)
        walk.append((t, {
            "hips_y": hips_rest + 0.02 * abs(math.cos(2 * math.pi * t)),
            "thigh.L": q(x=-24 * a), "thigh.R": q(x=24 * a),
            "shin.L": q(x=32 * max(0.0, -a)), "shin.R": q(x=32 * max(0.0, a)),
            "upperarm.L": q(x=18 * a, y=-5), "upperarm.R": q(x=-18 * a, y=5),
            "forearm.L": q(x=-14), "forearm.R": q(x=-14),
            "spine": q(z=4 * a),
        }))
    clip("walk", 1.0, walk)
    clip("sit", 2.0, [(t, {**seat, **lap, "chest": q(x=3 + 1.2 * math.sin(t * math.pi))}) for t in (0, 1.0, 2.0)])
    typ = []
    for i in range(7):
        t = i / 6
        k = math.sin(2 * math.pi * t * 2)
        typ.append((t, {**seat, "chest": q(x=7), "head": q(x=12),
                        "upperarm.L": q(x=-36 + 3 * k, y=-8), "upperarm.R": q(x=-36 - 3 * k, y=8),
                        "forearm.L": q(x=-64), "forearm.R": q(x=-64),
                        "hand.L": q(x=8 * k), "hand.R": q(x=-8 * k)}))
    clip("type", 1.0, typ)
    talk = []
    for i in range(9):
        t = 3.0 * i / 8
        g = math.sin(2 * math.pi * t / 3.0 * 2)
        # meeting: forearms resting forward on the table edge, the right hand marking a point now and then
        talk.append((t, {**seat, "upperarm.L": q(x=-30, y=-6), "forearm.L": q(x=-62), "upperarm.R": q(x=-34 - 6 * g, y=8), "forearm.R": q(x=-66 - 8 * g),
                         "hand.R": q(x=-10 * g), "chest": q(x=4),
                         "head": q(x=4 * math.sin(2 * math.pi * t / 1.5), z=14 * math.sin(2 * math.pi * t / 3.0))}))
    clip("talk", 3.0, talk)
    clip("stand", 2.0, [(t, {"hips_y": hips_rest, "upperarm.R": q(x=-22 - 10 * math.sin(t * math.pi), y=10), "forearm.R": q(x=-40),
                             "head": q(z=8 * math.sin(t * math.pi))}) for t in (0, 0.5, 1.0, 1.5, 2.0)])
    # every clip becomes its own NLA track so the exporter writes them all as separate glTF animations
    ad.action = None
    for name, (act, length) in clips.items():
        tr = ad.nla_tracks.new()
        tr.name = name
        strip = tr.strips.new(name, 1, act)
        tr.mute = False
    return clips


def pose_frame(rig, clip_name, frame=1):
    """Show one clip in the viewport/render (for previews)."""
    ad = rig.animation_data
    for tr in ad.nla_tracks:
        tr.mute = tr.name != clip_name
    bpy.context.scene.frame_set(frame)


def finish_mesh(body, name):
    body_glow = body.glow
    me = bpy.data.meshes.new(name)
    body.bm.to_mesh(me)
    body.bm.free()
    for p in me.polygons:
        p.use_smooth = True
    if "Col" in me.color_attributes:
        me.color_attributes.active_color_name = "Col"
        me.color_attributes.render_color_index = me.color_attributes.find("Col")
    mat = bpy.data.materials.new(name + "_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.62
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    me.materials.append(mat)
    if body_glow:
        glow = bpy.data.materials.new(name + "_glow")
        glow.use_nodes = True
        gb = glow.node_tree.nodes["Principled BSDF"]
        gb.inputs["Base Color"].default_value = hex_rgba("#22d3ee")
        gb.inputs["Emission Color"].default_value = hex_rgba("#22d3ee")
        gb.inputs["Emission Strength"].default_value = 4.0
        me.materials.append(glow)
        part = me.attributes["part"].data
        for p in me.polygons:
            if all(part[v].value in body_glow for v in p.vertices):
                p.material_index = 1
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def export(ch_id, objs):
    select_only(objs)
    path = os.path.join(args.out, f"{ch_id}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_skins=True, export_animations=True,
                              export_animation_mode="NLA_TRACKS", export_vertex_color="NAME", export_vertex_color_name="Col", export_all_vertex_colors=False,
                              export_materials="EXPORT", export_image_format="NONE", export_def_bones=True, export_optimize_animation_size=True)
    return path


def preview(ch_id, rig, mesh, clip="idle"):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 24
    sc.render.resolution_x, sc.render.resolution_y = 420, 560
    cam_d = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.location = B(1.3, 1.45, 3.2)
    cam.rotation_euler = (Vector((0, 0, 1.1)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_d.lens = 50
    w = bpy.data.worlds.new("w")
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = hex_rgba("#efeaf7")
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    for c in ("idle", "sit", "walk", "type", "talk"):
        pose_frame(rig, c, 7)
        sc.render.filepath = os.path.join(args.out, f"preview-{ch_id}-{c}.png")
        bpy.ops.render.render(write_still=True)
    for tr in rig.animation_data.nla_tracks:
        tr.mute = False


summary = {}
for ch in PLAN["characters"]:
    if args.only and ch["id"] not in args.only:
        continue
    t = time.time()
    reset_scene()
    bpy.context.scene.render.fps = FPS
    robot = ch["look"]["kind"] == "robot"
    body, J = build_robot() if robot else build_human(ch)
    mesh = finish_mesh(body, ch["id"])
    rig = make_armature(ch["id"], J)
    skin(mesh, rig, body, J)
    clips = make_clips(rig, J, robot)
    # QA: in every clip nothing may sink below the floor
    for clip_name in clips:
        pose_frame(rig, clip_name, 7)
        dg = bpy.context.evaluated_depsgraph_get()
        ev = mesh.evaluated_get(dg)
        em = ev.to_mesh()
        zmin, vmin = min(((ev.matrix_world @ v.co).z, v.index) for v in em.vertices)
        ev.to_mesh_clear()
        if zmin < -0.02:
            part = body.binds[mesh.data.attributes["part"].data[vmin].value]
            raise SystemExit(f"{ch['id']}: clip {clip_name} goes {zmin:.3f} m below the floor (vertex {vmin}, bind {part}, rest z {mesh.data.vertices[vmin].co.z:.3f})")
    for tr in rig.animation_data.nla_tracks:
        tr.mute = False
    bpy.context.scene.frame_set(1)
    path = export(ch["id"], [rig, mesh])
    tris = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    summary[ch["id"]] = {"tris": tris, "bytes": os.path.getsize(path), "clips": list(clips)}
    print(f"[characters] {ch['id']}: {tris} tris, {os.path.getsize(path) / 1e3:.0f} kB, {len(clips)} clips in {time.time() - t:.1f}s")
    if args.preview:
        preview(ch["id"], rig, mesh)
json.dump(summary, open(os.path.join(args.out, "characters.json"), "w"), indent=1)
