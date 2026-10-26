# ============================================================================
# build_pieces_mk.py — Master Killer's playing pieces, built entirely from
# code: ten class miniatures (red + blue team), a hooded stand-in for before
# the class pick, and the flip coins. Replaces the licensed pek_andrei stone
# disc and coin.
#
# Run headless (Windows):
#   "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" -b --factory-startup --python tools/build_pieces_mk.py
#   PIECES_PREVIEW=0          skip the EEVEE preview renders
#   PIECES_ONLY=mage,warrior  build (and preview) just these classes; nothing is exported
#   PIECES_DEBUG=1            print each part's triangle count
#
# Outputs (Draco):
#   stage/public/figures.glb      token_<class>_<red|blue>, 20 meshes
#   stage/public/pieces-core.glb  token_p1, token_p2 (stand-ins), coin_red, coin_blue
#   tools/out/pieces-mk-lineup.png  the red set from the game camera's angle
#   tools/out/hero/<class>.png      a close-up of each red figure
#
# The miniatures are made the way a resin mini is sculpted and painted:
#   - a figure is a set of PARTS, one per paint (skin, hair, cloth, steel...),
#     each modelled from simple primitives on a posed skeleton, every class
#     dressed after its portrait (stage/public/avatars);
#   - every soft part is FUSED: voxel-remeshed into one surface, relaxed and
#     decimated, so an arm grows out of its shoulder instead of poking through
#     it, and cloth (skirts, cloaks, collars — "sheets") gets real thickness.
#     Crisp pieces (blades, bowstrings, gems, eyes, the base) skip the fuse;
#   - the joined figure is painted into its vertex colour like a mini: baked
#     ambient occlusion for the wash, a zenithal gradient (light from above),
#     and edge highlights along convex edges.
#
# Contract with stage/src/main.ts (the game supplies the material):
#   - POSITION, NORMAL, COLOR_0 (the paint) and _MAT, a per-vertex finish code
#     read by stage/src/figure-material.ts: 0 matte, .25 satin, .5 gloss,
#     .75 metal, 1 glow (lit from within: crystals, orbs, fel fire).
#   - every figure stands on a FLAT round base (r ~0.2), bottom at y = 0, facing
#     +z (toward the shared camera); main.ts re-pivots so the base sits on the
#     tile. Team identity lives in the base: an enamel ring on top and an
#     enamel band round the side (red / blue) under a gold lip. Nothing taller
#     than ~0.5, so a near-row figure never hides the middle row.
#   - coins: radius 0.15, 0.03 thick, the MARKED face up (+y). The marked
#     face is bright gold relief, the blank face plain dark iron, so a flip
#     reads at a glance; the rim ring is the team enamel.
# Figures are local-space modelled: x = the figure's left (viewer's right).
# ============================================================================

import math
import os
import random
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mkgeo import (Geo, aim, annulus, cbox, clear_scene, export_glb, lathe, path, sphere,  # noqa: E402
                   vertex_material)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "tools", "out")
os.makedirs(os.path.join(OUT, "hero"), exist_ok=True)
FIGURES_GLB = os.path.join(REPO, "stage", "public", "figures.glb")
CORE_GLB = os.path.join(REPO, "stage", "public", "pieces-core.glb")
ONLY = [c for c in os.environ.get("PIECES_ONLY", "").split(",") if c]
PREVIEW = os.environ.get("PIECES_PREVIEW", "1") == "1"
DEBUG = os.environ.get("PIECES_DEBUG", "0") == "1"


def log(*a):
    print("[pieces-mk]", *a, flush=True)


FIG_SCALE = 1.2       # model units -> game units (base r 0.165 -> ~0.2, a tile)
BODY = 1.20           # the figure (not the base) grows about the standing point
VOXEL = 0.0021        # fuse resolution, game units
TRI_DENSITY = 17000   # triangles per unit² of fused surface, game units
AO_DIST = 0.035       # how far the wash reaches, game units

MATTE, SATIN, GLOSS, METAL, GLOW = 0.0, 0.25, 0.5, 0.75, 1.0

# --- palette (linear) ------------------------------------------------------------
TEAM = {"red": (0.62, 0.035, 0.028), "blue": (0.035, 0.11, 0.62)}
BASE_STONE = (0.085, 0.080, 0.078)
MORTAR = (0.014, 0.013, 0.013)
COBBLE = (0.075, 0.070, 0.066)
GOLD = (0.83, 0.56, 0.20)
STEEL = (0.62, 0.64, 0.68)
BRIGHT_STEEL = (0.86, 0.88, 0.92)
DARK_STEEL = (0.20, 0.21, 0.24)
SKIN = (0.54, 0.30, 0.20)
SKIN_FAIR = (0.64, 0.41, 0.30)
SKIN_PALE = (0.58, 0.44, 0.39)
SKIN_TAN = (0.52, 0.29, 0.17)
LEATHER = (0.16, 0.075, 0.035)
DARK_LEATHER = (0.055, 0.035, 0.025)
WOOD = (0.19, 0.095, 0.04)
DARK_WOOD = (0.07, 0.04, 0.025)
BONE = (0.70, 0.64, 0.50)
SCLERA = (0.62, 0.58, 0.53)
LIPS = (0.46, 0.15, 0.13)
STRING = (0.80, 0.76, 0.64)

# --- skeleton (model units, before BODY and FIG_SCALE) --------------------------------
BASE_R = 0.165
BASE_TOP = 0.038      # top of the enamel ring
Y0 = 0.040            # standing surface: the cobble tops
ANK = Y0 + 0.016
KNEE = Y0 + 0.072
HIP = Y0 + 0.122
WAIST = Y0 + 0.150
CHEST = Y0 + 0.182
SHO = Y0 + 0.204      # shoulder joints
NECK = Y0 + 0.214
HEAD = Y0 + 0.241     # head centre
HR = 0.030            # head radius


# --- math helpers -------------------------------------------------------------------

def V(*p):
    return Vector(p[0] if len(p) == 1 else p)


def lerp(a, b, t):
    return V(a).lerp(V(b), t)


def T(p):
    return Matrix.Translation(V(p))


def S(x, y, z):
    return Matrix.Diagonal((x, y, z, 1.0))


def rot_x(a):
    return Matrix.Rotation(a, 4, "X")


def rot_y(a):
    return Matrix.Rotation(a, 4, "Y")


def rot_z(a):
    return Matrix.Rotation(a, 4, "Z")


def basis(y_dir, x_hint=(1, 0, 0)):
    """Rotation whose local +y is y_dir and local +x lies as close to x_hint
    as it can."""
    y = V(y_dir).normalized()
    x = V(x_hint)
    x = x - y * x.dot(y)
    if x.length < 1e-6:
        x = V(0, 0, 1) - y * y.z
    x.normalize()
    z = x.cross(y)
    return Matrix((x, y, z)).transposed().to_4x4()


def frame(origin, y_dir, x_hint=(1, 0, 0)):
    return T(origin) @ basis(y_dir, x_hint)


def _xf(M, p):
    return (M or Matrix.Identity(4)) @ V(p)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# --- parts --------------------------------------------------------------------------

class Part(Geo):
    """One paint on one figure. kind: 'fuse' (closed volumes, remeshed into one
    surface), 'sheet' (open cloth, thickened by `thick` and then fused) or
    'hard' (kept exactly as modelled, per-face colours allowed)."""

    def __init__(self, key, name, rgb, mat, kind, thick):
        super().__init__(name)
        self.key, self.rgb, self.mat, self.kind, self.thick = key, rgb, mat, kind, thick


class Fig:
    def __init__(self, name, team):
        self.name, self.team, self.parts = name, team, {}
        self.body_M = Matrix.Identity(4)    # where the figure stands on its base

    def __call__(self, key, rgb=None, mat=MATTE, kind="fuse", thick=0.0045):
        p = self.parts.get(key)
        if p is None:
            if rgb is None:
                raise ValueError(f"{self.name}: part '{key}' used before it was given a colour")
            p = self.parts[key] = Part(key, f"{self.name}.{key}", rgb, mat, kind, thick)
        return p


def ball(p, c, r, scale=(1, 1, 1), M=None, n=18, rings=10, skip=None, rgb=None):
    """skip(k, s, t): k = ring from the bottom pole, t = angle (90deg = front)."""
    sk = (lambda k, s: skip(k, s, 2 * math.pi * (s + 0.5) / n)) if skip else None
    sphere(p, tuple(V(c)), r, rgb or p.rgb, n=n, rings=rings, scale=scale, M=M, skip=sk)


def tube(p, pts, radii, n=12, M=None, rgb=None, cap0=True, cap1=True):
    path(p, [tuple(V(q)) for q in pts], radii, n, rgb or p.rgb, M=M, cap0=cap0, cap1=cap1)


def box(p, c, s, b=0.0, M=None, rot=0.0, rgb=None):
    cbox(p, tuple(V(c)), s, rgb or p.rgb, b=b, M=M, rot=rot, bottom=True)


def ring(p, c, r, w, M=None, n=24, rgb=None, y_dir=(0, 1, 0)):
    """Closed band of tube radius w, radius r, around axis y_dir at c."""
    F = (M or Matrix.Identity(4)) @ frame(c, y_dir)
    pts = [F @ V(r * math.cos(2 * math.pi * i / n), 0, r * math.sin(2 * math.pi * i / n)) for i in range(n + 1)]
    path(p, [tuple(q) for q in pts], w, 8, rgb or p.rgb, cap0=False, cap1=False)


def revolve(p, prof, n=28, warp=None, skip=None, M=None, rgb=None, phase=0.0):
    """lathe() with a per-vertex warp(k, t) -> (r_mult, dy, dz): cloth folds,
    hems that dip at the back. t = 90deg faces the front (+z)."""
    rgb = rgb or p.rgb
    rings_ = []
    for k, (r, y) in enumerate(prof):
        if r <= 1e-7:
            _, dy, dz = warp(k, math.pi / 2) if warp else (1, 0, 0)
            rings_.append([p.vert(_xf(M, (0.0, y + dy, dz)))] * n)
            continue
        rr = []
        for s in range(n):
            t = phase + 2 * math.pi * s / n
            rm, dy, dz = warp(k, t) if warp else (1.0, 0.0, 0.0)
            rr.append(p.vert(_xf(M, (r * rm * math.cos(t), y + dy, r * rm * math.sin(t) + dz))))
        rings_.append(rr)
    for k in range(len(prof) - 1):
        ym = (prof[k][1] + prof[k + 1][1]) / 2
        for s in range(n):
            if skip and skip(k, s, phase + 2 * math.pi * (s + 0.5) / n):
                continue
            s2 = (s + 1) % n
            idx = [rings_[k][s], rings_[k][s2], rings_[k + 1][s2], rings_[k + 1][s]]
            idx = [v for i, v in enumerate(idx) if v not in idx[:i]]
            if len(idx) >= 3:
                p.face(idx, rgb, outward=_xf(M, (0.0, ym, 0.0)))


def loft(p, sections, M=None, rgb=None, cap0=True, cap1=True):
    """Join cross-sections [(y, [(x, z), ...]), ...] (same point count, or a
    single point for a tip) along local y: blades, axe bits, lute necks."""
    rgb = rgb or p.rgb
    rings_ = []
    for y, pts in sections:
        rings_.append([p.vert(_xf(M, (x, y, z))) for x, z in pts])
    n = max(len(r) for r in rings_)
    rings_ = [r * n if len(r) == 1 else r for r in rings_]
    cen = [_xf(M, (0.0, y, 0.0)) for y, _ in sections]
    for k in range(len(rings_) - 1):
        c = (cen[k] + cen[k + 1]) / 2
        for s in range(n):
            s2 = (s + 1) % n
            idx = [rings_[k][s], rings_[k][s2], rings_[k + 1][s2], rings_[k + 1][s]]
            idx = [v for i, v in enumerate(idx) if v not in idx[:i]]
            if len(idx) >= 3:
                p.face(idx, rgb, outward=c)
    if cap0 and len(set(rings_[0])) > 2:
        p.face(rings_[0], rgb, outward=cen[1])
    if cap1 and len(set(rings_[-1])) > 2:
        p.face(rings_[-1], rgb, outward=cen[-2])


def front_open(deg):
    """skip() for revolve / drape: drop the faces within +-deg of the front."""
    c = math.cos(math.radians(deg))
    return lambda k, s, t: math.sin(t) > c


def back_only(deg):
    """skip() keeping only the faces within +-deg of the back."""
    c = math.cos(math.radians(deg))
    return lambda k, s, t: -math.sin(t) < c


def front_only(deg):
    c = math.cos(math.radians(deg))
    return lambda k, s, t: math.sin(t) < c


def drape(p, y_top, y_hem, r_top, r_hem, *, folds=8, amp=0.09, bulge=0.0, back_drop=0.0, front_rise=0.0,
          flow=0.0, jag=0.0, rings=7, n=36, skip=None, M=None, sx=1.0, sz=1.0, fold_phase=0.7, rgb=None):
    """A hanging cloth surface (skirt, robe, cloak, mantle...) from y_top down to
    a folded hem; the folds deepen toward the hem. flow sweeps the hem back
    (a cape in the wind), jag tears it into points. Use on a 'sheet' part."""
    prof = []
    for i in range(rings + 1):
        u = i / rings                       # 0 at the hem, 1 at the top
        y = y_hem + (y_top - y_hem) * u
        r = r_hem + (r_top - r_hem) * (u ** 0.85) + bulge * math.sin(math.pi * u)
        prof.append((r, y))

    def warp(k, t):
        u = k / rings
        fa = amp * (1 - u) ** 1.2
        rm = 1 + fa * math.sin(folds * t + fold_phase) + 0.35 * fa * math.sin((2 * folds + 1) * t + 1.3)
        front = math.sin(t)
        dy = (-back_drop * max(0.0, -front) ** 1.5 + front_rise * max(0.0, front) ** 2) * (1 - u) ** 2
        if jag and k == 0:
            dy -= jag * (0.5 + 0.5 * math.cos(folds * 2 * t))
        return rm, dy, -flow * (1 - u) ** 1.6
    revolve(p, prof, n, warp=warp, skip=skip, M=(M or Matrix.Identity(4)) @ S(sx, 1, sz), rgb=rgb)


# --- anatomy ------------------------------------------------------------------------

