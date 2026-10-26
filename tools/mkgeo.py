# ============================================================================
# mkgeo.py — the small procedural-mesh kit shared by Master Killer's art
# scripts (build_board_mk.py, build_pieces_mk.py). Everything is authored in
# GAME space (x right, y up, z toward the near player) and exported with
# export_yup=False, so Blender's axes are the game's axes.
#
# A Geo is one output mesh (one material). Faces carry a flat colour; the
# colour becomes the GLB's COLOR_0, which three.js multiplies into a white
# material. Two optional bakes help a scene lit by one warm lamp:
#   facing — tops brightest, undersides darkest (per face; for crisp,
#            mostly-flat architecture)
#   ao     — (y0, y1, floor): darken toward y0 per VERTEX, a soft gradient
# Primitives take an optional matrix M applied after their own placement, so
# props can be posed at any angle.
# ============================================================================

import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

I4 = Matrix.Identity(4)


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def newell(V, idx):
    n = Vector((0.0, 0.0, 0.0))
    for a, b in zip(idx, idx[1:] + idx[:1]):
        va, vb = V[a], V[b]
        n.x += (va.y - vb.y) * (va.z + vb.z)
        n.y += (va.z - vb.z) * (va.x + vb.x)
        n.z += (va.x - vb.x) * (va.y + vb.y)
    return n


class Geo:
    def __init__(self, name, colored=True, facing=False, ao=None):
        self.name, self.colored, self.facing, self.ao = name, colored, facing, ao
        self.V, self.F, self.C = [], [], []

    def vert(self, p):
        self.V.append(Vector(p))
        return len(self.V) - 1

    def face(self, idx, rgb, outward=None):
        """outward: a point the face must face AWAY from (orientation fix)."""
        idx = list(idx)
        n = newell(self.V, idx)
        if n.length < 1e-14:
            return
        if outward is not None:
            c = sum((self.V[i] for i in idx), Vector()) / len(idx)
            if n.dot(c - Vector(outward)) < 0:
                idx.reverse()
                n = -n
        if rgb is None:
            rgb = (1.0, 1.0, 1.0)
        if self.facing:
            ny = n.normalized().y
            m = 0.80 + 0.20 * ny if ny >= 0 else 0.80 + 0.30 * ny
            rgb = (rgb[0] * m, rgb[1] * m, rgb[2] * m)
        self.F.append(idx)
        self.C.append(tuple(rgb))

    def tris(self):
        return sum(len(f) - 2 for f in self.F)


def _xf(M, p):
    return (M or I4) @ Vector(p)


# --- primitives -----------------------------------------------------------------

def cbox(g, c, s, rgb, b=0.0, rot=0.0, bottom=False, M=None):
    """Box centred at c with full sizes s, turned about +y by rot, edges
    chamfered by b. Bottom face skipped unless asked for."""
    h = (s[0] / 2, s[1] / 2, s[2] / 2)
    b = min(b, h[0] * 0.45, h[1] * 0.45, h[2] * 0.45)
    L = (M or I4) @ Matrix.Translation(Vector(c)) @ Matrix.Rotation(rot, 4, "Y")
    center = L @ Vector((0, 0, 0))
    if b <= 0:
        vid = {}
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    vid[(sx, sy, sz)] = g.vert(L @ Vector((sx * h[0], sy * h[1], sz * h[2])))
        for a in range(3):
            i, j = [k for k in range(3) if k != a]
            for sa in (-1, 1):
                if a == 1 and sa == -1 and not bottom:
                    continue
                quad = []
                for si, sj in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                    key = [0, 0, 0]
                    key[a], key[i], key[j] = sa, si, sj
                    quad.append(vid[tuple(key)])
                g.face(quad, rgb, outward=center)
        return
    vid = {}
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                sg = (sx, sy, sz)
                for a in range(3):
                    p = [sg[k] * (h[k] - b) for k in range(3)]
                    p[a] = sg[a] * h[a]
                    vid[(sg, a)] = g.vert(L @ Vector(p))
    for a in range(3):
        i, j = [k for k in range(3) if k != a]
        for sa in (-1, 1):
            if a == 1 and sa == -1 and not bottom:
                continue
            quad = []
            for si, sj in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                sg = [0, 0, 0]
                sg[a], sg[i], sg[j] = sa, si, sj
                quad.append(vid[(tuple(sg), a)])
            g.face(quad, rgb, outward=center)
    for k in range(3):
        i, j = [m for m in range(3) if m != k]
        for si in (-1, 1):
            for sj in (-1, 1):
                c1 = [0, 0, 0]
                c1[k], c1[i], c1[j] = -1, si, sj
                c2 = list(c1)
                c2[k] = 1
                g.face([vid[(tuple(c1), i)], vid[(tuple(c2), i)],
                        vid[(tuple(c2), j)], vid[(tuple(c1), j)]], rgb, outward=center)
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                sg = (sx, sy, sz)
                g.face([vid[(sg, 0)], vid[(sg, 1)], vid[(sg, 2)]], rgb, outward=center)


