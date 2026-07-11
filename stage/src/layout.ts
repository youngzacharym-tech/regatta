// ============================================================================
// layout.ts — where each abstract tile sits in the .glb's world space.
//
// This is the ONE file to re-tune when a new board mesh replaces regatta.glb.
// No THREE dependency — just numbers — so it can also be consumed by
// raycasting / tap detection later.
//
// Rulebook path (15 tiles per player):
//   0..3   own safe start row  (4 tiles, right-to-left, tile 3 is shield)
//   4..11  contested middle    (8 tiles, left-to-right, tile 7 is shield)
//   12..13 own safe finish row (2 tiles, right-to-left, tile 13 is shield)
//   14     finish tile         (right-to-left continuation, exact roll to enter)
//
// These coordinates are MEASURED, not eyeballed: the board GLB is exported
// by tools/build_assets.py from the painted sculpt, already in world space
// (tile grid centered at origin, long axis on X). Each entry below is the
// measured center of the tile's white border frame, printed by the build
// script during export. Per-tile y = stamp relief top + token seat offset.
//
// The board is NOT mirrored at runtime anymore — the painted sculpt is
// oriented like Soulframe's table (finish end +X, viewer's red row +Z), so
// the export IS on-screen space.
//
// P1 = red row (near camera, +Z). P2 = blue row (far, -Z). Middle contested
// row is shared, so entries 4..11 are identical in both arrays.
// ============================================================================

import type { PlayerId } from "../../rulebook.ts";

export interface WorldPos {
  x: number;
  y: number;
  z: number;
}

const P1_TILES: WorldPos[] = [
  { x: -0.272, y: 0.140, z: 0.539 }, // 0
  { x: -0.811, y: 0.141, z: 0.539 }, // 1
  { x: -1.350, y: 0.140, z: 0.539 }, // 2
  { x: -1.889, y: 0.140, z: 0.539 }, // 3  SHIELD
  { x: -1.889, y: 0.140, z: 0.000 }, // 4
  { x: -1.350, y: 0.140, z: 0.000 }, // 5
  { x: -0.811, y: 0.140, z: 0.000 }, // 6
  { x: -0.272, y: 0.140, z: 0.000 }, // 7  SHIELD
  { x: 0.270, y: 0.129, z: 0.000 },  // 8
  { x: 0.812, y: 0.129, z: 0.000 },  // 9
  { x: 1.351, y: 0.129, z: 0.000 },  // 10
  { x: 1.890, y: 0.129, z: 0.000 },  // 11
  { x: 1.890, y: 0.129, z: 0.539 },  // 12
  { x: 1.351, y: 0.129, z: 0.539 },  // 13 SHIELD
  { x: 0.776, y: 0.202, z: 0.589 },  // 14 FINISH
];

const P2_TILES: WorldPos[] = [
  { x: -0.272, y: 0.140, z: -0.539 }, // 0
  { x: -0.811, y: 0.140, z: -0.539 }, // 1
  { x: -1.350, y: 0.140, z: -0.539 }, // 2
  { x: -1.889, y: 0.140, z: -0.539 }, // 3  SHIELD
  { x: -1.889, y: 0.140, z: 0.000 },  // 4
  { x: -1.350, y: 0.140, z: 0.000 },  // 5
  { x: -0.811, y: 0.140, z: 0.000 },  // 6
  { x: -0.272, y: 0.140, z: 0.000 },  // 7  SHIELD
  { x: 0.270, y: 0.129, z: 0.000 },   // 8
  { x: 0.812, y: 0.129, z: 0.000 },   // 9
  { x: 1.351, y: 0.129, z: 0.000 },   // 10
  { x: 1.890, y: 0.129, z: 0.000 },   // 11
  { x: 1.890, y: 0.130, z: -0.539 },  // 12
  { x: 1.351, y: 0.129, z: -0.539 },  // 13 SHIELD
  { x: 0.776, y: 0.209, z: -0.591 },  // 14 FINISH
];

export function tileWorldPos(player: PlayerId, tile: number): WorldPos {
  return (player === "p1" ? P1_TILES : P2_TILES)[tile];
}

// Off-board pieces rest on the tabletop (table surface at y = -0.42 in
// main.ts; the token pivot puts the base at mesh y - 0.08).
const OFF_BOARD_Y = -0.34;

/** Reserve stones wait beside the player's own coin pile. Spaced wider than a
 *  stone's diameter (~0.42) and staggered a touch in z so the models never
 *  intersect each other. */
export function reservePos(player: PlayerId, slot: number): WorldPos {
  const zbase = player === "p1" ? 2.05 : -1.9;
  return {
    x: -1.28 - slot * 0.5,
    y: OFF_BOARD_Y,
    z: zbase + (slot % 2 === 0 ? 0.07 : -0.07),
  };
}

/** Escaped tokens line up past the finish end (+X), own side. */
export function escapedPos(player: PlayerId, slot: number): WorldPos {
  return {
    x: 2.3 + slot * 0.52,
    y: OFF_BOARD_Y,
    z: player === "p1" ? 1.65 : -1.65,
  };
}
