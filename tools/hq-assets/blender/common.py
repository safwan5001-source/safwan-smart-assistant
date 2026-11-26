"""
BASHT HQ asset pipeline — shared Blender helpers.

Coordinates: the plan (tools/hq-assets/layout.json) uses three.js axes: x east, y up, z south.
Blender is Z-up; the glTF exporter maps Blender (X, Y, Z) -> glTF (X, Z, -Y). So a plan point (x, y, z) is
Blender (x, -z, y) and comes back out of the GLB exactly where the plan put it.
"""
import math

import bpy  # must be imported before bmesh
import bmesh
from mathutils import Matrix, Vector


def B(x, y, z):
    """plan (x east, y up, z south) -> Blender vector"""
    return Vector((x, -z, y))


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.objects):
        for item in list(c):
            c.remove(item)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(h, a=1.0):
    h = h.lstrip("#")
    return (*(srgb_to_linear(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)), a)


def principled(name, color, rough=0.5, metal=0.0, emission=None, emission_strength=0.0, alpha=1.0, transmission=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = hex_rgba(color)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if emission:
        p.inputs["Emission Color"].default_value = hex_rgba(emission)
        p.inputs["Emission Strength"].default_value = emission_strength
    if alpha < 1.0:
        p.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    if transmission:
        p.inputs["Transmission Weight"].default_value = transmission
    return m


class MeshSink:
    """Accumulates geometry per material into one bmesh each, so the exported building has one mesh per material."""

    def __init__(self):
        self.bms = {}

    def bm(self, mat):
        if mat not in self.bms:
            self.bms[mat] = bmesh.new()
        return self.bms[mat]

    def add_box(self, mat, x0, x1, y0, y1, z0, z1, bevel=0.0, rot=0.0, pivot=None):
        """Axis-aligned box in PLAN coordinates (x, y-up, z), optionally rotated by `rot` (plan yaw) about `pivot`."""
        bm = self.bm(mat)
        tmp = bmesh.new()
        bmesh.ops.create_cube(tmp, size=1.0)
        sx, sy, sz = max(x1 - x0, 1e-4), max(y1 - y0, 1e-4), max(z1 - z0, 1e-4)
        cx, cy, cz = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2
        # plan box -> Blender: X=x, Y=-z, Z=y
        bmesh.ops.scale(tmp, vec=Vector((sx, sz, sy)), verts=tmp.verts)
        if bevel > 0:
            bmesh.ops.bevel(tmp, geom=list(tmp.edges), offset=min(bevel, sx / 2.2, sy / 2.2, sz / 2.2), segments=2, affect="EDGES", profile=0.5)
        bmesh.ops.translate(tmp, vec=B(cx, cy, cz), verts=tmp.verts)
        if rot:
            px, pz = pivot if pivot else (cx, cz)
            self._rotate(tmp, rot, px, pz)
        self._merge(bm, tmp)

    def add_cyl(self, mat, x, z, y0, y1, r0, r1=None, segs=24, rot=0.0, pivot=None, cap=True):
        bm = self.bm(mat)
        tmp = bmesh.new()
        r1 = r0 if r1 is None else r1
        bmesh.ops.create_cone(tmp, cap_ends=cap, cap_tris=False, segments=segs, radius1=r0, radius2=r1, depth=y1 - y0)
        bmesh.ops.translate(tmp, vec=B(x, (y0 + y1) / 2, z), verts=tmp.verts)
        if rot:
            self._rotate(tmp, rot, *(pivot or (x, z)))
        self._merge(bm, tmp)

    def add_sphere(self, mat, x, y, z, r, sy=1.0, subdiv=2, rot=0.0, pivot=None, sx=1.0, sz=1.0):
        bm = self.bm(mat)
        tmp = bmesh.new()
        bmesh.ops.create_icosphere(tmp, subdivisions=subdiv, radius=r)
        bmesh.ops.scale(tmp, vec=Vector((sx, sz, sy)), verts=tmp.verts)
        bmesh.ops.translate(tmp, vec=B(x, y, z), verts=tmp.verts)
        if rot:
            self._rotate(tmp, rot, *(pivot or (x, z)))
        self._merge(bm, tmp)

    def add_torus(self, mat, x, y, z, R, r, segs=32, ring=8, arc=2 * math.pi, start=0.0, rot=0.0, pivot=None):
        """Horizontal torus (or arc) centred at plan (x, y, z)."""
        bm = self.bm(mat)
        tmp = bmesh.new()
        rings = []
        n = segs if arc >= 2 * math.pi - 1e-6 else segs + 1
        for i in range(n):
            a = start + arc * i / segs
            ring_v = []
            for j in range(ring):
                b = 2 * math.pi * j / ring
                d = R + r * math.cos(b)
                ring_v.append(tmp.verts.new(B(x + d * math.cos(a), y + r * math.sin(b), z + d * math.sin(a))))
            rings.append(ring_v)
        loops = len(rings) if arc >= 2 * math.pi - 1e-6 else len(rings) - 1
        for i in range(loops):
            a_, b_ = rings[i], rings[(i + 1) % len(rings)]
            for j in range(ring):
                tmp.faces.new((a_[j], a_[(j + 1) % ring], b_[(j + 1) % ring], b_[j]))
        if rot:
            self._rotate(tmp, rot, *(pivot or (x, z)))
        self._merge(bm, tmp)

    def add_lathe(self, mat, x, z, profile, segs=28, arc=2 * math.pi, start=0.0, rot=0.0, pivot=None):
        """Surface of revolution: profile = [(radius, y), ...] bottom->top, around the plan vertical axis at (x, z)."""
        bm = self.bm(mat)
        tmp = bmesh.new()
        full = arc >= 2 * math.pi - 1e-6
        cols = segs if full else segs + 1
        grid = []
        for i in range(cols):
            a = start + arc * i / segs
            grid.append([tmp.verts.new(B(x + r * math.cos(a), y, z + r * math.sin(a))) for r, y in profile])
        for i in range(segs if full else segs):
            c0, c1 = grid[i], grid[(i + 1) % cols]
            for j in range(len(profile) - 1):
                tmp.faces.new((c0[j], c1[j], c1[j + 1], c0[j + 1]))
        if rot:
            self._rotate(tmp, rot, *(pivot or (x, z)))
        self._merge(bm, tmp)

    @staticmethod
    def _rotate(tmp, yaw, px, pz):
        # plan yaw (three.js, about +y): in Blender that is a rotation about +Z by the same angle (y-up -> Z-up keeps the sense
        # because z_plan = -Y_blender flips one horizontal axis: rotation about +y by a maps to rotation about +Z by a).
        c = B(px, 0, pz)
        m = Matrix.Translation(c) @ Matrix.Rotation(yaw, 4, "Z") @ Matrix.Translation(-c)
        bmesh.ops.transform(tmp, matrix=m, verts=tmp.verts)

    @staticmethod
    def _merge(dst, src):
        me = bpy.data.meshes.new("_tmp")
        src.to_mesh(me)
        src.free()
        dst.from_mesh(me)
        bpy.data.meshes.remove(me)

    def build(self, prefix=""):
        objs = []
        for mat, bm in self.bms.items():
            me = bpy.data.meshes.new(prefix + mat.name)
            bm.to_mesh(me)
            bm.free()
            me.materials.append(mat)
            ob = bpy.data.objects.new(prefix + mat.name, me)
            bpy.context.scene.collection.objects.link(ob)
            objs.append(ob)
        self.bms = {}
        return objs


def select_only(objs, active=None):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def shade_auto_smooth(obj, angle_deg=35):
    for p in obj.data.polygons:
        p.use_smooth = True
    try:
        select_only([obj])
        bpy.ops.object.shade_auto_smooth(angle=math.radians(angle_deg))
    except Exception:
        pass
