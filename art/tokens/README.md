# Blank player tokens + extracted face decorations

Deliverables for designing new custom face decorations for the Regatta /
Master Killer player tokens (the stone discs the players move, `token_p1` /
`token_p2` in `stage/public/pieces.glb`). The blank discs and the removed
decorations are exported at the EXACT scale, position and orientation of the
shipped tokens: loading any of these GLBs next to `stage/public/pieces.glb`
puts them in register with the originals (blank + decoration reassembles the
shipped token).

## Files

| file | what it is |
|---|---|
| `blank-coin-red.glb`   | p1 stone disc (red team), blossom relief removed, face restored |
| `blank-coin-blue.glb`  | p2 stone disc (blue team), star relief removed, face restored |
| `decoration-blossom.glb` | the removed red blossom relief, alone, in place |
| `decoration-star.glb`    | the removed blue star relief, alone, in place |
| `*-draco.glb` | Draco-compressed companions (~0.14 MB), same content; the plain GLBs are the reference masters |
| `*.png` | headless EEVEE previews; `preview-comparison*.png` shows shipped vs blank vs decoration vs reassembled |

There are two blanks, not one: the two discs are separate hand sculpts
(Nomad `Regatta_PlayerA` / `Regatta_PlayerB`) and differ subtly in shape, so
a single `blank-coin.glb` would be wrong.

Note on naming: the pieces.glb meshes named `coin_red` / `coin_blue` are the
flip-coins (Kasen's gold metal "swan" coin, used verbatim for both players,
no team decoration on them). The blossom/star decorations only exist on the
moved tokens. These files are named per the art brief ("blank coin") but they
are the MOVED TOKENS.

## Provenance

- Sources: Kasen's full-res per-piece painted Nomad exports,
  `/Users/myrm/Downloads/Regatta_PlayerA color.glb` (blossom, ~3.85 M verts)
  and `Regatta_PlayerB color.glb` (star, ~3.76 M verts). The relief is
  voxel-fused into the stone (single connected skin, no separate shell), so
  the split was done by the paint mask: the paint is effectively binary
  (pure white stone vs fully saturated design, <0.4% boundary verts).
- Decorations: all faces whose vertices carry design paint, extracted as-is,
  bases capped flat, retinted to the shipped colors
  (blossom `(0.450, 0.045, 0.040)`, star `(0.050, 0.109, 0.329)`, linear RGB,
  the same BRICK_RED / STEEL_BLUE constants as `tools/build_assets.py`).
- Blanks: the top skin inside r = 0.62 R was removed (design reaches
  r = 0.605 R) and the hole capped at face level; outside that circle every
  vertex is the original sculpt. The inner face is therefore an idealized
  flat cap: the true face under the relief never existed in the sculpt.
  Stone tint `(0.820, 0.770, 0.660)` sampled from the shipped tokens.
- Scale/orientation: uniform scale k = 0.017089 (p1) / 0.017076 (p2),
  rotation = identity, centered on the shipped token's bbox center. Rotation
  was resolved by a KD-tree nearest-neighbor test of all 8 axis-aligned
  candidates against the shipped mesh (identity won: mean NN 0.0036 vs 0.0051
  runner-up for p1). Reassembly (blank + decoration) NN distance to the
  shipped token: mean ~0.0055, i.e. the shipped mesh's own decimation noise.
- Scratch scripts used (regenerate/verify): `tools/out/extract_token.py`
  (decorations), `tools/out/fix_blank.py` (blanks),
  `tools/out/verify_render.py` (bbox table + previews).

## Dimensions (Blender import coords: disc plane = XY, up = +Z)

The GLBs are Y-up on disk like every glTF; Blender's importer converts to
Z-up. In three.js (the game), up is +Y: three (x, y, z) = table (x, z, -y).

| mesh | bbox lo | bbox hi | size |
|---|---|---|---|
| `token_p1` (shipped)   | (-0.2071, -0.2071, -0.0374) | (+0.2071, +0.2071, +0.0370) | 0.4142 x 0.4141 x 0.0744 |
| `blank_coin_red`       | (-0.2070, -0.2071, -0.0373) | (+0.2070, +0.2072, +0.0253) | 0.4140 x 0.4143 x 0.0626 |
| `decoration_blossom`   | (-0.1203, -0.1117, +0.0128) | (+0.1214, +0.1248, +0.0370) | 0.2417 x 0.2366 x 0.0242 |
| `token_p2` (shipped)   | (-0.2070, -0.2070, -0.0371) | (+0.2070, +0.2070, +0.0376) | 0.4140 x 0.4139 x 0.0747 |
| `blank_coin_blue`      | (-0.2070, -0.2070, -0.0371) | (+0.2070, +0.2070, +0.0255) | 0.4140 x 0.4140 x 0.0626 |
| `decoration_star`      | (-0.1235, -0.1078, +0.0128) | (+0.1231, +0.1073, +0.0375) | 0.2466 x 0.2150 x 0.0247 |

The blanks' +Z top (+0.0253 / +0.0255) is the raised rim; with the relief
gone the rim is the highest point of the blank.

## Fit envelope for a new decoration

- Token axis passes through the origin; the face is a shallow dish inside a
  raised rim.
- Face (seat) level: z = +0.0129 to +0.0135. Sink the decoration base
  slightly below the face (base at z ~ +0.0128) so no gap shows; the
  extracted originals do exactly that.
- Radial budget: keep the design inside r = 0.123 (that is 0.595 R, what the
  originals use). Absolute maximum r = 0.130; the dish starts rising into
  the rim at about r = 0.135 (0.65 R).
- Height budget: shipped reliefs peak at z = +0.0370/+0.0375, i.e. about
  0.024 above the face and 0.012 proud of the rim top (+0.0255). Staying
  within z <= +0.038 keeps the piece's silhouette identical to the current
  game's.
- Footprint of the originals for reference: blossom 0.242 x 0.237, star
  0.247 x 0.215.

## Rebuilding pieces.glb with a new decoration

The game reads `mesh.geometry` per named object, so a rebuilt token must be
ONE mesh with ONE material slot (multi-primitive meshes load as a Group and
break `stage/src/main.ts`; see the material-collapse note in
`tools/build_assets.py` `make_coin`). Join your new decoration onto the
blank, name it `token_p1` / `token_p2`, and keep vertex colors as COLOR_0.
The client re-seats the geometry vertically on load (`geo.translate(0,
-0.08 - min.y, 0)`), but keeping the bbox above means everything else
(raycasting, tile seats, animations) stays untouched.