def lathe(g, prof, n, cols, M=None, phase=0.0, skip=None, cap_top=False, cap_bot=False):
    """Revolve a profile [(r, y), ...] about +y. Trace it bottom -> outside ->
    top: each segment's outward normal is the right-hand perpendicular of its
    direction in the (r, y) plane. cols: one rgb or one per segment. A ring
    with r == 0 collapses to a single pole vertex. skip(k, s) -> True drops a
    face (k = profile segment, s = angular step) — openings like a hood's."""
    if cols is None:  # glow meshes carry no vertex colour
        cols = (1.0, 1.0, 1.0)
    if isinstance(cols[0], (int, float)):
        cols = [cols] * (len(prof) - 1)
    rings = []
    for r, y in prof:
        if r <= 1e-7:
            rings.append([g.vert(_xf(M, (0.0, y, 0.0)))] * n)
        else:
            rings.append([g.vert(_xf(M, (r * math.cos(phase + 2 * math.pi * s / n), y,
                                         r * math.sin(phase + 2 * math.pi * s / n)))) for s in range(n)])
    for k in range(len(prof) - 1):
        (r0, y0), (r1, y1) = prof[k], prof[k + 1]
        dr, dy = r1 - r0, y1 - y0
        L = math.hypot(dr, dy) or 1.0
        nr, ny = dy / L, -dr / L
        rm, ymid = (r0 + r1) / 2, (y0 + y1) / 2
        for s in range(n):
            if skip and skip(k, s):
                continue
            s2 = (s + 1) % n
            t = phase + 2 * math.pi * (s + 0.5) / n
            ct, st = math.cos(t), math.sin(t)
            behind = _xf(M, (rm * ct - nr * ct * 0.01, ymid - ny * 0.01, rm * st - nr * st * 0.01))
            idx = [rings[k][s], rings[k][s2], rings[k + 1][s2], rings[k + 1][s]]
            idx = [v for i, v in enumerate(idx) if v not in idx[:i]]
            if len(idx) >= 3:
                g.face(idx, cols[k], outward=behind)
    if cap_top and prof[-1][0] > 1e-7:
        y = prof[-1][1]
        g.face(rings[-1], cols[-1], outward=_xf(M, (0, y - 0.01, 0)))
    if cap_bot and prof[0][0] > 1e-7:
        y = prof[0][1]
        g.face(rings[0], cols[0], outward=_xf(M, (0, y + 0.01, 0)))


def frustum(g, x, z, r0, r1, y0, y1, n, rgb, top=True, rot=0.0, bottom=False, M=None):
    """Vertical frustum / cylinder / cone (r1 == 0) on axis (x, z)."""
    T = (M or I4) @ Matrix.Translation((x, 0, z))
    lathe(g, [(r0, y0), (r1, y1)], n, rgb, M=T, phase=rot, cap_top=top, cap_bot=bottom)