def torso(p, *, wide=1.0, deep=1.0, fem=False, top=None, bottom=None, grow=0.0, M=None):
    """Pelvis to neck as one revolved, flattened volume. grow inflates it (a
    breastplate, a coat over the body); top / bottom trim it to a band."""
    g = grow
    prof = [(0.0, HIP - 0.016), (0.026 + g, HIP - 0.010), (0.031 + g, HIP + 0.004),
            ((0.028 if fem else 0.029) + g, WAIST - 0.004), (0.031 + g, CHEST - 0.016),
            ((0.034 if fem else 0.037) + g, CHEST), ((0.031 if fem else 0.035) + g, SHO - 0.006),
            (0.024 + g, SHO + 0.007), (0.011 + g, NECK + 0.002), (0.0, NECK + 0.004)]
    if bottom is not None or top is not None:
        lo, hi = bottom or -1, top or 9
        keep = [q for q in prof if lo <= q[1] <= hi and q[0] > 0]
        prof = [(0.0, keep[0][1])] + keep + [(0.0, keep[-1][1])]
    revolve(p, prof, 28, M=(M or Matrix.Identity(4)) @ S(1.24 * wide, 1.0, 0.80 * deep))
    if fem and (top is None or top > CHEST):
        for sx in (-1, 1):
            ball(p, (sx * 0.014, CHEST - 0.004, 0.013 * deep + g), 0.0115, scale=(1.0, 0.92, 0.80), M=M)


def shoulder(side, wide=1.0):
    return V(side * 0.047 * wide, SHO, 0.0)


def head(f, c, *, r=HR, skin=SKIN, fem=False, iris=(0.10, 0.06, 0.03), brow=(0.06, 0.035, 0.02), lips=None,
         glow_eyes=None, yaw=0.0, pitch=0.0, roll=0.0, ears=True, elf=False, eyes=True):
    """Cranium, jaw, brow, nose, cheeks, ears (fused skin); painted eyes, brows
    and lips (hard). Returns the head's frame for hair and hats."""
    M = T(c) @ rot_y(yaw) @ rot_x(pitch) @ rot_z(roll)
    sk = f("skin", skin, SATIN)
    ball(sk, (0, 0.05 * r, -0.03 * r), r, scale=(0.90, 1.0, 0.98), M=M, n=22, rings=12)
    ball(sk, (0, -0.40 * r, 0.20 * r), r * (0.60 if fem else 0.68), scale=(0.90, 0.82, 0.95), M=M)
    ball(sk, (0, -0.12 * r, 0.93 * r), r * (0.12 if fem else 0.155), scale=(0.72, 1.25, 0.95), M=M)  # nose
    ball(sk, (0, 0.25 * r, 0.72 * r), r * 0.46, scale=(1.40, 0.22 if fem else 0.34, 0.58), M=M)      # brow
    for sx in (-1, 1):
        ball(sk, (sx * 0.42 * r, -0.28 * r, 0.56 * r), r * (0.24 if fem else 0.28), M=M)            # cheeks
        if ears:
            if elf:
                tube(sk, [M @ V(sx * 0.80 * r, 0.0, -0.05 * r), M @ V(sx * 1.25 * r, 0.42 * r, -0.22 * r)],
                     [r * 0.17, 0.0], n=8)
            else:
                ball(sk, (sx * 0.88 * r, -0.02 * r, -0.06 * r), r * 0.27, scale=(0.48, 1.0, 0.72), M=M)
    ew = 1.10 if fem else 1.0
    for sx in ((-1, 1) if eyes else ()):
        if glow_eyes:
            ball(f("eyeglow", glow_eyes, GLOW, "hard"), (sx * 0.33 * r, 0.03 * r, 0.83 * r), r * 0.12,
                 scale=(1.15 * ew, 0.55, 0.6), M=M, n=10, rings=6)
        else:
            ball(f("sclera", SCLERA, GLOSS, "hard"), (sx * 0.33 * r, 0.03 * r, 0.83 * r), r * 0.13,
                 scale=(1.15 * ew, 0.66, 0.6), M=M, n=12, rings=6)
            ball(f("iris", iris, GLOSS, "hard"), (sx * 0.31 * r, 0.03 * r, 0.886 * r), r * 0.092,
                 scale=(0.95, 1.12, 0.5), M=M, n=10, rings=6)
            # the painter's dark upper lid line, so the eye reads at arm's length
            tube(f("lids", (0.035, 0.022, 0.016), MATTE, "hard"),
                 [M @ V(sx * 0.19 * r, 0.09 * r, 0.895 * r), M @ V(sx * 0.33 * r, 0.125 * r, 0.915 * r),
                  M @ V(sx * 0.48 * r, 0.08 * r, 0.845 * r)], [r * 0.026, r * 0.032, r * 0.012], n=6)
        bp = f("brows", brow, MATTE, "hard")
        tube(bp, [M @ V(sx * 0.15 * r, 0.27 * r, 0.90 * r), M @ V(sx * 0.33 * r, 0.32 * r, 0.88 * r),
                  M @ V(sx * 0.52 * r, 0.27 * r, 0.76 * r)], [r * (0.050 if fem else 0.068), r * 0.055, r * 0.02], n=6)
    if lips:
        ball(f("lips", lips, GLOSS, "hard"), (0, -0.47 * r, 0.80 * r), r * 0.12, scale=(1.55, 0.55, 0.62), M=M,
             n=12, rings=6)
    return M


def hair_cap(p, M, r=HR, *, front=0.72, back=0.22, sides=0.36, puff=1.09):
    """Hair on the scalp as a thick shell, opening for the face. front / back
    / sides = how far down the hairline comes (fraction of the head from the
    bottom pole, 0..1)."""
    rings_ = 20

    def skip(k, s, t):
        phi = (k + 0.5) / rings_
        fr = math.sin(t)
        lim = sides + (front - sides) * max(0.0, fr) ** 1.6 + (back - sides) * max(0.0, -fr)
        return phi < lim
    ball(p, (0, 0.06 * r, -0.04 * r), r * puff, scale=(0.92, 1.02, 1.0), M=M, n=40, rings=rings_, skip=skip)


def lock(p, pts, r0, r1=0.0012, n=10):
    """A tapered lock of hair along pts."""
    k = len(pts)
    tube(p, pts, [r0 + (r1 - r0) * (i / (k - 1)) ** 0.9 for i in range(k)], n=n)


def long_hair(p, M, r=HR, *, length=0.090, count=6, spread=1.0, front_locks=True, wave=0.004, thick=0.0105):
    """Locks from the crown down the back (and two over the shoulders)."""
    for k in range(count):
        a = math.pi * (0.15 + 0.70 * k / max(1, count - 1))      # around the back, side to side
        sx, sz = -math.cos(a) * spread, -math.sin(a)
        top = M @ V(sx * r * 0.82, 0.18 * r, sz * r * 0.80)
        out = V(sx, 0, sz * 0.6).normalized() if abs(sx) > 0.05 else V(0, 0, -1)
        pts = [top]
        for i in range(1, 5):
            u = i / 4
            pts.append(top + out * (0.010 * math.sin(u * math.pi * 0.8)) + V(0, -length * u, -0.006 * u)
                       + V(math.sin(u * 7 + k) * wave, 0, 0))
        lock(p, pts, thick * (0.9 + 0.2 * (k % 2)))
    if front_locks:
        for sx in (-1, 1):
            top = M @ V(sx * r * 0.80, 0.02 * r, 0.25 * r)
            lock(p, [top, top + V(sx * 0.006, -0.026, 0.008), top + V(sx * 0.008, -0.050, 0.016),
                     top + V(sx * 0.006, -0.066, 0.018)], thick * 0.70)


def bangs(p, M, r=HR, side=1):
    """A side-swept fringe across the forehead."""
    for k in range(4):
        x0 = -side * (0.30 - 0.16 * k) * r
        top = M @ V(x0, 0.98 * r, 0.20 * r)
        lock(p, [top, M @ V(x0 + side * 0.25 * r, 0.80 * r, 0.80 * r), M @ V(x0 + side * 0.55 * r, 0.50 * r, 0.92 * r)],
             r * 0.20, r * 0.06, n=8)


def leg(f, side, ankle, *, knee=None, legs="legs", boots="boots", thigh=0.0165, calf=0.0128, toe_yaw=0.0,
        boot_h=0.036, boot_r=0.0128, foot=1.0, hip_x=0.019, cuff=None):
    hip = V(side * hip_x, HIP, 0.0)
    ankle = V(ankle)
    knee = V(knee) if knee is not None else lerp(hip, ankle, 0.5) + V(0, 0, 0.006)
    lp = f(legs)
    tube(lp, [hip, knee], [thigh, 0.0118])
    ball(lp, knee, 0.0122)
    tube(lp, [knee, lerp(knee, ankle, 0.32), ankle], [0.0118, calf, 0.0090])
    bp = f(boots)
    shaft_top = lerp(ankle, knee, min(0.95, boot_h / max(1e-6, knee.y - ankle.y)))
    tube(bp, [shaft_top, ankle], [boot_r * 1.06, boot_r * 0.92])
    if cuff:
        ring(f(cuff), shaft_top, boot_r * 1.08, 0.0026, n=16, y_dir=shaft_top - ankle)
    fc = V(ankle.x + math.sin(toe_yaw) * 0.011 * foot, Y0 + 0.0072, ankle.z + math.cos(toe_yaw) * 0.011 * foot)
    ball(bp, (0, 0, 0), 1.0, scale=(0.0118 * foot, 0.0094, 0.0225 * foot), M=T(fc) @ rot_y(toe_yaw))
    return knee


def arm(f, side, el, wr, *, sleeve="sleeves", hands="hands", up=0.0132, fore=0.0108, fist=0.0118, grip=None,
        open_hand=False, wide=1.0, sh=None):
    """Shoulder -> elbow -> wrist, and a hand at the wrist. grip: the axis a held
    weapon passes through the fist along. Returns the hand centre."""
    sh = V(sh) if sh is not None else shoulder(side, wide)
    el, wr = V(el), V(wr)
    sp = f(sleeve)
    ball(sp, sh, up * 1.06)
    tube(sp, [sh, el], [up, up * 0.88])
    ball(sp, el, up * 0.88)
    tube(sp, [el, wr], [fore, fore * 0.80])
    return hand(f(hands), el, wr, fist, grip=grip, open_=open_hand, side=side)


def hand(p, el, wr, r, *, grip=None, open_=False, side=1):
    d = (V(wr) - V(el)).normalized()
    c = V(wr) + d * r * 0.78
    if open_:
        # open hand: palm toward grip, fingers on along the forearm
        M = frame(c, d, grip or (0, 1, 0))
        box(p, (0, 0, 0), (r * 1.7, r * 1.9, r * 0.75), b=r * 0.3, M=M)
        tube(p, [M @ V(side * r * 0.85, -r * 0.3, 0), M @ V(side * r * 1.25, r * 0.35, r * 0.15)], [r * 0.32, r * 0.22])
        return c
    M = frame(c, d, grip or (side, 0, 0))
    box(p, (0, 0, 0), (r * 1.55, r * 1.70, r * 1.45), b=r * 0.48, M=M)
    tube(p, [M @ V(0, -r * 0.35, r * 0.62), M @ V(0, r * 0.35, r * 0.80)], [r * 0.34, r * 0.28])    # thumb
    return c


def bell_sleeve(p, el, wr, r0=0.0118, r1=0.0175):
    tube(p, [lerp(el, wr, 0.2), lerp(el, wr, 0.92)], [r0, r1])


# --- the base -----------------------------------------------------------------------

def base(f):
    """Beveled plinth: dark stone foot, team-enamel band under a gold lip, an
    enamel ring on top and a radial cobble field the figure stands on."""
    rng = random.Random(7)
    en = TEAM[f.team]
    st = f("base_stone", BASE_STONE, SATIN, "hard")
    enamel = f("base_enamel", en, GLOSS, "hard")
    gold = f("base_gold", GOLD, METAL, "hard")
    n = 48
    R = BASE_R
    lathe(st, [(R - 0.004, 0.0), (R, 0.004), (R, 0.009), (R - 0.003, 0.0105)], n, BASE_STONE, cap_bot=True)
    lathe(enamel, [(R - 0.003, 0.0105), (R - 0.003, 0.0275)], n, en)
    lathe(gold, [(R - 0.003, 0.0275), (R + 0.0005, 0.0290), (R + 0.0005, 0.0325), (R - 0.002, 0.0340)], n, GOLD)
    lathe(enamel, [(R - 0.002, 0.0340), (R - 0.008, BASE_TOP), (0.140, BASE_TOP)], n, en)
    # gold bead between the enamel ring and the cobbles
    lathe(gold, [(0.1405, BASE_TOP), (0.1405, BASE_TOP + 0.0012), (0.1385, BASE_TOP + 0.0022),
                 (0.1360, BASE_TOP + 0.0012), (0.1360, BASE_TOP - 0.002)], n, GOLD)
    # mortar floor + cobbles: a round centre stone and two rings of setts
    mort = f("base_mortar", MORTAR, MATTE, "hard")
    lathe(mort, [(0.1362, BASE_TOP - 0.002), (0.0, BASE_TOP - 0.002)], n, MORTAR)
    cob = f("base_cobbles", COBBLE, MATTE, "hard")

    def stone(poly, y0, y1, col, inset=0.0016):
        cx = sum(x for x, _ in poly) / len(poly)
        cz = sum(z for _, z in poly) / len(poly)

        def pull(x, z):
            d = max(1e-4, math.hypot(x - cx, z - cz))
            return cx + (x - cx) * (1 - inset / d), cz + (z - cz) * (1 - inset / d)
        top = [pull(x, z) for x, z in poly]
        A = [cob.vert((x, y0, z)) for x, z in poly]
        B = [cob.vert((x, y1 - 0.0012, z)) for x, z in poly]
        C = [cob.vert((x, y1, z)) for x, z in top]
        cen = (cx, (y0 + y1) / 2, cz)
        m = len(poly)
        for k in range(m):
            k2 = (k + 1) % m
            cob.face([A[k], A[k2], B[k2], B[k]], col, outward=cen)
            cob.face([B[k], B[k2], C[k2], C[k]], col, outward=cen)
        cob.face(C, col, outward=(cx, y0, cz))

    def sett(a0, a1, r0, r1, gap=0.0024):
        h = BASE_TOP - 0.002 + 0.0035 + rng.uniform(-0.0006, 0.0010)
        tone = rng.uniform(0.70, 1.20)
        col = (COBBLE[0] * tone, COBBLE[1] * tone, COBBLE[2] * tone * rng.uniform(0.92, 1.05))
        ga0, ga1 = a0 + gap / max(r0, 0.02), a1 - gap / max(r0, 0.02)
        steps = max(2, int((a1 - a0) * r1 / 0.014))
        outer = [((r1 - gap) * math.cos(ga0 + (ga1 - ga0) * i / steps), (r1 - gap) * math.sin(ga0 + (ga1 - ga0) * i / steps))
                 for i in range(steps + 1)]
        inner = [((r0 + gap) * math.cos(ga1 - (ga1 - ga0) * i / steps), (r0 + gap) * math.sin(ga1 - (ga1 - ga0) * i / steps))
                 for i in range(steps + 1)]
        stone(outer + inner, BASE_TOP - 0.002, h, col)

    stone([(0.034 * math.cos(2 * math.pi * i / 10), 0.034 * math.sin(2 * math.pi * i / 10)) for i in range(10)],
          BASE_TOP - 0.002, BASE_TOP + 0.0018, COBBLE)
    off = rng.uniform(0, 1)
    for i in range(8):
        sett(2 * math.pi * (i + off) / 8, 2 * math.pi * (i + 1 + off) / 8, 0.0365, 0.0860)
    off = rng.uniform(0, 1)
    for i in range(13):
        sett(2 * math.pi * (i + off) / 13, 2 * math.pi * (i + 1 + off) / 13, 0.0860, 0.1360)


# --- weapons & props ----------------------------------------------------------------

def sword(f, M, length=0.15, width=0.0135, blade_rgb=BRIGHT_STEEL, guard_rgb=GOLD, grip_rgb=DARK_LEATHER,
          guard_w=0.046, curve=0.0, grip_len=0.024, keys=("blade", "hilt", "grip")):
    """A blade along local +y from the fist at the origin; curve bends it
    toward local +x (a sabre or a curved dagger)."""
    bl = f(keys[0], blade_rgb, METAL, "hard")
    hi = f(keys[1], guard_rgb, METAL, "hard")
    gr = f(keys[2], grip_rgb, SATIN, "hard")
    w, th = width / 2, width * 0.14

    def sec(y, k=1.0):
        dx = curve * (y / length) ** 2
        return [(dx - w * k, 0), (dx, th), (dx + w * k, 0), (dx, -th)]
    tip = curve * 1.0
    loft(bl, [(0.010, sec(0.010, 0.9)), (0.016, sec(0.016)), (length * 0.45, sec(length * 0.45, 0.98)),
              (length * 0.80, sec(length * 0.80, 0.88)), (length, [(tip + w * 0.4, 0.0)])], M=M)
    box(hi, (0, 0.0065, 0), (guard_w, 0.0060, 0.0085), b=0.0018, M=M)
    for sx in (-1, 1):
        tube(hi, [M @ V(sx * guard_w / 2, 0.0065, 0), M @ V(sx * (guard_w / 2 + 0.004), 0.011, 0)], [0.0034, 0.0020])
    ball(hi, (0, 0.0108, 0), 0.0042, scale=(1.0, 0.7, 0.8), M=M)
    tube(gr, [M @ V(0, -grip_len, 0), M @ V(0, 0.004, 0)], [0.0043, 0.0045], n=10)
    ball(hi, (0, -grip_len - 0.0045, 0), 0.0062, M=M, n=12, rings=8)


def staff(f, key, bottom, top, rgb=DARK_WOOD, r=0.0058, gnarl=0.0):
    p = f(key, rgb, SATIN, "hard")
    a, b = V(bottom), V(top)
    k = 8
    pts = []
    for i in range(k + 1):
        q = lerp(a, b, i / k)
        if 0 < i < k and gnarl:
            q += V(math.sin(i * 2.1) * gnarl, 0, math.cos(i * 1.7) * gnarl)
        pts.append(q)
    tube(p, pts, [r * 0.85] + [r * (1.0 + (0.22 if (gnarl and i % 2) else 0)) for i in range(1, k)] + [r], n=10)
    return p


def crystal(p, c, h, r, M=None, sides=6, tilt=(0.0, 0.0)):
    Mx = (M or Matrix.Identity(4)) @ T(c) @ rot_x(tilt[0]) @ rot_z(tilt[1])
    lathe(p, [(0.0, -h * 0.30), (r, -h * 0.05), (r * 0.92, h * 0.45), (0.0, h * 0.70)], sides, p.rgb, M=Mx)


def flame(p, c, size, count=5, seed=0):
    """Licking fire / magic: a cluster of flame tongues rising from c."""
    rng = random.Random(seed)
    c = V(c)
    ball(p, c, size * 0.55, n=12, rings=8)
    for k in range(count):
        a = 2 * math.pi * k / count + rng.uniform(-0.3, 0.3)
        rr = size * rng.uniform(0.25, 0.50)
        b = c + V(rr * math.cos(a), size * 0.1, rr * math.sin(a))
        h = size * rng.uniform(1.3, 2.3)
        tube(p, [b, b + V(rr * 0.2 * math.cos(a + 1), h * 0.5, rr * 0.2 * math.sin(a + 1)),
                 b + V(-rr * 0.3 * math.cos(a), h, -rr * 0.3 * math.sin(a))], [size * 0.32, size * 0.20, 0.0], n=8)


def longbow(f, grip, up, toward, *, height=0.24, bend=0.022, anchor=None, rgb=WOOD, key="bow"):
    """A recurve longbow in the plane of `up` and `toward` (from the grip to
    the string side). anchor: where the drawn string is pulled to."""
    p = f(key, rgb, SATIN, "hard")
    up = V(up).normalized()
    dr = V(toward) - up * V(toward).dot(up)
    dr.normalize()
    pts, radii = [], []
    N = 16
    for i in range(N + 1):
        u = -1 + 2 * i / N
        off = bend * u * u - 0.012 * max(0.0, abs(u) - 0.78) / 0.22
        pts.append(V(grip) + up * (u * height / 2) + dr * off)
        radii.append(0.0052 - 0.0032 * abs(u) ** 1.2)
    tube(p, pts, radii, n=8)
    tube(f(key + "_grip", LEATHER, SATIN, "hard"), [V(grip) - up * 0.011, V(grip) + up * 0.011], 0.0060, n=10)
    s = f(key + "_string", STRING, MATTE, "hard")
    top, bot = pts[-1] + dr * 0.002, pts[0] + dr * 0.002
    if anchor is not None:
        tube(s, [top, V(anchor)], 0.0010, n=5)
        tube(s, [V(anchor), bot], 0.0010, n=5)
    else:
        tube(s, [top, bot], 0.0010, n=5)
    return top, bot


def arrow(f, nock, head_at, *, fletch=(0.60, 0.06, 0.04), key="arrow"):
    p = f(key, WOOD, SATIN, "hard")
    a, b = V(nock), V(head_at)
    d = (b - a).normalized()
    tube(p, [a, b], 0.0012, n=6)
    hd = f(key + "_head", STEEL, METAL, "hard")
    lathe(hd, [(0.0, 0.0), (0.0032, 0.003), (0.0, 0.013)], 4, STEEL, M=frame(b, d))
    fl = f(key + "_fletch", fletch, MATTE, "hard")
    for k in range(3):
        M = frame(a + d * 0.012, d, (math.cos(2 * math.pi * k / 3), 0.3, math.sin(2 * math.pi * k / 3)))
        box(fl, (0.0032, 0, 0), (0.0055, 0.022, 0.0008), M=M)


def quiver(f, bottom, top, r=0.0105, fletch=(0.60, 0.06, 0.04)):
    q = f("quiver", LEATHER, SATIN)
    tube(q, [bottom, top], [r * 0.9, r])
    ring(f("quiver_rim", GOLD, METAL, "hard"), top, r * 1.05, 0.0018, n=16, y_dir=V(top) - V(bottom))
    d = (V(top) - V(bottom)).normalized()
    side = d.cross(V(0, 0, 1)).normalized()
    for k, off in enumerate((-0.5, 0.0, 0.5, 0.15)):
        base_ = V(top) + side * off * r * 0.9 + V(0, 0, (k - 1.5) * 0.002)
        arrow(f, base_ + d * 0.032, base_ - d * 0.010, fletch=fletch, key="quiver_arrow")


def skull(bone, c, s, *, glow=None, M=None, yaw=0.0):
    """A skull of size s at c (bone part); glow: colour for the eye sockets."""
    Mx = (M or Matrix.Identity(4)) @ T(c) @ rot_y(yaw)
    ball(bone, (0, 0.10 * s, -0.05 * s), s, scale=(0.88, 0.92, 1.0), M=Mx, n=16, rings=10)
    box(bone, (0, -0.62 * s, 0.30 * s), (s * 1.05, s * 0.55, s * 0.95), b=s * 0.2, M=Mx)
    for sx in (-1, 1):
        ball(bone, (sx * 0.48 * s, -0.20 * s, 0.55 * s), s * 0.30, M=Mx)
    if glow:
        for sx in (-1, 1):
            ball(glow, (sx * 0.34 * s, -0.02 * s, 0.82 * s), s * 0.24, scale=(1.0, 0.85, 0.6), M=Mx, n=10, rings=6)


def axe_bit(p, M, flip=1.0, reach=0.050, half=0.036):
    """One crescent axe blade along local +y (out from the haft), haft along
    local x, thickness along z. flip=-1 for the far side."""
    secs = []
    for y, hv, th in ((0.004, 0.015, 0.0050), (0.018, 0.019, 0.0038), (0.032, 0.027, 0.0024),
                      (0.044, half, 0.0011), (reach, half * 0.80, 0.0004)):
        secs.append((y, [(-hv, 0), (0, th), (hv, 0), (0, -th)]))
    loft(p, secs, M=M @ S(1, flip, 1))


def lute(f, M):
    """Lute in its own frame: local y along the neck toward the pegbox, local
    z out of the soundboard."""
    bowl = f("lute", (0.40, 0.17, 0.05), GLOSS, "hard")
    ball(bowl, (0, 0, -0.004), 0.034, scale=(1.0, 1.30, 0.62), M=M, n=20, rings=12,
         skip=lambda k, s, t: False)
    board = f("lute_board", (0.62, 0.40, 0.17), SATIN, "hard")
    lathe(board, [(0.0, 0.0), (0.0338, 0.0)], 28, board.rgb, M=M @ T((0, 0, 0.0115)) @ rot_x(math.pi / 2) @ S(1, 1, 1.30))
    dark = f("lute_dark", (0.03, 0.02, 0.015), MATTE, "hard")
    ring(dark, (0, 0.010, 0.0120), 0.0085, 0.0011, M=M, n=18, y_dir=(0, 0, 1))
    lathe(dark, [(0.0, 0.0), (0.0072, 0.0)], 16, dark.rgb, M=M @ T((0, 0.010, 0.0118)) @ rot_x(math.pi / 2))
    neck = f("lute_neck", (0.10, 0.05, 0.02), SATIN, "hard")
    box(neck, (0, 0.074, 0.006), (0.0105, 0.070, 0.0062), b=0.0015, M=M)
    box(neck, (0, 0.116, 0.000), (0.0125, 0.024, 0.0060), b=0.0015, M=M @ T((0, 0.108, 0.004)) @ rot_x(-0.55) @ T((0, -0.108, -0.004)))
    box(f("lute_gold", GOLD, METAL, "hard"), (0, -0.026, 0.0125), (0.012, 0.004, 0.0015), M=M)


def wolf(f, c, yaw=0.0, k=1.0):
    """The hunter's wolf, sitting, local frame at c facing +z turned by yaw,
    k times life size (for a mini)."""
    GREY, LIGHT = (0.17, 0.165, 0.16), (0.40, 0.38, 0.35)
    fur = f("wolf", GREY, MATTE)
    chest = f("wolf_chest", LIGHT, MATTE)
    M = T(c) @ rot_y(yaw) @ S(k, k, k)
    ball(fur, (0, 0.024, -0.014), 0.024, scale=(1.0, 0.92, 1.12), M=M)                       # haunches
    for sx in (-1, 1):
        ball(fur, (sx * 0.016, 0.006, 0.006), 0.0085, scale=(0.8, 0.55, 1.45), M=M)          # hind paws
        ball(fur, (sx * 0.017, 0.020, -0.010), 0.014, scale=(0.75, 1.0, 1.1), M=M)           # thighs
    tube(fur, [M @ V(0, 0.026, -0.012), M @ V(0, 0.056, 0.008)], [0.020, 0.015])
    ball(chest, (0, 0.054, 0.014), 0.0155, scale=(1.0, 1.25, 0.9), M=M)
    for sx in (-1, 1):
        tube(fur, [M @ V(sx * 0.009, 0.050, 0.016), M @ V(sx * 0.010, 0.026, 0.020), M @ V(sx * 0.010, 0.005, 0.022)],
             [0.0062, 0.0052, 0.0050])
        ball(fur, (sx * 0.010, 0.004, 0.026), 0.0062, scale=(0.9, 0.55, 1.3), M=M)
    tube(fur, [M @ V(0, 0.058, 0.010), M @ V(0, 0.076, 0.020)], [0.012, 0.010])                  # neck
    ball(fur, (0, 0.082, 0.022), 0.0142, scale=(0.92, 0.88, 1.02), M=M)
    tube(fur, [M @ V(0, 0.079, 0.030), M @ V(0, 0.075, 0.050)], [0.0080, 0.0046])               # snout
    ball(chest, (0, 0.074, 0.030), 0.0075, scale=(1.0, 0.7, 1.2), M=M)                          # muzzle
    for sx in (-1, 1):
        tube(fur, [M @ V(sx * 0.0075, 0.091, 0.017), M @ V(sx * 0.0095, 0.106, 0.012)], [0.0052, 0.0], n=8)
    tube(fur, [M @ V(0, 0.014, -0.032), M @ V(0.016, 0.006, -0.026), M @ V(0.026, 0.005, -0.006),
               M @ V(0.026, 0.006, 0.012)], [0.0072, 0.0068, 0.0055, 0.0025])
    ball(f("wolf_nose", (0.02, 0.02, 0.02), GLOSS, "hard"), M @ V(0, 0.0765, 0.0505), 0.0030 * k, n=8, rings=5)
    for sx in (-1, 1):
        ball(f("wolf_eyes", (0.95, 0.62, 0.12), GLOW, "hard"), M @ V(sx * 0.0064, 0.0855, 0.0330), 0.0021 * k, n=8,
             rings=5)


# --- the classes ----------------------------------------------------------------------