def sphere(g, c, r, rgb, n=14, rings=8, scale=(1, 1, 1), M=None, skip=None, phase=0.0):
    prof = [(r * math.sin(math.pi * k / rings), -r * math.cos(math.pi * k / rings)) for k in range(rings + 1)]
    T = (M or I4) @ Matrix.Translation(Vector(c)) @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
    lathe(g, prof, n, rgb, M=T, skip=skip, phase=phase)


def annulus(g, x, z, ri, ro, y, h, n, rgb):
    """Flat raised ring: top face plus inner and outer walls."""
    lathe(g, [(ro, y), (ro, y + h), (ri, y + h), (ri, y)], n, rgb, M=Matrix.Translation((x, 0, z)))


def _frame(t, up_hint=None):
    t = Vector(t).normalized()
    a = Vector(up_hint) if up_hint is not None else Vector((0, 1, 0))
    if abs(a.normalized().dot(t)) > 0.95:
        a = Vector((1, 0, 0)) if abs(t.x) < 0.9 else Vector((0, 0, 1))
    u = t.cross(a).normalized()
    v = u.cross(t).normalized()
    return u, v


def path(g, pts, radii, n, rgb, cap0=True, cap1=True, M=None):
    """Tube along a polyline (parallel-transported rings); radii per point
    (0 at an end makes a point). Bows, horns, feathers, bent hat tips."""
    P = [_xf(M, p) for p in pts]
    if isinstance(radii, (int, float)):
        radii = [radii] * len(P)
    cols = rgb if isinstance(rgb, list) else [rgb] * (len(P) - 1)
    rings = []
    u = None
    for k, p in enumerate(P):
        if k == 0:
            t = P[1] - P[0]
        elif k == len(P) - 1:
            t = P[-1] - P[-2]
        else:
            t = (P[k + 1] - P[k - 1])
        t.normalize()
        if u is None:
            u, v = _frame(t)
        else:
            u = (u - t * u.dot(t)).normalized()
            v = t.cross(u).normalized()
        r = radii[k]
        if r <= 1e-7:
            rings.append([g.vert(p)] * n)
        else:
            rings.append([g.vert(p + (u * math.cos(2 * math.pi * s / n) + v * math.sin(2 * math.pi * s / n)) * r)
                          for s in range(n)])
    for k in range(len(P) - 1):
        axis = (P[k] + P[k + 1]) / 2
        for s in range(n):
            s2 = (s + 1) % n
            idx = [rings[k][s], rings[k][s2], rings[k + 1][s2], rings[k + 1][s]]
            idx = [v_ for i, v_ in enumerate(idx) if v_ not in idx[:i]]
            if len(idx) >= 3:
                g.face(idx, cols[k], outward=axis)
    if cap0 and radii[0] > 1e-7:
        g.face(rings[0], cols[0], outward=P[1])
    if cap1 and radii[-1] > 1e-7:
        g.face(rings[-1], cols[-1], outward=P[-2])


def tube(g, p, q, r0, r1, n, rgb, M=None):
    path(g, [p, q], [r0, r1], n, rgb, M=M)


def strip(g, p, q, y, w, h, rgb):
    """Thin raised line from p to q (x, z) on a surface at height y."""
    dx, dz = q[0] - p[0], q[1] - p[1]
    L = math.hypot(dx, dz)
    cbox(g, ((p[0] + q[0]) / 2, y + h / 2, (p[1] + q[1]) / 2), (L + w * 0.6, h, w), rgb,
         rot=math.atan2(-dz, dx))


def prism(g, pts, origin, U, Vv, W, width, rgb, back=True, M=None):
    """Extrude a convex 2D outline (u, v) along W by width."""
    Mm = M or I4
    origin = Mm @ Vector(origin)
    R = Mm.to_3x3()
    U, Vv, W = R @ Vector(U), R @ Vector(Vv), R @ Vector(W)
    A = [g.vert(origin + U * u + Vv * v) for u, v in pts]
    B = [g.vert(origin + U * u + Vv * v + W * width) for u, v in pts]
    cu = sum(u for u, _ in pts) / len(pts)
    cv = sum(v for _, v in pts) / len(pts)
    cen = origin + U * cu + Vv * cv + W * (width / 2)
    if back:
        g.face(A, rgb, outward=cen)
    g.face(B, rgb, outward=cen)
    n = len(pts)
    for k in range(n):
        k2 = (k + 1) % n
        g.face([A[k], A[k2], B[k2], B[k]], rgb, outward=cen)