def archer(f):
    """Red-haired ranger in a forest-green hood and cloak, drawing her longbow."""
    TUNIC, CLOAK, HOOD = (0.07, 0.30, 0.07), (0.030, 0.13, 0.040), (0.040, 0.17, 0.050)
    HAIR, PANTS = (0.55, 0.11, 0.025), (0.10, 0.08, 0.05)
    f("leather", LEATHER, SATIN)
    f("pants", PANTS, MATTE)
    f("boots", DARK_LEATHER, SATIN)
    yaw = -0.30                                   # left shoulder turned toward the target
    Ry = rot_y(yaw)
    leg(f, 1, (0.040, ANK, 0.024), knee=(0.036, KNEE, 0.026), legs="pants", toe_yaw=0.75, boot_h=0.044)
    leg(f, -1, (-0.036, ANK, -0.012), knee=(-0.030, KNEE, 0.000), legs="pants", toe_yaw=-0.25, boot_h=0.044)
    body = f("bodice", LEATHER, SATIN)
    torso(body, wide=0.94, fem=True, M=Ry)
    drape(f("tunic", TUNIC, MATTE, "sheet", 0.004), WAIST + 0.004, KNEE + 0.012, 0.031, 0.044, folds=7, amp=0.07,
          sx=1.18, sz=0.92, M=Ry)
    ring(f("belt", DARK_LEATHER, SATIN), (0, WAIST + 0.002, 0), 0.0315, 0.0026, M=Ry @ S(1.18, 1, 0.82))
    box(f("belt_gold", GOLD, METAL, "hard"), Ry @ V(0, WAIST + 0.002, 0.026), (0.008, 0.007, 0.004), b=0.0015)
    # cloak behind, swept by the wind
    drape(f("cloak", CLOAK, MATTE, "sheet", 0.004), SHO + 0.004, Y0 + 0.030, 0.038, 0.072, folds=7, amp=0.12,
          flow=0.028, skip=front_open(70), sx=1.12, sz=0.85, M=Ry @ T((0, 0, -0.006)))
    # hooded capelet
    drape(f("capelet", HOOD, MATTE, "sheet", 0.004), NECK + 0.002, SHO - 0.034, 0.026, 0.056, folds=6, amp=0.08,
          sx=1.12, sz=0.90, rings=4, M=Ry)
    hc = V(0.004, HEAD, 0.004)
    M = head(f, hc, r=HR * 0.96, skin=SKIN_FAIR, fem=True, iris=(0.06, 0.22, 0.05), brow=HAIR, lips=LIPS, yaw=0.45,
             pitch=0.04)
    hp = f("hair", HAIR, SATIN, "sheet", 0.005)
    hair_cap(hp, M, r=HR * 0.96, front=0.76, back=0.20, sides=0.40, puff=1.08)
    locks = f("locks", HAIR, SATIN)
    bangs(locks, M, HR * 0.96, side=1)
    for sx in (-1, 1):   # red locks spilling out of the hood
        top = M @ V(sx * HR * 0.78, -0.05 * HR, 0.30 * HR)
        lock(locks, [top, top + V(sx * 0.004, -0.024, 0.010), top + V(sx * 0.006, -0.048, 0.016),
                     top + V(sx * 0.002, -0.068, 0.016)], 0.0078)
    hood = f("hood", HOOD, MATTE, "sheet", 0.0045)
    ball(hood, (0, 0.12 * HR, -0.12 * HR), HR * 1.30, scale=(0.96, 1.04, 1.06), M=M, n=22, rings=12,
         skip=lambda k, s, t: k < 3 or (math.sin(t) > 0.42 and k < 9))
    tube(hood, [M @ V(0, HR * 1.22, -HR * 0.55), M @ V(0, HR * 1.0, -HR * 1.35), M @ V(0, HR * 0.45, -HR * 1.6)],
         [HR * 0.42, HR * 0.28, 0.0])
    # quiver on the back, over the right shoulder
    quiver(f, Ry @ V(0.020, WAIST - 0.010, -0.040), Ry @ V(-0.026, SHO + 0.030, -0.046))
    # bow arm out toward the target, draw hand at the cheek
    sh_l, sh_r = Ry @ shoulder(1, 0.94), Ry @ shoulder(-1, 0.94)
    aim_dir = V(0.58, 0.04, 0.81).normalized()
    el_l, wr_l = sh_l + aim_dir * 0.044, sh_l + aim_dir * 0.083
    anchor = M @ V(-0.55 * HR, -0.42 * HR, 0.55 * HR)
    grip = arm(f, 1, el_l, wr_l, sh=sh_l, sleeve="bodice", hands="skin", fist=0.0105, up=0.0118, fore=0.0098,
               grip=(0, 1, 0))
    tube(f("bracers", DARK_LEATHER, SATIN), [lerp(el_l, wr_l, 0.35), wr_l], [0.0108, 0.0098])
    el_r = sh_r + V(-0.030, 0.004, -0.026)
    arm(f, -1, el_r, anchor + V(-0.008, -0.004, -0.004), sh=sh_r, sleeve="bodice", hands="skin", fist=0.0100,
        up=0.0118, fore=0.0098, grip=(0, 0, 1))
    tube(f("bracers"), [lerp(el_r, anchor, 0.35), lerp(el_r, anchor, 0.85)], [0.0108, 0.0098])
    draw = (anchor - grip).normalized()
    longbow(f, grip, (0.0, 1.0, 0.0), draw, height=0.25, bend=0.026, anchor=anchor)
    arrow(f, anchor, grip - draw * 0.022)


def mage(f):
    """Dark-haired sorceress in violet and gold, crystal staff and arcane orb."""
    ROBE, COAT, HAIR = (0.22, 0.05, 0.46), (0.060, 0.020, 0.11), (0.022, 0.012, 0.030)
    ARC = (0.62, 0.30, 1.0)
    robe = f("robe", ROBE, SATIN, "sheet", 0.0045)
    gold = f("gold", GOLD, METAL)
    drape(robe, WAIST + 0.004, Y0 + 0.001, 0.031, 0.070, folds=9, amp=0.10, front_rise=0.004, sx=1.05, sz=0.95)
    drape(f("hem", GOLD, METAL, "sheet", 0.0045), Y0 + 0.013, Y0 + 0.0005, 0.0650, 0.0714, folds=9, amp=0.088,
          rings=2, sx=1.05, sz=0.95)
    drape(f("coat", COAT, SATIN, "sheet", 0.004), SHO + 0.002, Y0 + 0.004, 0.038, 0.080, folds=8, amp=0.11,
          back_drop=0.006, flow=0.010, skip=front_open(38), sx=1.12, sz=0.92, fold_phase=2.0)
    body = f("bodice", ROBE, SATIN)
    torso(body, wide=0.95, fem=True)
    tube(gold, [(0, WAIST + 0.002, 0.026), (0, CHEST - 0.010, 0.0305), (0, CHEST + 0.010, 0.031)], 0.0018, n=8)
    ring(gold, (0, WAIST + 0.002, 0), 0.0300, 0.0026, M=S(1.18, 1, 0.80))
    for sx in (-1, 1):   # gold filigree down the coat fronts
        tube(gold, [(sx * 0.024, SHO - 0.004, 0.030), (sx * 0.034, WAIST, 0.036), (sx * 0.054, Y0 + 0.030, 0.058)],
             0.0016, n=6)
    revolve(f("collar", COAT, SATIN, "sheet", 0.0035),
            [(0.030, SHO + 0.000), (0.034, SHO + 0.018), (0.047, HEAD + 0.012)], 28,
            skip=front_open(70), M=S(1.15, 1, 0.95))
    M = head(f, (0, HEAD - 0.001, 0.003), r=HR * 0.96, skin=SKIN_PALE, fem=True, iris=(0.30, 0.10, 0.55),
             brow=HAIR, lips=(0.40, 0.08, 0.20), yaw=-0.12)
    hp = f("hair", HAIR, SATIN, "sheet", 0.005)
    hair_cap(hp, M, r=HR * 0.96, front=0.78, back=0.10, sides=0.30, puff=1.10)
    locks = f("locks", HAIR, SATIN)
    long_hair(locks, M, HR * 0.96, length=0.096, count=7, wave=0.005)
    bangs(locks, M, HR * 0.96, side=-1)
    ring(gold, (0, 0.30 * HR, 0.0), HR * 0.97, 0.0016, M=M @ rot_x(-0.25))           # circlet
    ball(f("gem", ARC, GLOW, "hard"), M @ V(0, 0.44 * HR, 0.99 * HR), 0.0036, n=8, rings=6)
    # staff in the right hand, planted by the foot
    sleeves = f("sleeves", ROBE, SATIN)
    st_bottom, st_top = V(-0.080, Y0 + 0.002, 0.034), V(-0.084, Y0 + 0.300, 0.044)
    el, wr = V(-0.066, SHO - 0.040, 0.010), V(-0.078, SHO - 0.050, 0.034)
    arm(f, -1, el, wr, fist=0.0108, wide=0.92, grip=st_top - st_bottom, hands="skin")
    bell_sleeve(sleeves, el, wr)
    staff(f, "staff", st_bottom, st_top, DARK_WOOD, r=0.0055)
    sg = f("staff_gold", GOLD, METAL, "hard")
    for k in range(4):
        a = k * math.pi / 2 + 0.4
        tube(sg, [st_top + V(0.004 * math.cos(a), -0.004, 0.004 * math.sin(a)),
                  st_top + V(0.015 * math.cos(a), 0.016, 0.015 * math.sin(a)),
                  st_top + V(0.006 * math.cos(a), 0.036, 0.006 * math.sin(a))], [0.0026, 0.0022, 0.0], n=6)
    ring(sg, st_top + V(0, -0.002, 0), 0.0068, 0.0024, n=16)
    cr = f("crystal", ARC, GLOW, "hard")
    crystal(cr, st_top + V(0, 0.022, 0), 0.042, 0.0115)
    crystal(cr, st_top + V(0.008, 0.012, 0.004), 0.018, 0.0050, tilt=(0.3, -0.5))
    crystal(cr, st_top + V(-0.007, 0.010, -0.003), 0.016, 0.0045, tilt=(-0.3, 0.6))
    # left hand raised, an orb of arcane light over the palm
    el, wr = V(0.070, SHO - 0.030, 0.024), V(0.066, SHO - 0.004, 0.058)
    hc = arm(f, 1, el, wr, fist=0.0105, wide=0.92, open_hand=True, grip=(0, 0.3, 1), hands="skin")
    bell_sleeve(sleeves, el, wr)
    orb = f("orb", ARC, GLOW, "hard")
    ball(orb, hc + V(0.002, 0.026, 0.006), 0.0125, n=16, rings=10)
    for k in range(3):
        a = 2 * math.pi * k / 3 + 0.5
        crystal(orb, hc + V(0.024 * math.cos(a), 0.026 + 0.010 * math.sin(a * 2), 0.024 * math.sin(a)), 0.011, 0.0032)


def warrior(f):
    """Dark-haired knight in blue and gold plate, round shield and longsword."""
    PLATE, UNDER, CAPE, HAIR = (0.13, 0.24, 0.66), (0.10, 0.10, 0.12), (0.025, 0.035, 0.13), (0.045, 0.028, 0.018)
    plate = f("plate", PLATE, METAL)
    gold = f("gold", GOLD, METAL)
    under = f("under", UNDER, SATIN)
    legs_ = ((1, (0.028, KNEE, 0.026), (0.032, ANK, 0.026), 0.30), (-1, (-0.028, KNEE + 0.002, 0.004), (-0.034, ANK, -0.012), -0.55))
    for side, kn, an, ty in legs_:
        leg(f, side, an, knee=kn, legs="under", boots="plate", toe_yaw=ty, boot_h=0.046, boot_r=0.0140)
        hip = V(side * 0.019, HIP, 0)
        tube(plate, [lerp(hip, kn, 0.12), lerp(hip, kn, 0.86)], [0.0182, 0.0140])      # cuisses
        ball(gold, kn, 0.0122, scale=(1.05, 1.0, 1.15))                               # poleyns
        tube(plate, [lerp(kn, an, 0.15), lerp(kn, an, 0.9)], [0.0140, 0.0128])          # greaves
    torso(under, wide=1.08)
    torso(plate, wide=1.08, grow=0.0045, bottom=WAIST - 0.006)                         # breastplate
    tube(gold, [(0, WAIST + 0.004, 0.0300), (0, CHEST + 0.008, 0.0345), (0, SHO - 0.002, 0.026)], 0.0022, n=8)
    for sx in (-1, 1):
        tube(gold, [(sx * 0.010, SHO + 0.004, 0.024), (sx * 0.030, SHO - 0.008, 0.030), (sx * 0.044, SHO - 0.024, 0.026)],
             0.0018, n=6)
    drape(f("tassets", PLATE, METAL, "sheet", 0.004), WAIST + 0.004, HIP - 0.030, 0.034, 0.042, folds=6, amp=0.05,
          sx=1.25, sz=0.92, front_rise=0.006)
    ring(gold, (0, WAIST + 0.001, 0), 0.0338, 0.0030, M=S(1.25, 1, 0.92))               # gold belt
    box(gold, (0, WAIST + 0.001, 0.031), (0.012, 0.010, 0.006), b=0.002)
    for sx in (-1, 1):                                                                 # pauldrons
        ball(plate, (sx * 0.054, SHO + 0.005, -0.002), 0.0225, scale=(1.10, 0.74, 1.10))
        ball(plate, (sx * 0.060, SHO - 0.008, 0.0), 0.0195, scale=(1.05, 0.50, 1.05))
        ball(plate, (sx * 0.064, SHO - 0.018, 0.001), 0.0170, scale=(1.0, 0.42, 1.0))
        ring(gold, (sx * 0.055, SHO + 0.000, -0.002), 0.0230, 0.0021, n=28, y_dir=(sx * 0.35, 1, 0))
    tube(under, [(0, NECK - 0.008, 0), (0, NECK + 0.006, 0.002)], [0.0150, 0.0130])     # gorget
    drape(f("cape", CAPE, SATIN, "sheet", 0.004), SHO + 0.006, Y0 + 0.016, 0.040, 0.078, folds=7, amp=0.12,
          back_drop=0.008, flow=0.024, skip=front_open(62), sx=1.15, sz=0.85, M=T((0, 0, -0.008)))
    M = head(f, (0, HEAD, 0.004), yaw=0.18, iris=(0.08, 0.14, 0.30), brow=HAIR)
    hair_cap(f("hair", HAIR, SATIN, "sheet", 0.0045), M, front=0.74, back=0.30, sides=0.48, puff=1.07)
    locks = f("locks", HAIR, SATIN)
    for k in range(3):   # a tousled crown
        x0 = (k - 1) * 0.32 * HR
        lock(locks, [M @ V(x0, 1.00 * HR, -0.10 * HR), M @ V(x0 + 0.15 * HR, 1.08 * HR, 0.40 * HR),
                     M @ V(x0 + 0.30 * HR, 0.86 * HR, 0.78 * HR)], HR * 0.24, HR * 0.08, n=8)
    beard = f("beard", HAIR, SATIN, "sheet", 0.003)
    ball(beard, (0, -0.40 * HR, 0.22 * HR), HR * 0.72, scale=(0.92, 0.84, 0.97), M=M, n=18, rings=10,
         skip=lambda k, s, t: k > 4 or (math.sin(t) < -0.2))
    # shield arm: round shield strapped to the left forearm
    el, wr = V(0.072, SHO - 0.042, 0.010), V(0.056, SHO - 0.058, 0.046)
    arm(f, 1, el, wr, sleeve="under", hands="plate", up=0.0136, wide=1.08)
    tube(plate, [el, wr], [0.0128, 0.0118])                                            # vambrace
    nrm = V(0.42, 0.10, 0.90).normalized()
    Ms = frame(V(0.064, SHO - 0.050, 0.030) + nrm * 0.016, nrm, (0, 1, 0))
    sh_face = f("shield", PLATE, METAL, "hard")
    sh_gold = f("shield_gold", GOLD, METAL, "hard")
    Rs = 0.056
    lathe(sh_face, [(0.0, 0.0115), (Rs * 0.45, 0.0095), (Rs * 0.85, 0.0045), (Rs, 0.0), (Rs * 0.96, -0.004),
                    (0.0, -0.002)], 40, PLATE, M=Ms)
    ring(sh_gold, (0, 0.0002, 0), Rs, 0.0034, M=Ms, n=40)
    ring(sh_gold, (0, 0.0072, 0), Rs * 0.60, 0.0018, M=Ms, n=32)
    ball(sh_gold, (0, 0.0112, 0), 0.0105, scale=(1, 0.55, 1), M=Ms)
    for k in range(8):
        a = 2 * math.pi * k / 8
        ball(sh_gold, (Rs * 0.80 * math.cos(a), 0.0055, Rs * 0.80 * math.sin(a)), 0.0026, M=Ms, n=8, rings=5)
    # sword arm: the blade up at the right side
    bd = V(-0.26, 0.93, 0.26).normalized()
    el, wr = V(-0.072, SHO - 0.040, 0.004), V(-0.068, SHO - 0.060, 0.030)
    hc = arm(f, -1, el, wr, sleeve="under", hands="plate", up=0.0136, wide=1.08, grip=bd)
    tube(plate, [el, wr], [0.0128, 0.0118])
    sword(f, frame(hc, bd, (0.3, 0.1, -1.0)), length=0.168, width=0.0165, guard_w=0.050)