def crystal(g, x, z, y0, y1, r, n=6, mid=0.55, rot=0.0, rgb=None, M=None):
    ym = y0 + (y1 - y0) * mid
    T = (M or I4) @ Matrix.Translation((x, 0, z))
    lathe(g, [(0.0, y0), (r, ym), (0.0, y1)], n, rgb or (1, 1, 1), M=T, phase=rot)


# --- objects, materials, export ------------------------------------------------

def make_obj(g, mat, smooth_angle=None):
    me = bpy.data.meshes.new(g.name)
    me.from_pydata([tuple(v) for v in g.V], [], g.F)
    if g.colored:
        sizes = np.array([len(f) for f in g.F])
        cols = np.repeat(np.array([(c[0], c[1], c[2], 1.0) for c in g.C], dtype=np.float32), sizes, axis=0)
        if g.ao is not None:
            y0, y1, floor = g.ao
            vi = np.empty(len(me.loops), dtype=np.int64)
            me.loops.foreach_get("vertex_index", vi)
            ys = np.array([v.y for v in g.V], dtype=np.float32)[vi]
            t = np.clip((ys - y0) / (y1 - y0), 0.0, 1.0)
            m = floor + (1.0 - floor) * (t * t * (3 - 2 * t))
            cols[:, :3] *= m[:, None]
        attr = me.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
        attr.data.foreach_set("color", cols.reshape(-1))
        me.color_attributes.active_color_index = me.color_attributes.find("Color")
        me.color_attributes.render_color_index = me.color_attributes.find("Color")
    me.validate(clean_customdata=False)
    if smooth_angle is None:
        me.shade_flat()
    else:
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(smooth_angle))
    obj = bpy.data.objects.new(g.name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def vertex_material(name, rough, metal=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Roughness"].default_value = rough
    vc = tree.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Color"
    tree.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def glow_material(name, rgb, strength):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (rgb[0] * 0.2, rgb[1] * 0.2, rgb[2] * 0.2, 1)
    bsdf.inputs["Roughness"].default_value = 0.3
    bsdf.inputs["Emission Color"].default_value = (rgb[0], rgb[1], rgb[2], 1)
    bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)


def export_glb(objs, path, draco=False, lights=False, attributes=False, pos_bits=14, log=print):
    """attributes: also export custom mesh attributes named with a leading
    underscore (three.js reads `_MAT` as geometry attribute `_mat`)."""
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, use_selection=True, export_format="GLB", export_yup=False,
              export_apply=True, export_vertex_color="ACTIVE", export_all_vertex_colors=False,
              export_lights=lights, export_attributes=attributes)
    if lights:
        kw["export_import_convert_lighting_mode"] = "RAW"  # three.js reads it as candela
    if draco:
        kw.update(export_draco_mesh_compression_enable=True,
                  export_draco_mesh_compression_level=10,
                  export_draco_position_quantization=pos_bits,
                  export_draco_normal_quantization=10,
                  export_draco_color_quantization=8,
                  export_draco_generic_quantization=10)
    bpy.ops.export_scene.gltf(**kw)
    log(f"exported {os.path.basename(path)} ({os.path.getsize(path) / 1e3:.1f} KB)")


def aim(obj, pos, target):
    """Point a camera/light (looks down its local -Z) from pos at target, y up."""
    f = (Vector(target) - Vector(pos)).normalized()
    r = f.cross(Vector((0, 1, 0)))
    if r.length < 1e-6:
        r = Vector((1, 0, 0))
    r.normalize()
    u = r.cross(f)
    obj.matrix_world = Matrix((
        (r.x, u.x, -f.x, pos[0]),
        (r.y, u.y, -f.y, pos[1]),
        (r.z, u.z, -f.z, pos[2]),
        (0, 0, 0, 1)))