def necromancer(f):
    """Pale lord of the dead in black and crimson, a skull-crowned staff, red
    soulfire in his claw."""
    ROBE, CRIMSON, HAIR = (0.030, 0.024, 0.032), (0.44, 0.025, 0.04), (0.018, 0.014, 0.020)
    SOUL = (1.0, 0.14, 0.07)
    drape(f("robe", ROBE, SATIN, "sheet", 0.0045), WAIST + 0.004, Y0 + 0.001, 0.032, 0.072, folds=8, amp=0.11,
          jag=0.004, sx=1.06, sz=0.95)
    drape(f("tabard", CRIMSON, SATIN, "sheet", 0.004), WAIST + 0.006, Y0 + 0.006, 0.0345, 0.074, folds=4, amp=0.04,
          skip=front_only(28), sx=1.06, sz=0.98)
    drape(f("coat", ROBE, SATIN, "sheet", 0.004), SHO + 0.004, Y0 + 0.002, 0.040, 0.084, folds=8, amp=0.12,
          back_drop=0.006, flow=0.016, jag=0.006, skip=front_open(42), sx=1.14, sz=0.92)
    torso(f("body", ROBE, SATIN), wide=1.0)
    torso(f("vest", CRIMSON, SATIN), wide=1.0, grow=0.002, top=CHEST + 0.004, bottom=WAIST - 0.004)
    bone = f("bone", BONE, SATIN)
    ring(bone, (0, WAIST + 0.002, 0), 0.0320, 0.0030, M=S(1.24, 1, 0.82))
    glow = f("soul", SOUL, GLOW, "hard")
    skull(bone, (0, WAIST - 0.004, 0.032), 0.0072, glow=glow)
    revolve(f("collar", ROBE, SATIN, "sheet", 0.0035),
            [(0.030, SHO + 0.000), (0.036, SHO + 0.018), (0.052, HEAD + 0.016)], 28,
            skip=front_open(64), M=S(1.18, 1, 0.98))
    for sx in (-1, 1):   # bone spikes over the shoulders
        ball(f("pauldron", (0.06, 0.05, 0.06), SATIN), (sx * 0.054, SHO + 0.004, -0.002), 0.024, scale=(1.1, 0.75, 1.1))
        for k in range(3):
            b = V(sx * (0.046 + 0.010 * k), SHO + 0.012, -0.010 + 0.010 * k)
            tube(bone, [b, b + V(sx * 0.010, 0.030 - 0.006 * k, -0.006)], [0.0042, 0.0], n=8)
    M = head(f, (0, HEAD, 0.004), skin=(0.60, 0.52, 0.52), glow_eyes=SOUL, brow=HAIR, yaw=0.10, pitch=0.06)
    hair_cap(f("hair", HAIR, SATIN, "sheet", 0.005), M, front=0.80, back=0.12, sides=0.34, puff=1.09)
    long_hair(f("locks", HAIR, SATIN), M, length=0.080, count=6, wave=0.003, thick=0.0098)
    # skull staff in the right hand
    sleeves = f("sleeves", ROBE, SATIN)
    st_bottom, st_top = V(-0.082, Y0 + 0.002, 0.036), V(-0.086, Y0 + 0.290, 0.044)
    el, wr = V(-0.068, SHO - 0.040, 0.012), V(-0.080, SHO - 0.050, 0.036)
    arm(f, -1, el, wr, fist=0.0108, grip=st_top - st_bottom, hands="skin")
    bell_sleeve(sleeves, el, wr, 0.0120, 0.0185)
    staff(f, "staff", st_bottom, st_top, (0.05, 0.035, 0.03), r=0.0056, gnarl=0.0022)
    skull(bone, st_top + V(0, 0.020, 0.002), 0.0150, glow=glow)
    for k in range(4):   # bone claws cradling it
        a = k * math.pi / 2 + 0.6
        tube(bone, [st_top + V(0.004 * math.cos(a), -0.004, 0.004 * math.sin(a)),
                    st_top + V(0.017 * math.cos(a), 0.010, 0.017 * math.sin(a)),
                    st_top + V(0.012 * math.cos(a), 0.026, 0.012 * math.sin(a))], [0.0030, 0.0024, 0.0], n=6)
    # left claw raised, soulfire swirling over it
    el, wr = V(0.070, SHO - 0.032, 0.022), V(0.068, SHO - 0.020, 0.058)
    hc = arm(f, 1, el, wr, fist=0.0105, open_hand=True, grip=(0, 0.4, 1), hands="skin")
    bell_sleeve(sleeves, el, wr, 0.0120, 0.0185)
    flame(glow, hc + V(0, 0.014, 0.004), 0.010, count=5, seed=3)
    for k in range(3):
        a = 2 * math.pi * k / 3
        ball(glow, hc + V(0.026 * math.cos(a), 0.034 + 0.012 * k, 0.026 * math.sin(a)), 0.0036, n=8, rings=5)


def cleric(f):
    """Golden-haired priestess in white and gold, sun staff and holy light."""
    WHITE, IVORY, HAIR = (0.80, 0.77, 0.70), (0.66, 0.60, 0.50), (0.72, 0.48, 0.15)
    LIGHT = (1.0, 0.80, 0.42)
    drape(f("robe", WHITE, SATIN, "sheet", 0.0045), WAIST + 0.004, Y0 + 0.001, 0.031, 0.070, folds=9, amp=0.09,
          front_rise=0.004, sx=1.05, sz=0.95)
    drape(f("hem", GOLD, METAL, "sheet", 0.0045), Y0 + 0.012, Y0 + 0.0005, 0.0652, 0.0712, folds=9, amp=0.080,
          rings=2, sx=1.05, sz=0.95)
    drape(f("mantle", IVORY, SATIN, "sheet", 0.004), SHO + 0.004, Y0 + 0.010, 0.040, 0.078, folds=8, amp=0.10,
          flow=0.018, skip=front_open(60), sx=1.12, sz=0.88, fold_phase=1.4)
    gold = f("gold", GOLD, METAL)
    torso(f("body", WHITE, SATIN), wide=0.95, fem=True)
    torso(gold, wide=0.95, fem=True, grow=0.0025, top=CHEST + 0.010, bottom=WAIST - 0.006)   # gilded corset
    ring(gold, (0, WAIST + 0.002, 0), 0.0302, 0.0028, M=S(1.18, 1, 0.80))
    tube(gold, [(0, WAIST + 0.002, 0.030), (0, Y0 + 0.020, 0.068)], 0.0030, n=8)               # sash down the front
    for sx in (-1, 1):
        ball(gold, (sx * 0.050, SHO + 0.004, -0.002), 0.019, scale=(1.1, 0.70, 1.1))
    M = head(f, (0, HEAD - 0.001, 0.004), r=HR * 0.96, skin=SKIN_FAIR, fem=True, iris=(0.12, 0.25, 0.50),
             brow=(0.45, 0.28, 0.08), lips=LIPS, yaw=0.10, pitch=-0.04)
    hp = f("hair", HAIR, SATIN, "sheet", 0.005)
    hair_cap(hp, M, r=HR * 0.96, front=0.80, back=0.10, sides=0.30, puff=1.10)
    locks = f("locks", HAIR, SATIN)
    long_hair(locks, M, HR * 0.96, length=0.104, count=7, wave=0.006, thick=0.0110)
    ring(gold, (0, 0.34 * HR, 0.0), HR * 0.98, 0.0016, M=M @ rot_x(-0.22))                  # tiara
    tube(gold, [M @ V(-0.18 * HR, 0.58 * HR, 0.92 * HR), M @ V(0, 0.92 * HR, 0.92 * HR),
                M @ V(0.18 * HR, 0.58 * HR, 0.92 * HR)], 0.0016, n=6)
    halo = f("halo", GOLD, METAL, "hard")
    ring(halo, M @ V(0, 0.30 * HR, -1.25 * HR), HR * 1.45, 0.0016, n=40, y_dir=M.to_3x3() @ V(0, 0.25, 1))
    ball(f("gem", LIGHT, GLOW, "hard"), M @ V(0, 0.62 * HR, 1.0 * HR), 0.0032, n=8, rings=6)
    # sun staff in the right hand
    sleeves = f("sleeves", WHITE, SATIN)
    st_bottom, st_top = V(-0.080, Y0 + 0.002, 0.034), V(-0.084, Y0 + 0.282, 0.044)
    el, wr = V(-0.066, SHO - 0.040, 0.010), V(-0.078, SHO - 0.050, 0.034)
    arm(f, -1, el, wr, fist=0.0106, wide=0.92, grip=st_top - st_bottom, hands="skin")
    bell_sleeve(sleeves, el, wr)
    staff(f, "staff", st_bottom, st_top, GOLD, r=0.0050).mat = METAL
    sun = f("sun", GOLD, METAL, "hard")
    c = st_top + V(0, 0.030, 0)
    ring(sun, c, 0.020, 0.0030, n=28, y_dir=(0, 0, 1))
    for k in range(12):
        a = 2 * math.pi * k / 12
        L = 0.013 if k % 2 else 0.020
        d = V(math.cos(a), math.sin(a), 0)
        tube(sun, [c + d * 0.022, c + d * (0.022 + L)], [0.0030, 0.0], n=6)
    tube(sun, [st_top, c - V(0, 0.019, 0)], 0.0034, n=8)
    ball(f("sun_core", LIGHT, GLOW, "hard"), c, 0.0105, scale=(1, 1, 0.6), n=14, rings=8)
    # left hand raised in blessing, holy light over the palm
    el, wr = V(0.070, SHO - 0.030, 0.024), V(0.066, SHO - 0.006, 0.058)
    hc = arm(f, 1, el, wr, fist=0.0104, wide=0.92, open_hand=True, grip=(0, 0.3, 1), hands="skin")
    bell_sleeve(sleeves, el, wr)
    ball(f("light", LIGHT, GLOW, "hard"), hc + V(0.002, 0.025, 0.006), 0.0120, n=16, rings=10)


def rogue(f):
    """Hooded cutpurse in black leather and ember orange, twin daggers low, a
    stolen coin in the air."""
    BLACK, EMBER, CLOTH = (0.050, 0.044, 0.046), (0.72, 0.25, 0.03), (0.035, 0.032, 0.036)
    HAIR = (0.035, 0.022, 0.015)
    f("leather", BLACK, SATIN)
    f("cloth", CLOTH, MATTE)
    f("boots", DARK_LEATHER, SATIN)
    lean = rot_x(0.16)                            # weight forward, ready to spring
    Mb = T((0, HIP, 0)) @ lean @ T((0, -HIP, 0))
    straps = f("straps", EMBER, SATIN)
    f("gloves", DARK_LEATHER, SATIN)
    f("sleeves", BLACK, SATIN)
    leg(f, 1, (0.040, ANK, 0.030), knee=(0.040, KNEE + 0.004, 0.044), legs="cloth", toe_yaw=0.45, boot_h=0.044,
        cuff="straps")
    leg(f, -1, (-0.040, ANK, -0.016), knee=(-0.036, KNEE, 0.010), legs="cloth", toe_yaw=-0.50, boot_h=0.044,
        cuff="straps")
    torso(f("leather"), wide=0.98, M=Mb)
    drape(f("skirt", BLACK, SATIN, "sheet", 0.0035), WAIST + 0.004, HIP - 0.026, 0.031, 0.040, folds=5, amp=0.08,
          jag=0.006, sx=1.22, sz=0.92, M=Mb)
    for sx in (-1, 1):   # crossed bandoliers
        tube(straps, [Mb @ V(sx * 0.034, SHO, 0.010), Mb @ V(0, CHEST - 0.006, 0.0305),
                      Mb @ V(-sx * 0.036, WAIST + 0.004, 0.020)], 0.0026, n=6)
    ring(f("belt", DARK_LEATHER, SATIN), Mb @ V(0, WAIST + 0.002, 0), 0.0318, 0.0028, M=S(1.22, 1, 0.84))
    for sx in (-1, 1):
        box(f("belt"), Mb @ V(sx * 0.030, WAIST - 0.006, 0.020), (0.012, 0.014, 0.008), b=0.003)
    drape(f("cape", CLOTH, MATTE, "sheet", 0.004), SHO + 0.004, KNEE - 0.010, 0.038, 0.066, folds=7, amp=0.14,
          flow=0.030, jag=0.012, skip=front_open(68), sx=1.12, sz=0.85, M=Mb @ T((0, 0, -0.006)))
    hcen = Mb @ V(0, HEAD - 0.002, 0.008)
    M = head(f, hcen, iris=(0.45, 0.20, 0.04), brow=HAIR, yaw=-0.15, pitch=0.06)
    hair_cap(f("hair", HAIR, SATIN, "sheet", 0.0045), M, front=0.76, back=0.30, sides=0.46, puff=1.07)
    locks = f("locks", HAIR, SATIN)
    bangs(locks, M, side=-1)
    scarf = f("scarf", EMBER, MATTE)                  # ember scarf at the throat, tails behind
    ring(scarf, Mb @ V(0, NECK - 0.002, 0.002), 0.0150, 0.0055, n=20)
    tube(scarf, [Mb @ V(0.008, NECK - 0.004, -0.014), Mb @ V(0.020, SHO - 0.020, -0.034),
                 Mb @ V(0.034, CHEST - 0.030, -0.052)], [0.0050, 0.0042, 0.0016], n=8)
    hood = f("hood", CLOTH, MATTE, "sheet", 0.0045)
    ball(hood, (0, 0.12 * HR, -0.14 * HR), HR * 1.28, scale=(0.96, 1.04, 1.06), M=M, n=22, rings=12,
         skip=lambda k, s, t: k < 3 or (math.sin(t) > 0.40 and k < 10))
    tube(hood, [M @ V(0, HR * 1.20, -HR * 0.5), M @ V(0, HR * 0.95, -HR * 1.4), M @ V(0, HR * 0.40, -HR * 1.7)],
         [HR * 0.42, HR * 0.26, 0.0])
    # twin daggers: right reversed low and back, left forward
    for side, el, wr, bd, cv in ((-1, V(-0.068, SHO - 0.042, -0.006), V(-0.064, SHO - 0.074, 0.016),
                                  V(-0.20, -0.95, 0.24), -0.006),
                                 (1, V(0.066, SHO - 0.036, 0.024), V(0.050, SHO - 0.048, 0.064),
                                  V(0.32, 0.18, 0.93), 0.006)):
        el, wr = Mb @ el, Mb @ wr
        hc = arm(f, side, el, wr, sh=Mb @ shoulder(side, 0.98), sleeve="sleeves", hands="gloves", fist=0.0110,
                 grip=bd)
        tube(straps, [lerp(el, wr, 0.55), lerp(el, wr, 0.75)], 0.0112, n=10)
        sword(f, frame(hc, bd, (0.0, 1.0, 0.2)), length=0.066, width=0.0125, guard_w=0.024, curve=cv,
              guard_rgb=DARK_STEEL, grip_len=0.016, keys=("blade", "dagger_hilt", "grip"))
    coin = f("coin", GOLD, METAL, "hard")
    lathe(coin, [(0.0, -0.0012), (0.0062, -0.0012), (0.0062, 0.0012), (0.0, 0.0012)], 16, GOLD,
          M=T(Mb @ V(0.050, HEAD - 0.010, 0.072)) @ rot_x(1.0) @ rot_z(0.4))


def warlock(f):
    """Black-haired witch of the fel in dark green-black, curling horns, a
    gnarled staff and green fire in her hand."""
    ROBE, DARKG, HORN, HAIR = (0.022, 0.034, 0.022), (0.05, 0.14, 0.04), (0.10, 0.085, 0.075), (0.015, 0.016, 0.014)
    FEL = (0.40, 1.0, 0.08)
    drape(f("robe", ROBE, SATIN, "sheet", 0.0045), WAIST + 0.004, Y0 + 0.001, 0.031, 0.072, folds=10, amp=0.11,
          jag=0.007, sx=1.05, sz=0.95)
    drape(f("felhem", FEL, GLOW, "sheet", 0.0045), Y0 + 0.008, Y0 + 0.0005, 0.0672, 0.0730, folds=10, amp=0.10,
          jag=0.007 * 0.5, rings=2, sx=1.05, sz=0.95)
    drape(f("coat", DARKG, SATIN, "sheet", 0.004), SHO + 0.002, Y0 + 0.004, 0.038, 0.082, folds=8, amp=0.12,
          flow=0.014, jag=0.008, skip=front_open(40), sx=1.12, sz=0.92, fold_phase=2.4)
    torso(f("bodice", ROBE, SATIN), wide=0.94, fem=True)
    gold = f("trim", (0.10, 0.20, 0.06), METAL)
    ring(gold, (0, WAIST + 0.002, 0), 0.0300, 0.0026, M=S(1.18, 1, 0.80))
    fel = f("fel", FEL, GLOW, "hard")
    crystal(fel, V(0, CHEST - 0.006, 0.030), 0.012, 0.0040, tilt=(1.4, 0.0))
    for sx in (-1, 1):
        for k in range(2):
            b = V(sx * (0.044 + 0.010 * k), SHO + 0.010, -0.006 + 0.010 * k)
            tube(f("spikes", HORN, GLOSS), [b, b + V(sx * 0.010, 0.022, -0.004)], [0.0040, 0.0], n=8)
    revolve(f("collar", DARKG, SATIN, "sheet", 0.0035),
            [(0.030, SHO + 0.000), (0.036, SHO + 0.016), (0.048, HEAD + 0.004)], 28,
            skip=front_open(72), M=S(1.15, 1, 0.95))
    M = head(f, (0, HEAD - 0.001, 0.003), r=HR * 0.96, skin=(0.56, 0.48, 0.44), fem=True, glow_eyes=FEL,
             brow=HAIR, lips=(0.10, 0.18, 0.08), yaw=0.14, pitch=0.03)
    hp = f("hair", HAIR, SATIN, "sheet", 0.005)
    hair_cap(hp, M, r=HR * 0.96, front=0.80, back=0.10, sides=0.30, puff=1.10)
    locks = f("locks", HAIR, SATIN)
    long_hair(locks, M, HR * 0.96, length=0.106, count=7, wave=0.006, thick=0.0108)
    bangs(locks, M, HR * 0.96, side=1)
    horn = f("horns", HORN, GLOSS)
    for sx in (-1, 1):
        lock(horn, [M @ V(sx * 0.42 * HR, 0.80 * HR, 0.18 * HR), M @ V(sx * 0.78 * HR, 1.10 * HR, -0.22 * HR),
                    M @ V(sx * 1.08 * HR, 0.90 * HR, -0.78 * HR), M @ V(sx * 1.16 * HR, 0.36 * HR, -0.74 * HR),
                    M @ V(sx * 1.06 * HR, 0.02 * HR, -0.28 * HR), M @ V(sx * 0.98 * HR, 0.10 * HR, 0.08 * HR)],
             HR * 0.25, HR * 0.05)
    # gnarled staff, a fel crystal caged at its head
    sleeves = f("sleeves", ROBE, SATIN)
    st_bottom, st_top = V(-0.080, Y0 + 0.002, 0.036), V(-0.088, Y0 + 0.288, 0.040)
    el, wr = V(-0.066, SHO - 0.040, 0.010), V(-0.078, SHO - 0.050, 0.034)
    arm(f, -1, el, wr, fist=0.0106, wide=0.92, grip=st_top - st_bottom, hands="skin")
    bell_sleeve(sleeves, el, wr)
    wood = staff(f, "staff", st_bottom, st_top, (0.06, 0.05, 0.035), r=0.0056, gnarl=0.0026)
    for k in range(3):
        a = 2 * math.pi * k / 3
        tube(wood, [st_top + V(0.003 * math.cos(a), -0.002, 0.003 * math.sin(a)),
                    st_top + V(0.016 * math.cos(a + 0.6), 0.016, 0.016 * math.sin(a + 0.6)),
                    st_top + V(0.004 * math.cos(a + 1.4), 0.036, 0.004 * math.sin(a + 1.4))], [0.0034, 0.0026, 0.0], n=6)
    crystal(fel, st_top + V(0, 0.018, 0), 0.030, 0.0085)
    # left hand up, fel fire licking from the palm
    el, wr = V(0.070, SHO - 0.032, 0.022), V(0.066, SHO - 0.010, 0.058)
    hc = arm(f, 1, el, wr, fist=0.0104, wide=0.92, open_hand=True, grip=(0, 0.3, 1), hands="skin")
    bell_sleeve(sleeves, el, wr)
    flame(fel, hc + V(0.0, 0.014, 0.004), 0.012, count=6, seed=11)


def hunter(f):
    """Bearded ranger of the wilds in teal and fur, longbow in hand, his
    wolf sitting at his side."""
    TEAL, FUR, FUR_DK, HAIR = (0.04, 0.20, 0.22), (0.15, 0.115, 0.085), (0.075, 0.058, 0.045), (0.24, 0.14, 0.06)
    PANTS = (0.10, 0.075, 0.05)
    f.body_M = T((-0.030, 0.0, -0.004))
    f("pants", PANTS, MATTE)
    f("boots", FUR_DK, MATTE)
    f("furcuff", FUR, MATTE)
    leg(f, 1, (0.032, ANK, 0.018), knee=(0.030, KNEE, 0.020), legs="pants", toe_yaw=0.40, boot_h=0.044,
        boot_r=0.0145, cuff="furcuff")
    leg(f, -1, (-0.030, ANK, -0.006), knee=(-0.026, KNEE, 0.006), legs="pants", toe_yaw=-0.30, boot_h=0.044,
        boot_r=0.0145, cuff="furcuff")
    torso(f("tunic_body", TEAL, MATTE), wide=1.06)
    drape(f("tunic", TEAL, MATTE, "sheet", 0.004), WAIST + 0.004, KNEE + 0.008, 0.033, 0.046, folds=6, amp=0.07,
          sx=1.22, sz=0.92)
    ring(f("belt", LEATHER, SATIN), (0, WAIST + 0.002, 0), 0.0335, 0.0030, M=S(1.22, 1, 0.84))
    box(f("buckle", GOLD, METAL, "hard"), (0, WAIST + 0.002, 0.030), (0.010, 0.009, 0.004), b=0.0015)
    tube(f("belt"), [(0.034, SHO, 0.014), (0.0, CHEST - 0.006, 0.033), (-0.036, WAIST + 0.006, 0.022)], 0.0028, n=6)
    drape(f("cloak", FUR_DK, MATTE, "sheet", 0.004), SHO, KNEE - 0.006, 0.040, 0.066, folds=7, amp=0.12,
          flow=0.016, jag=0.008, skip=front_open(70), sx=1.12, sz=0.86, M=T((0, 0, -0.006)))
    M = head(f, (0, HEAD, 0.004), iris=(0.10, 0.26, 0.26), brow=HAIR, yaw=0.30, pitch=0.05)
    hair_cap(f("hair", HAIR, SATIN, "sheet", 0.005), M, front=0.76, back=0.14, sides=0.36, puff=1.09)
    locks = f("locks", HAIR, SATIN)
    long_hair(locks, M, length=0.074, count=6, wave=0.004, thick=0.0100)
    beard = f("beard", HAIR, SATIN)
    ball(beard, (0, -0.52 * HR, 0.42 * HR), HR * 0.55, scale=(1.05, 1.0, 0.8), M=M)
    tube(beard, [M @ V(0, -0.70 * HR, 0.55 * HR), M @ V(0, -1.20 * HR, 0.62 * HR), M @ V(0, -1.55 * HR, 0.50 * HR)],
         [HR * 0.42, HR * 0.30, HR * 0.06])
    for sx in (-1, 1):
        ball(beard, (sx * 0.42 * HR, -0.36 * HR, 0.42 * HR), HR * 0.32, M=M)
    # longbow in the right hand, planted by the foot
    el, wr = V(-0.070, SHO - 0.044, 0.006), V(-0.074, SHO - 0.080, 0.022)
    hc = arm(f, -1, el, wr, sleeve="tunic_body", hands="skin", fist=0.0112, grip=(0.05, 1, 0.1), wide=1.06)
    tube(f("bracers", LEATHER, SATIN), [lerp(el, wr, 0.35), wr], [0.0112, 0.0102])
    longbow(f, hc, (0.06, 1.0, 0.10), V(0.5, 0, -0.8), height=0.24, bend=0.012)
    quiver(f, V(0.024, WAIST - 0.014, -0.040), V(-0.022, SHO + 0.030, -0.048), fletch=(0.75, 0.72, 0.68))
    # the wolf at his left, his hand on its head
    wc, wk = V(0.098, Y0, 0.030), 1.32
    wolf(f, wc, yaw=0.20, k=wk)
    head_w = wc + rot_y(0.20) @ (V(0, 0.092, 0.018) * wk)
    el = V(0.074, SHO - 0.046, 0.006)
    arm(f, 1, el, head_w + V(-0.006, 0.010, -0.004), sleeve="tunic_body", hands="skin", fist=0.0110, open_hand=True,
        grip=(0, -1, 0.2), wide=1.06)
    tube(f("bracers"), [lerp(el, head_w, 0.35), lerp(el, head_w, 0.80)], [0.0112, 0.0102])


def barbarian(f):
    """Wild-haired berserker in fur and leather, bare-armed, a double-bitted
    greataxe across his body."""
    FUR, FUR_DK, KILT, HAIR = (0.17, 0.11, 0.06), (0.085, 0.060, 0.040), (0.30, 0.09, 0.03), (0.060, 0.036, 0.020)
    W = 1.18
    skin = f("skin", SKIN_TAN, SATIN)
    f("boots", FUR_DK, MATTE)
    f("furcuff", FUR, MATTE)
    leg(f, 1, (0.040, ANK, 0.022), knee=(0.038, KNEE, 0.028), legs="skin", toe_yaw=0.45, boot_h=0.040,
        boot_r=0.0155, thigh=0.0195, calf=0.0150, hip_x=0.022, cuff="furcuff")
    leg(f, -1, (-0.040, ANK, -0.010), knee=(-0.036, KNEE, 0.006), legs="skin", toe_yaw=-0.40, boot_h=0.040,
        boot_r=0.0155, thigh=0.0195, calf=0.0150, hip_x=0.022, cuff="furcuff")
    torso(skin, wide=W, deep=1.08)
    for sx in (-1, 1):   # pecs and a hint of the gut
        ball(skin, (sx * 0.018, CHEST - 0.002, 0.020), 0.017, scale=(1.15, 0.80, 0.75))
    ball(skin, (0, WAIST + 0.006, 0.016), 0.022, scale=(1.2, 0.9, 0.8))
    drape(f("kilt", KILT, MATTE, "sheet", 0.0045), WAIST + 0.004, KNEE + 0.002, 0.036, 0.052, folds=7, amp=0.09,
          jag=0.004, sx=1.22, sz=0.94)
    lth = f("leather", LEATHER, SATIN)
    ring(lth, (0, WAIST + 0.003, 0), 0.0360, 0.0042, M=S(1.22, 1, 0.92))
    gold = f("gold", GOLD, METAL)
    ball(gold, (0, WAIST + 0.003, 0.034), 0.0080, scale=(1.2, 1.0, 0.5))
    for sx in (-1, 1):   # harness straps crossing the chest
        tube(lth, [(sx * 0.044, SHO + 0.004, 0.006), (0, CHEST - 0.010, 0.0335), (-sx * 0.040, WAIST + 0.006, 0.026)],
             0.0030, n=6)
    ball(gold, (0, CHEST - 0.010, 0.0345), 0.0050, scale=(1, 1, 0.5))
    M = head(f, (0, HEAD - 0.002, 0.008), r=HR * 1.02, skin=SKIN_TAN, iris=(0.20, 0.10, 0.04), brow=HAIR,
             yaw=-0.10, pitch=0.10)
    hp = f("hair", HAIR, SATIN, "sheet", 0.0055)
    hair_cap(hp, M, r=HR * 1.02, front=0.80, back=0.10, sides=0.34, puff=1.12)
    dreads = f("dreads", HAIR, SATIN)
    for k in range(11):
        a = math.pi * (-0.15 + 1.30 * k / 10)
        sx, sz = -math.cos(a), -math.sin(a)
        top = M @ V(sx * HR * 0.86, 0.35 * HR, sz * HR * 0.80)
        L = 0.060 + 0.022 * ((k * 7) % 3) / 2
        lock(dreads, [top, top + V(sx * 0.012, -L * 0.35, sz * 0.008), top + V(sx * 0.016, -L * 0.7, sz * 0.010),
                      top + V(sx * 0.014, -L, sz * 0.006)], 0.0058, 0.0030, n=8)
    beard = f("beard", HAIR, SATIN)
    ball(beard, (0, -0.52 * HR, 0.40 * HR), HR * 0.62, scale=(1.10, 1.0, 0.82), M=M)
    for sx in (-0.5, 0.5):
        lock(beard, [M @ V(sx * HR, -0.80 * HR, 0.62 * HR), M @ V(sx * 1.1 * HR, -1.45 * HR, 0.70 * HR),
                     M @ V(sx * 1.0 * HR, -2.05 * HR, 0.55 * HR)], HR * 0.30, HR * 0.10, n=8)
    for sx in (-1, 1):
        ball(beard, (sx * 0.46 * HR, -0.34 * HR, 0.42 * HR), HR * 0.34, M=M)
    # greataxe gripped in both hands, low right to high left
    lo, hi = V(-0.072, HIP - 0.026, 0.048), V(0.090, SHO + 0.052, 0.036)
    d = (hi - lo).normalized()
    haft = f("haft", WOOD, SATIN, "hard")
    tube(haft, [lo - d * 0.030, hi + d * 0.006], 0.0060, n=10)
    for t in (0.18, 0.30):
        ring(f("leather"), lo + (hi - lo) * t, 0.0066, 0.0022, n=12, y_dir=d)
    g1, g2 = lo + (hi - lo) * 0.26, lo + (hi - lo) * 0.56
    for side, g, el in ((-1, g1, V(-0.084, SHO - 0.052, 0.012)), (1, g2, V(0.088, SHO - 0.046, 0.012))):
        wr = g - (g - el).normalized() * 0.013
        arm(f, side, el, wr, sleeve="skin", hands="skin", up=0.0152, fore=0.0132, fist=0.0128, grip=d, wide=W)
        ring(gold, lerp(el, wr, 0.6), 0.0128, 0.0024, n=14, y_dir=wr - el)
    perp = d.cross(V(0, 0, 1)).normalized()
    Mh = Matrix((d, perp, V(0, 0, 1))).transposed().to_4x4()
    head_at = hi - d * 0.026
    steel = f("axe", (0.40, 0.41, 0.44), METAL, "hard")
    for flip in (1, -1):
        axe_bit(steel, T(head_at) @ Mh, flip=flip, reach=0.044, half=0.032)
    box(f("axe_core", DARK_STEEL, METAL, "hard"), (0, 0, 0), (0.026, 0.012, 0.011), b=0.002, M=T(head_at) @ Mh)
    ball(f("axe_core"), hi + d * 0.010, 0.0062, n=10, rings=6)


def bard(f):
    """Long-haired troubadour in a magenta coat, lute in hand, notes in the air."""
    COAT, DOUBLET, SHIRT, HAIR = (0.50, 0.035, 0.24), (0.10, 0.025, 0.08), (0.80, 0.76, 0.68), (0.24, 0.12, 0.05)
    NOTE = (1.0, 0.32, 0.80)
    f("trousers", (0.05, 0.03, 0.05), MATTE)
    f("boots", DARK_LEATHER, SATIN)
    f("cuffs", GOLD, METAL)
    leg(f, 1, (0.036, ANK, 0.022), knee=(0.030, KNEE, 0.026), legs="trousers", toe_yaw=0.45, boot_h=0.048,
        cuff="cuffs")
    leg(f, -1, (-0.030, ANK, -0.008), knee=(-0.026, KNEE, 0.004), legs="trousers", toe_yaw=-0.25, boot_h=0.048,
        cuff="cuffs")
    torso(f("doublet", DOUBLET, SATIN), wide=1.0)
    coat = f("coat", COAT, SATIN, "sheet", 0.004)
    drape(coat, SHO + 0.004, KNEE - 0.014, 0.040, 0.070, folds=8, amp=0.10, flow=0.020, skip=front_open(34),
          sx=1.14, sz=0.92, fold_phase=1.0)
    drape(f("coat_hem", GOLD, METAL, "sheet", 0.004), KNEE - 0.002, KNEE - 0.0145, 0.0672, 0.0705, folds=8,
          amp=0.088, flow=0.0, skip=front_open(34), rings=2, sx=1.14, sz=0.92, fold_phase=1.0, M=T((0, 0, -0.0015)))
    gold = f("gold", GOLD, METAL)
    for sx in (-1, 1):
        tube(gold, [(sx * 0.022, SHO + 0.000, 0.028), (sx * 0.032, WAIST, 0.034), (sx * 0.050, KNEE, 0.052)], 0.0017, n=6)
        for k in range(3):
            ball(gold, (sx * 0.010, CHEST + 0.006 - 0.016 * k, 0.0335), 0.0022, n=8, rings=5)
    ring(f("belt", DARK_LEATHER, SATIN), (0, WAIST + 0.002, 0), 0.0318, 0.0028, M=S(1.24, 1, 0.84))
    jabot = f("jabot", SHIRT, MATTE, "sheet", 0.003)
    drape(jabot, NECK + 0.004, CHEST - 0.002, 0.010, 0.020, folds=6, amp=0.20, skip=front_only(45), rings=3,
          M=T((0, 0, 0.018)))
    ring(f("collar", SHIRT, MATTE), (0, NECK - 0.002, 0.0), 0.0150, 0.0035, n=20)
    M = head(f, (0, HEAD, 0.004), skin=SKIN, iris=(0.20, 0.12, 0.05), brow=HAIR, yaw=-0.30, pitch=0.12, roll=0.10)
    hair_cap(f("hair", HAIR, SATIN, "sheet", 0.005), M, front=0.78, back=0.10, sides=0.30, puff=1.10)
    locks = f("locks", HAIR, SATIN)
    long_hair(locks, M, length=0.088, count=7, wave=0.006, thick=0.0102)
    bangs(locks, M, side=1)
    beard = f("goatee", HAIR, SATIN)
    ball(beard, (0, -0.70 * HR, 0.58 * HR), HR * 0.22, scale=(1.0, 1.3, 0.8), M=M)
    # the lute across the body
    Ml = T((0.008, WAIST + 0.006, 0.050)) @ rot_z(math.radians(-50)) @ rot_x(0.15)
    lute(f, Ml)
    sl = f("sleeves", COAT, SATIN)
    neck_pt = Ml @ V(0.0, 0.090, 0.012)
    strum = Ml @ V(0.004, -0.006, 0.018)
    el = V(0.074, SHO - 0.040, 0.020)
    arm(f, 1, el, neck_pt + V(0.004, -0.006, -0.006), sleeve="sleeves", hands="skin", fist=0.0104, grip=Ml.to_3x3() @ V(0, 1, 0))
    tube(gold, [lerp(el, neck_pt, 0.72), lerp(el, neck_pt, 0.80)], 0.0118, n=10)
    el = V(-0.066, SHO - 0.046, 0.002)
    arm(f, -1, el, strum + V(-0.010, 0.002, 0.004), sleeve="sleeves", hands="skin", fist=0.0104, open_hand=True,
        grip=(0, 0, 1))
    tube(gold, [lerp(el, strum, 0.72), lerp(el, strum, 0.80)], 0.0118, n=10)
    # notes rising from the strings
    note = f("notes", NOTE, GLOW, "hard")
    for k, (x, y, z, s) in enumerate(((-0.040, SHO + 0.010, 0.060, 1.0), (-0.060, HEAD + 0.010, 0.040, 0.8),
                                      (0.050, HEAD + 0.026, 0.040, 0.9))):
        c = V(x, y, z)
        ball(note, c, 0.0052 * s, scale=(1.2, 0.85, 0.7), n=10, rings=6)
        tube(note, [c + V(0.0046 * s, 0, 0), c + V(0.0050 * s, 0.020 * s, 0)], 0.0011, n=5)
        tube(note, [c + V(0.0050 * s, 0.020 * s, 0), c + V(0.0110 * s, 0.014 * s, 0)], 0.0013, n=5)


def standin(f):
    """Hooded, robed figure in plain grey stone, face in shadow, hands folded
    in its sleeves: before the class pick."""
    ROBE = (0.30, 0.29, 0.28)
    body = f("body", ROBE, MATTE)
    torso(body, wide=1.0)
    drape(f("robe", ROBE, MATTE, "sheet", 0.0045), WAIST + 0.004, Y0 + 0.001, 0.032, 0.068, folds=8, amp=0.09,
          sx=1.08, sz=0.95)
    drape(f("mantle", ROBE, MATTE, "sheet", 0.0045), NECK + 0.002, CHEST - 0.018, 0.026, 0.058, folds=7, amp=0.07,
          bulge=0.008, rings=5, sx=1.15, sz=0.92)
    ring(f("cord", (0.22, 0.21, 0.20), MATTE), (0, WAIST + 0.002, 0), 0.0305, 0.0026, M=S(1.22, 1, 0.82))
    M = head(f, (0, HEAD, 0.0), skin=(0.07, 0.066, 0.064), brow=(0.07, 0.066, 0.064), eyes=False, ears=False)
    hood = f("hood", ROBE, MATTE, "sheet", 0.005)
    ball(hood, (0, 0.12 * HR, -0.12 * HR), HR * 1.32, scale=(0.96, 1.04, 1.06), M=M, n=22, rings=12,
         skip=lambda k, s, t: k < 3 or (math.sin(t) > 0.42 and k < 9))
    tube(hood, [M @ V(0, HR * 1.24, -HR * 0.55), M @ V(0, HR * 1.0, -HR * 1.35), M @ V(0, HR * 0.45, -HR * 1.6)],
         [HR * 0.44, HR * 0.28, 0.0])
    for sx in (-1, 1):
        el, wr = V(sx * 0.060, SHO - 0.046, 0.016), V(sx * 0.010, SHO - 0.062, 0.044)
        arm(f, sx, el, wr, sleeve="body", hands="body", fist=0.0105, up=0.0110)
        bell_sleeve(body, el, wr, 0.0125, 0.0175)


CLASSES = {
    "archer": archer, "mage": mage, "warrior": warrior, "necromancer": necromancer, "cleric": cleric,
    "rogue": rogue, "warlock": warlock, "hunter": hunter, "barbarian": barbarian, "bard": bard,
}


# --- sculpt pipeline ----------------------------------------------------------------

def _mesh_obj(name, me):
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def _evaluated(o):
    dg = bpy.context.evaluated_depsgraph_get()
    return bpy.data.meshes.new_from_object(o.evaluated_get(dg))


def detail_of(p):
    """Where the triangles go: faces and hair need them most, broad cloth least,
    and polished metal shows every facet in its reflections."""
    if p.key == "skin":
        return 3.2
    if p.key in ("hair", "locks", "beard", "dreads", "goatee"):
        return 1.5
    if p.mat == METAL:
        return 1.7
    return 0.6 if p.kind == "sheet" else 1.0


GROW = T((0, Y0, 0)) @ S(BODY, BODY, BODY) @ T((0, -Y0, 0))


def build_part(p, body_M):
    place = Matrix.Identity(4) if p.key.startswith("base_") else GROW @ body_M
    me = bpy.data.meshes.new(p.name)
    me.from_pydata([tuple((place @ v) * FIG_SCALE) for v in p.V], [], p.F)
    me.validate()
    o = _mesh_obj(p.name, me)
    if p.kind in ("fuse", "sheet"):
        if p.kind == "sheet":
            s = o.modifiers.new("solid", "SOLIDIFY")
            # (even offset would shoot a spike out of every cone tip)
            s.thickness, s.offset, s.use_even_offset = p.thick * FIG_SCALE * BODY, 0.0, False
        r = o.modifiers.new("fuse", "REMESH")
        r.mode, r.voxel_size, r.adaptivity = "VOXEL", VOXEL, 0.0
        sm = o.modifiers.new("relax", "SMOOTH")
        sm.factor, sm.iterations = 0.5, 5 if p.mat == METAL else 2
        dense = _evaluated(o)
        bpy.data.objects.remove(o)
        bpy.data.meshes.remove(me)
        area = np.empty(len(dense.polygons), np.float32)
        dense.polygons.foreach_get("area", area)
        tris = sum(len(q.vertices) - 2 for q in dense.polygons)
        o = _mesh_obj(p.name, dense)
        target = max(60.0, float(area.sum()) * TRI_DENSITY * detail_of(p))
        if tris > target:
            d = o.modifiers.new("dec", "DECIMATE")
            d.ratio = target / tris
            fin = _evaluated(o)
            bpy.data.objects.remove(o)
            bpy.data.meshes.remove(dense)
            o = _mesh_obj(p.name, fin)
        me = o.data
        me.shade_smooth()
        cols = np.tile(np.array([*p.rgb, 1.0], np.float32), len(me.loops))
    else:
        me.shade_smooth()
        me.set_sharp_from_angle(angle=math.radians(38))
        sizes = np.array([len(q) for q in p.F])
        cols = np.repeat(np.array([(c[0], c[1], c[2], 1.0) for c in p.C], np.float32), sizes, axis=0).reshape(-1)
    attr = me.color_attributes.new("Color", "FLOAT_COLOR", "CORNER")
    attr.data.foreach_set("color", cols)
    mt = me.attributes.new("_MAT", "FLOAT", "POINT")
    mt.data.foreach_set("value", np.full(len(me.vertices), p.mat, np.float32))
    return o


def paint(o, y_floor, y_top):
    """Mini paint job into the vertex colour: AO wash, zenithal light, edge
    highlights. Needs the baked 'AO' point attribute."""
    me = o.data
    nv = len(me.vertices)
    pos = np.empty(nv * 3, np.float32)
    me.vertices.foreach_get("co", pos)
    pos = pos.reshape(-1, 3)
    nrm = np.empty(nv * 3, np.float32)
    me.vertex_normals.foreach_get("vector", nrm)
    nrm = nrm.reshape(-1, 3)
    ao = np.empty(nv * 4, np.float32)
    me.color_attributes["AO"].data.foreach_get("color", ao)
    ao = ao.reshape(-1, 4)[:, 0]
    mat = np.empty(nv, np.float32)
    me.attributes["_MAT"].data.foreach_get("value", mat)
    ev = np.empty(len(me.edges) * 2, np.int64)
    me.edges.foreach_get("vertices", ev)
    ev = ev.reshape(-1, 2)
    d = pos[ev[:, 1]] - pos[ev[:, 0]]
    d /= (np.linalg.norm(d, axis=1) + 1e-9)[:, None]
    conv = np.zeros(nv)
    cnt = np.zeros(nv)
    np.add.at(conv, ev[:, 0], (d * nrm[ev[:, 0]]).sum(1))
    np.add.at(conv, ev[:, 1], (-d * nrm[ev[:, 1]]).sum(1))
    np.add.at(cnt, ev[:, 0], 1)
    np.add.at(cnt, ev[:, 1], 1)
    conv /= np.maximum(cnt, 1)               # > 0 in a crease, < 0 on a ridge
    sm = np.zeros(nv)                        # one blur pass
    np.add.at(sm, ev[:, 0], conv[ev[:, 1]])
    np.add.at(sm, ev[:, 1], conv[ev[:, 0]])
    conv = 0.5 * conv + 0.5 * sm / np.maximum(cnt, 1)
    yn = (pos[:, 1] - y_floor) / (y_top - y_floor)
    zen = np.where(pos[:, 1] < y_floor, 0.95, 0.72 + 0.38 * smoothstep(0.0, 1.0, yn))
    wash = 0.22 + 0.78 * np.clip(ao, 0, 1) ** 1.3
    crease = np.clip(conv * 5.0, 0, 1)
    ridge = np.clip(-conv * 5.0, 0, 1)
    glow = mat > 0.875
    f = np.where(glow, 1.0, wash * zen * (1 - 0.38 * crease))
    hi = np.where(glow, 0.0, 0.65 * ridge)
    vi = np.empty(len(me.loops), np.int64)
    me.loops.foreach_get("vertex_index", vi)
    col = np.empty(len(me.loops) * 4, np.float32)
    me.color_attributes["Color"].data.foreach_get("color", col)
    col = col.reshape(-1, 4)
    c = col[:, :3] * f[vi][:, None]
    c = c + (c * 0.85 + 0.03) * hi[vi][:, None]
    col[:, :3] = np.clip(c, 0, 1)
    me.color_attributes["Color"].data.foreach_set("color", col.reshape(-1))
    me.color_attributes.remove(me.color_attributes["AO"])
    me.color_attributes.active_color_index = me.color_attributes.find("Color")
    me.color_attributes.render_color_index = me.color_attributes.find("Color")


def make_figure(name, team, fn, slot, mat):
    f = Fig(name, team)
    base(f)
    fn(f)
    objs = [build_part(p, f.body_M) for p in f.parts.values()]
    if DEBUG:
        log(name + ": " + ", ".join(f"{p.key} {sum(len(q.vertices) - 2 for q in o.data.polygons)}"
                                    f" (top {max(v.co.y for v in o.data.vertices):.3f})"
                                    for p, o in zip(f.parts.values(), objs)))
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = o.data.name = name
    o.data.materials.clear()
    o.data.materials.append(mat)
    o.location = (slot * 1.5, 0.0, 0.0)   # apart from the others while the AO bakes
    return o, sum(len(q.vertices) - 2 for q in o.data.polygons)


def bake_ao(objs):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 96
    sc.world.light_settings.distance = AO_DIST
    sc.render.bake.target = "VERTEX_COLORS"
    for o in objs:
        me = o.data
        me.color_attributes.new("AO", "FLOAT_COLOR", "POINT")
        me.color_attributes.active_color_index = me.color_attributes.find("AO")
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.bake(type="AO")


# --- coins -----------------------------------------------------------------------------

COIN_R, COIN_T = 0.15, 0.03
COIN_FIELD = (0.28, 0.18, 0.06)
COIN_GOLD = (0.80, 0.56, 0.16)
COIN_IRON = (0.13, 0.13, 0.14)


def coin(g, team):
    h = COIN_T / 2
    enamel = TEAM[team]
    lathe(g, [(0.0, -h), (COIN_R - 0.010, -h), (COIN_R, -h + 0.006), (COIN_R, h - 0.006), (COIN_R - 0.010, h),
              (0.0, h)], 40, [COIN_IRON, COIN_IRON, enamel, COIN_GOLD, COIN_FIELD])
    # Marked face (+y): gold rim, team enamel ring, crossed swords under a skull.
    annulus(g, 0, 0, 0.118, 0.138, h, 0.004, 40, COIN_GOLD)
    annulus(g, 0, 0, 0.100, 0.110, h, 0.002, 40, enamel)
    for a in (math.radians(45), math.radians(135)):
        M = T((0, h + 0.003, 0)) @ rot_y(a)
        cbox(g, (0.010, 0, 0), (0.150, 0.006, 0.016), COIN_GOLD, b=0.002, M=M, bottom=True)
        cbox(g, (-0.056, 0, 0), (0.008, 0.007, 0.050), COIN_GOLD, b=0.002, M=M, bottom=True)
        sphere(g, (-0.078, 0.001, 0), 0.009, COIN_GOLD, n=8, rings=4, scale=(1, 0.5, 1), M=M)
    sphere(g, (0, h + 0.006, 0.006), 0.034, COIN_GOLD, n=16, rings=8, scale=(1.0, 0.32, 1.05))
    cbox(g, (0, h + 0.004, -0.032), (0.034, 0.008, 0.020), COIN_GOLD, b=0.002, bottom=True)
    for sx in (-1, 1):
        sphere(g, (sx * 0.012, h + 0.0135, 0.010), 0.0085, COIN_IRON, n=8, rings=4, scale=(1, 0.35, 1))
    sphere(g, (0, h + 0.0125, -0.006), 0.004, COIN_IRON, n=6, rings=4, scale=(1, 0.35, 1))
    # Blank face (-y): plain dark iron with one faint raised ring.
    lathe(g, [(0.118, -h), (0.118, -h - 0.003), (0.138, -h - 0.003), (0.138, -h)], 40, (0.20, 0.20, 0.21))


def coin_obj(g, mat):
    me = bpy.data.meshes.new(g.name)
    me.from_pydata([tuple(v) for v in g.V], [], g.F)
    sizes = np.array([len(q) for q in g.F])
    cols = np.repeat(np.array([(c[0], c[1], c[2], 1.0) for c in g.C], np.float32), sizes, axis=0)
    attr = me.color_attributes.new("Color", "FLOAT_COLOR", "CORNER")
    attr.data.foreach_set("color", cols.reshape(-1))
    me.validate(clean_customdata=False)
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(35))
    o = _mesh_obj(g.name, me)
    me.materials.append(mat)
    return o


# --- preview material (mirrors stage/src/figure-material.ts) ---------------------------

def preview_material():
    mat = bpy.data.materials.new("mk_figure")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Color"
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = "_MAT"
    nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")         # roughness per finish
    ramp.color_ramp.interpolation = "CONSTANT"
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, (0.82, 0.82, 0.82, 1)
    els[1].position, els[1].color = 0.125, (0.55, 0.55, 0.55, 1)
    for pos, v in ((0.375, 0.30), (0.625, 0.34), (0.875, 0.45)):
        e = els.new(pos)
        e.color = (v, v, v, 1)
    nt.links.new(at.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Roughness"])
    gt = nt.nodes.new("ShaderNodeMath")
    gt.operation, gt.inputs[1].default_value = "GREATER_THAN", 0.625
    lt = nt.nodes.new("ShaderNodeMath")
    lt.operation, lt.inputs[1].default_value = "LESS_THAN", 0.875
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    nt.links.new(at.outputs["Fac"], gt.inputs[0])
    nt.links.new(at.outputs["Fac"], lt.inputs[0])
    nt.links.new(gt.outputs[0], mul.inputs[0])
    nt.links.new(lt.outputs[0], mul.inputs[1])
    nt.links.new(mul.outputs[0], bsdf.inputs["Metallic"])
    glow = nt.nodes.new("ShaderNodeMath")
    glow.operation, glow.inputs[1].default_value = "GREATER_THAN", 0.875
    nt.links.new(at.outputs["Fac"], glow.inputs[0])
    em = nt.nodes.new("ShaderNodeMath")
    em.operation, em.inputs[1].default_value = "MULTIPLY", 1.6
    nt.links.new(glow.outputs[0], em.inputs[0])
    nt.links.new(vc.outputs["Color"], bsdf.inputs["Emission Color"])
    nt.links.new(em.outputs[0], bsdf.inputs["Emission Strength"])
    return mat


# --- build, export, preview ---------------------------------------------------------------

clear_scene()
if bpy.context.scene.world is None:
    bpy.context.scene.world = bpy.data.worlds.new("w")
fig_mat = preview_material()
fig_objs, core_objs, lineup = [], [], []
classes = [(c, fn) for c, fn in CLASSES.items() if not ONLY or c in ONLY]
slot = 0
for cls, fn in classes:
    for team in ("red", "blue"):
        o, tris = make_figure(f"token_{cls}_{team}", team, fn, slot, fig_mat)
        slot += 1
        fig_objs.append(o)
        if team == "red":
            lineup.append((o, tris))
log("figures: " + ", ".join(f"{o.name.split('_')[1]} {t:,}" for o, t in lineup))
for name, team in (("token_p1", "red"), ("token_p2", "blue")):
    o, _ = make_figure(name, team, standin, slot, fig_mat)
    slot += 1
    core_objs.append(o)
bake_ao(fig_objs + core_objs)
for o in fig_objs + core_objs:
    paint(o, Y0 * FIG_SCALE, (Y0 + (HEAD + HR - Y0) * BODY) * FIG_SCALE)
for o in fig_objs + core_objs:
    o.location = (0.0, 0.0, 0.0)
coin_mat = vertex_material("mk_coin", 0.38, metal=0.6)   # the game uses the coins' own material
for name, team in (("coin_red", "red"), ("coin_blue", "blue")):
    g = Geo(name)
    coin(g, team)
    core_objs.append(coin_obj(g, coin_mat))

if not ONLY:
    export_glb(fig_objs, FIGURES_GLB, draco=True, attributes=True, pos_bits=12, log=log)
    export_glb(core_objs, CORE_GLB, draco=True, attributes=True, log=log)
else:
    log("PIECES_ONLY set: preview only, nothing exported")


def preview_scene():
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    w = sc.world
    w.use_nodes = True
    nt = w.node_tree
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(os.path.join(os.path.dirname(bpy.app.binary_path),
                                                  f"{bpy.app.version[0]}.{bpy.app.version[1]}",
                                                  "datafiles", "studiolights", "world", "interior.exr"))
    bg = nt.nodes["Background"]
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.22
    for nm, energy, pos, col in (("key", 3.4, (1.2, 3.0, 2.6), (1.0, 0.86, 0.70)),
                                 ("rim", 2.6, (-2.0, 1.6, -2.4), (0.60, 0.68, 1.0))):
        L = bpy.data.objects.new(nm, bpy.data.lights.new(nm, "SUN"))
        L.data.energy, L.data.color, L.data.angle = energy, col, math.radians(8)
        sc.collection.objects.link(L)
        aim(L, pos, (0, 0, 0))
    floor = Geo("floor", colored=False)
    lathe(floor, [(0.0, -0.001), (40.0, -0.001)], 8, (0.04, 0.035, 0.03))
    fo = _mesh_obj("floor", bpy.data.meshes.new("floor"))
    fo.data.from_pydata([tuple(v) for v in floor.V], [], floor.F)
    fm = bpy.data.materials.new("floor")
    fm.use_nodes = True
    b = next(n for n in fm.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (0.030, 0.024, 0.020, 1)
    b.inputs["Roughness"].default_value = 0.7
    fo.data.materials.append(fm)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    return sc, cam


if PREVIEW:
    sc, cam = preview_scene()
    for o in fig_objs + core_objs:
        o.hide_render = True
    # 1) the red set from the game camera's angle
    shown = [o for o, _ in lineup] + [core_objs[0], core_objs[2]]
    for i, o in enumerate(shown):
        o.hide_render = False
        o.location = ((i - (len(shown) - 1) / 2) * 0.46, 0.0, 0.0)
    sc.render.resolution_x, sc.render.resolution_y = max(1200, 220 * len(shown)), 560
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 0.46 * (len(shown) + 0.4)
    aim(cam, (0.0, 2.2, 2.4), (0.0, 0.20, 0.0))
    sc.render.filepath = os.path.join(OUT, "pieces-mk-lineup.png")
    bpy.ops.render.render(write_still=True)
    log("rendered", os.path.relpath(sc.render.filepath, REPO))
    # 2) a close-up of each red figure, low three-quarter view
    for o in fig_objs + core_objs:
        o.hide_render = True
    sc.render.resolution_x, sc.render.resolution_y = 520, 700
    cam.data.type = "PERSP"
    cam.data.lens = 85
    cam.data.sensor_fit = "VERTICAL"
    cam.data.sensor_height = 24
    for o, _ in lineup + [(core_objs[0], 0)]:
        o.hide_render = False
        o.location = (0.0, 0.0, 0.0)
        aim(cam, (0.62, 0.62, 2.25), (0.0, 0.25, 0.0))
        sc.render.filepath = os.path.join(OUT, "hero", o.name.split("_")[1] + ".png")
        bpy.ops.render.render(write_still=True)
        o.hide_render = True
    log("rendered hero close-ups to tools/out/hero/")

log("DONE")
