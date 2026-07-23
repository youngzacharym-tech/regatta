// ============================================================================
// Stage — Three.js client for one player of a Regatta match.
//
// Renders the board (regatta.glb) plus 8 token markers, connects to the
// Referee over WebSocket, updates positions from every state broadcast, and
// exposes legal moves as clickable buttons. Tap-a-token comes later once the
// board tile positions are dialed in.
// ============================================================================

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { ClientMessage, RoomResponse, RoomJoinResponse } from "../../protocol.ts";
import type { RoomEvent } from "../../room-engine.ts";
import type {
  GameState,
  Move,
  PlayerId,
} from "../../rulebook.ts";
import { BOARD_LAYOUT } from "../../rulebook.ts";
import { tileWorldPos, reservePos, escapedPos } from "./layout.ts";
import { audio } from "./audio.ts";
import { PROC_ICONS, type ProcIconId } from "./proc-icons.ts";
// Master Killer mode — additive only. Everything below is inert in classic
// rooms (myVariant stays "classic", currentPower stays null, and every
// branch that reads them is gated accordingly).
import {
  CHARGE_CAP,
  BLESS_COST,
  BLESSING_CAP,
  CHARGED_SHOT_DISTANCE,
  CHARGED_SHOT_WARD_DISTANCE,
  CORPSE_EXPLOSION_COST,
  EXHUME_RETURN_POSITION,
  HEAL_COST,
  isWarded,
  NECRO_CHARGE_CAP,
  PICKPOCKET_COST,
  PICKPOCKET_STEAL,
  REFLIPS_PER_TURN,
  REVIVE_COST,
  THRALL_TURNS,
  VANISH_COST,
  type PlayerClass,
  type PowerMove,
  type PowerState,
} from "../../master-killer.ts";
import { normalizeDifficulty, type BotDifficulty } from "../../bot-difficulty.ts";

const PATH_LENGTH = 15; // must match rulebook.ts PATH_LENGTH_PER_PLAYER

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// URL resolution:
//   1. ?referee=... override wins (useful for pointing dev builds at prod, etc.)
//   2. If served from Vite dev server (port 5173) or a bare hostname, hit the
//      referee at the same host on port 8080.
//   3. In production, same-origin /api/room — works identically against the
//      Vercel function and the local Node referee.
function resolveApiURL(): string {
  const override = new URLSearchParams(location.search).get("referee");
  if (override) return override;
  const isDev = location.port === "5173" || location.hostname === "";
  if (isDev) return `http://${location.hostname || "localhost"}:8080/api/room`;
  return `${location.origin}/api/room`;
}
const API_URL = resolveApiURL();
const GLB_URL = "/regatta.glb";
const PIECES_URL = "/pieces.glb";
/** Master Killer class-token sculpts — lazy-loaded only when an MK room is
 *  seen (ensureMkPieces), never on the menu or in classic rooms. */
const PIECES_MK_URL = "/pieces-mk.glb";

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// Filmic tone mapping keeps the env-lit metals from blowing out to white.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Pulled down so the near-white stones and cream score pads don't blow out
// under the warm lamp — keeps highlights readable instead of blinding.
renderer.toneMappingExposure = 0.78;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// The shadow pass only re-renders while something that CASTS shadows is
// actually moving (tick() gates needsUpdate; markShadowsDirty() covers
// asset loads/swaps). An idle board — most of a turn-based game — skips
// the whole pass: the single biggest constant GPU cost on iPad, and the
// load grew with every necro-era asset until it read as "runs slow, eats
// battery" (Kasen, 2026-07-19). Visually identical: static shadows don't
// change.
renderer.shadowMap.autoUpdate = false;
let shadowsDirty = true;
function markShadowsDirty(): void {
  shadowsDirty = true;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x120d09);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
// Shared perspective: both players see the board from the same angle.
// Seated-across-the-table view — tilted down enough to read the piece designs
// but low enough to feel like you're sitting opposite an opponent. Aimed at
// the board's visual center (x -0.5); the tile grid is at the origin but the
// ship's prow extends further to -X.
camera.position.set(-0.5, 4.6, 5.0);
camera.lookAt(-0.5, 0.15, 0.95);

// Environment lighting — without it, metallic materials (the gold middle-row
// stamps, bronze coins) reflect nothing and render black.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.2;

// Tavern-table mood: one warm hanging lamp over the board doing most of the
// work (with soft shadows), low warm ambient so nothing goes pitch black,
// and a whisper of cool fill for shape.
scene.add(new THREE.AmbientLight(0xffdcb4, 0.26));

const lamp = new THREE.SpotLight(0xffc98a, 58, 0, Math.PI / 4.4, 0.6, 1.7);
lamp.position.set(-1.0, 5.6, 1.4);
lamp.target.position.set(-0.4, 0, 0);
lamp.castShadow = true;
lamp.shadow.mapSize.set(2048, 2048);
lamp.shadow.bias = -0.001;
lamp.shadow.normalBias = 0.06; // kills self-shadow striping on the hull sides
lamp.shadow.camera.near = 1;
lamp.shadow.camera.far = 12;
scene.add(lamp, lamp.target);

const fill = new THREE.DirectionalLight(0x92aacc, 0.22);
fill.position.set(-4, 3, -2);
scene.add(fill);

// ---------------------------------------------------------------------------
// The room — the board sits on a real table in a firelit tavern: a beveled
// slab tabletop with a brass inlay line, turned legs on worn plank floor,
// timbered walls sinking into warm fog, and a stone hearth built around the
// corner fire. Everything procedural and cheap (~25 draw calls, two tiny
// generated canvas textures, zero added lights — the lamp and fire do the
// work). The camera is fixed, so geometry only exists where it can see:
// the table edges, the floor band beyond them, the lower walls, the hearth.
// ---------------------------------------------------------------------------
const TABLE_Y = -0.42; // tabletop SURFACE — mugs/coins/glow discs sit relative to this
const FLOOR_Y = -3.15;

// Warm near-black fog, same tone as the background: gameplay (closer than
// ~7.5 units) is untouched; the room beyond sinks into the dark so wall and
// floor edges never read as a skybox seam.
scene.fog = new THREE.Fog(0x120d09, 7.5, 21);

function roundedRectShape(w: number, d: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const hw = w / 2;
  const hd = d / 2;
  s.moveTo(-hw + r, -hd);
  s.lineTo(hw - r, -hd);
  s.quadraticCurveTo(hw, -hd, hw, -hd + r);
  s.lineTo(hw, hd - r);
  s.quadraticCurveTo(hw, hd, hw - r, hd);
  s.lineTo(-hw + r, hd);
  s.quadraticCurveTo(-hw, hd, -hw, hd - r);
  s.lineTo(-hw, -hd + r);
  s.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  return s;
}

const woodTopMat = new THREE.MeshStandardMaterial({ color: 0x2b1c11, roughness: 0.95 });
const woodSideMat = new THREE.MeshStandardMaterial({ color: 0x221510, roughness: 0.9 });
const woodDarkMat = new THREE.MeshStandardMaterial({ color: 0x1c110b, roughness: 0.92 });
const brassMat = new THREE.MeshStandardMaterial({
  color: 0x7a5c2e,
  metalness: 0.85,
  roughness: 0.42,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
const wallMat = new THREE.MeshStandardMaterial({ color: 0x2d1e12, roughness: 1 });
const beamMat = new THREE.MeshStandardMaterial({ color: 0x170f09, roughness: 0.95 });
const stoneMat = new THREE.MeshStandardMaterial({ color: 0x3c322a, roughness: 1 });

// Two whisper lights sell the room's depth without touching the fire or lamp:
// a warm ember spill carrying the hearth's glow across the back-left floor
// and wall band, and a faint cool pick so the right side reads as shapes in
// shadow instead of a void.
const emberSpill = new THREE.PointLight(0xff9a45, 5, 15, 2);
emberSpill.position.set(-4.5, 0.8, -6.2);
scene.add(emberSpill);
// ...and a low ember wash BELOW the table lip, raking the exposed floor
// planks and legs with the fire's glow (the spill above can't reach the
// floor band the smaller table reveals). Sits under TABLE_Y so the
// tabletop itself never catches it.
const floorGlow = new THREE.PointLight(0xff8a3a, 10, 20, 2);
floorGlow.position.set(-5.6, -1.1, 0.6);
scene.add(floorGlow);
const coolPick = new THREE.PointLight(0x7f8fb0, 2.4, 11, 2);
coolPick.position.set(7.2, 0.6, -4.5);
scene.add(coolPick);

// --- The table. Top surface exactly at TABLE_Y; sized so every gameplay
// prop (reserves to x -4.5, escaped stones to x ~4.1, coins/mugs at z ±2.1)
// sits on wood with margin, while the edges stay inside the camera frame.
const TABLE_W = 8.7;
const TABLE_D = 5.8;
const TABLE_CX = -0.15;
const TABLE_CZ = 0.15;
const SLAB_T = 0.34;
const SLAB_BEVEL = 0.06;
const tabletop = new THREE.Mesh(
  new THREE.ExtrudeGeometry(roundedRectShape(TABLE_W, TABLE_D, 0.55), {
    depth: SLAB_T,
    bevelEnabled: true,
    bevelThickness: SLAB_BEVEL,
    bevelSize: 0.05,
    bevelSegments: 2,
    curveSegments: 8,
  }),
  [woodTopMat, woodSideMat],
);
// Shape x/y become world x/z; the extrusion runs downward. The top cap lands
// at position.y + SLAB_BEVEL, so this puts the surface exactly at TABLE_Y.
tabletop.rotation.x = Math.PI / 2;
tabletop.position.set(TABLE_CX, TABLE_Y - SLAB_BEVEL, TABLE_CZ);
tabletop.castShadow = false; // lamp-shadow on the fire-lit floor reads as a random dark patch
tabletop.receiveShadow = true;
scene.add(tabletop);

// Brass inlay line chasing the table edge — the one gilded accent out here.
const inlayShape = roundedRectShape(TABLE_W - 0.62, TABLE_D - 0.62, 0.46);
inlayShape.holes.push(
  new THREE.Path(roundedRectShape(TABLE_W - 0.78, TABLE_D - 0.78, 0.42).getPoints(24)),
);
const inlay = new THREE.Mesh(new THREE.ShapeGeometry(inlayShape, 8), brassMat);
inlay.rotation.x = -Math.PI / 2;
inlay.position.set(TABLE_CX, TABLE_Y + 0.004, TABLE_CZ);
inlay.renderOrder = -2; // stays under the coin/mug glow discs
scene.add(inlay);

// Apron + four turned legs (lathe) down to the floor.
const apron = new THREE.Mesh(
  new THREE.BoxGeometry(TABLE_W - 1.3, 0.42, TABLE_D - 1.3),
  woodDarkMat,
);
apron.position.set(TABLE_CX, TABLE_Y - SLAB_T - SLAB_BEVEL * 2 - 0.21, TABLE_CZ);
apron.castShadow = false;
scene.add(apron);

const legProfile: Array<[number, number]> = [
  [0.3, 0.0], [0.3, 0.12], [0.2, 0.2], [0.22, 0.62], [0.24, 1.3],
  [0.34, 1.5], [0.34, 1.62], [0.2, 1.78], [0.28, 1.95], [0.28, 2.27],
];
const legGeo = new THREE.LatheGeometry(
  legProfile.map(([r, y]) => new THREE.Vector2(r, y)),
  12,
);
for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
  const leg = new THREE.Mesh(legGeo, woodDarkMat);
  leg.position.set(
    TABLE_CX + lx * (TABLE_W / 2 - 1.0),
    FLOOR_Y,
    TABLE_CZ + lz * (TABLE_D / 2 - 1.0),
  );
  leg.castShadow = false;
  scene.add(leg);
}

// --- Worn plank floor. One small generated canvas, tiled.
function makePlankTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const planks = 4;
  const pw = s / planks;
  // Warm mid-browns — dark enough for the tavern mood, bright enough that
  // the fire's floor wash actually reads on them (near-black albedo here
  // made the floor invisible no matter how hard it was lit).
  const bases = ["#4a3322", "#513826", "#443021", "#4d3524"];
  for (let i = 0; i < planks; i++) {
    g.fillStyle = bases[i];
    g.fillRect(i * pw, 0, pw, s);
    // Grain: faint streaks running the plank's length.
    for (let k = 0; k < 14; k++) {
      const x = i * pw + 2 + Math.random() * (pw - 4);
      g.strokeStyle = Math.random() < 0.55 ? "rgba(0,0,0,0.14)" : "rgba(255,225,180,0.05)";
      g.lineWidth = 0.6 + Math.random() * 1.1;
      const wob = (Math.random() - 0.5) * 6;
      g.beginPath();
      g.moveTo(x, -4);
      g.bezierCurveTo(x + wob, s * 0.3, x - wob, s * 0.7, x + wob, s + 4);
      g.stroke();
    }
    g.fillStyle = "rgba(0,0,0,0.55)"; // seam between planks
    g.fillRect(i * pw - 1, 0, 2, s);
    if (Math.random() < 0.8) {
      // occasional butt joint across the plank
      g.fillRect(i * pw, Math.random() * s, pw, 1.5);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(14, 14);
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(46, 46),
  new THREE.MeshStandardMaterial({ map: makePlankTexture(), roughness: 0.95 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = FLOOR_Y;
floor.receiveShadow = true;
scene.add(floor);

// --- Walls: close enough for their lower band to catch fire/lamp spill at
// the top of the frame, fog does the rest. No ceiling — the camera never
// looks that high.
const backWall = new THREE.Mesh(new THREE.PlaneGeometry(40, 10), wallMat);
backWall.position.set(0, FLOOR_Y + 5, -8.4);
scene.add(backWall);
const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(36, 10), wallMat);
leftWall.rotation.y = Math.PI / 2;
leftWall.position.set(-8.9, FLOOR_Y + 5, -2);
scene.add(leftWall);
const rightWall = new THREE.Mesh(new THREE.PlaneGeometry(36, 10), wallMat);
rightWall.rotation.y = -Math.PI / 2;
rightWall.position.set(8.9, FLOOR_Y + 5, -2);
scene.add(rightWall);

// Timber suggestions: dark posts proud of the plaster, one horizontal rail.
for (const px of [-7.5, -4, -0.5, 3, 6.5]) {
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.34, 10, 0.18), beamMat);
  post.position.set(px, FLOOR_Y + 5, -8.3);
  scene.add(post);
}
const rail = new THREE.Mesh(new THREE.BoxGeometry(17.4, 0.3, 0.16), beamMat);
rail.position.set(-0.5, -1.7, -8.28);
scene.add(rail);
for (const pz of [-6.8, -9.5]) {
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 10, 0.34), beamMat);
  post.position.set(-8.8, FLOOR_Y + 5, pz);
  scene.add(post);
}
for (const pz of [-6, -9]) {
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 10, 0.34), beamMat);
  post.position.set(8.8, FLOOR_Y + 5, pz);
  scene.add(post);
}

// --- The hearth the corner fire lives in: chimney breast against the left
// wall, raised stone firebox whose mouth wraps the existing fire sprite
// (fireCfg untouched), stone jambs + lintel that catch the flicker.
const breast = new THREE.Mesh(new THREE.BoxGeometry(1.9, 6.2, 3.2), wallMat);
breast.position.set(-7.95, FLOOR_Y + 3.1, -4);
scene.add(breast);
const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.4, 3.0), stoneMat);
plinth.position.set(-6.85, FLOOR_Y + 1.2, -4);
scene.add(plinth);
// Unlit near-black sheet across the whole breast face between plinth and
// lintel — it swallows the fire light's point-blank hot spot so the mouth
// reads as glowing depth, not a blown-out wall.
const fireboxBack = new THREE.Mesh(
  new THREE.PlaneGeometry(2.7, 2.5),
  new THREE.MeshBasicMaterial({ color: 0x050201 }),
);
fireboxBack.rotation.y = Math.PI / 2;
fireboxBack.position.set(-6.98, 0.4, -4);
scene.add(fireboxBack);
for (const jz of [-5.03, -2.97]) {
  const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.1, 0.52), stoneMat);
  jamb.position.set(-6.97, 0.3, jz);
  scene.add(jamb);
}
const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 2.6), stoneMat);
lintel.position.set(-6.99, 1.6, -4);
scene.add(lintel);
const mantel = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 3.0), beamMat);
mantel.position.set(-6.95, 1.93, -4);
scene.add(mantel);

// --- A couple of barrels: one catching firelight past the hearth, two
// fading into the fog on the right.
const barrelGeo = new THREE.LatheGeometry(
  ([[0.44, 0], [0.56, 0.3], [0.6, 0.75], [0.56, 1.2], [0.44, 1.5], [0, 1.5]] as Array<
    [number, number]
  >).map(([r, y]) => new THREE.Vector2(r, y)),
  14,
);
const barrelMat = new THREE.MeshStandardMaterial({ color: 0x241811, roughness: 0.9 });
const hoopMat = new THREE.MeshStandardMaterial({
  color: 0x2a221c,
  metalness: 0.6,
  roughness: 0.6,
});
function addBarrel(x: number, z: number, scale: number): void {
  const b = new THREE.Mesh(barrelGeo, barrelMat);
  b.position.set(x, FLOOR_Y, z);
  b.scale.setScalar(scale);
  b.castShadow = false;
  scene.add(b);
  for (const hy of [0.42, 1.08]) {
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.578, 0.028, 6, 18), hoopMat);
    hoop.rotation.x = Math.PI / 2;
    hoop.position.set(x, FLOOR_Y + hy * scale, z);
    hoop.scale.setScalar(scale);
    scene.add(hoop);
  }
}
addBarrel(-6.2, -7.6, 1.0);
addBarrel(5.9, -6.4, 1.0);
addBarrel(4.7, -7.1, 0.85);

// --- Dust motes drifting in the fire- and lamp-light. One Points object;
// positions nudged on the CPU each frame (90 points — negligible).
function makeMoteTexture(): THREE.CanvasTexture {
  const s = 32;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,220,170,1)");
  grad.addColorStop(0.4, "rgba(255,200,140,0.45)");
  grad.addColorStop(1, "rgba(255,190,120,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const MOTE_COUNT = 90;
interface MoteSeed {
  x: number;
  y: number;
  z: number;
  amp: number;
  rise: number;
  sway: number; // rad/ms
  lift: number; // units/ms
  phase: number;
}
const moteSeeds: MoteSeed[] = [];
for (let i = 0; i < MOTE_COUNT; i++) {
  const nearFire = i < MOTE_COUNT * 0.65;
  moteSeeds.push({
    x: nearFire ? -7.4 + Math.random() * 4.6 : -3 + Math.random() * 5,
    y: nearFire ? -0.9 + Math.random() * 3.0 : 0.1 + Math.random() * 1.9,
    z: nearFire ? -6.5 + Math.random() * 5.0 : -1.6 + Math.random() * 3.4,
    amp: 0.15 + Math.random() * 0.35,
    rise: 1.6 + Math.random() * 1.2,
    sway: 0.0002 + Math.random() * 0.0003,
    lift: 0.00004 + Math.random() * 0.00005,
    phase: Math.random() * 1000,
  });
}
const motePos = new Float32Array(MOTE_COUNT * 3);
const moteGeo = new THREE.BufferGeometry();
moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
const motes = new THREE.Points(
  moteGeo,
  new THREE.PointsMaterial({
    map: makeMoteTexture(),
    size: 0.07,
    transparent: true,
    opacity: 0.55,
    color: 0xffc07a,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
);
motes.frustumCulled = false; // positions move every frame
scene.add(motes);
function updateMotes(now: number): void {
  for (let i = 0; i < MOTE_COUNT; i++) {
    const m = moteSeeds[i];
    motePos[i * 3] = m.x + Math.sin(now * m.sway + m.phase) * m.amp;
    motePos[i * 3 + 1] = m.y + ((now * m.lift + m.phase) % m.rise);
    motePos[i * 3 + 2] = m.z + Math.cos(now * m.sway * 0.8 + m.phase * 1.7) * m.amp;
  }
  (moteGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
}
updateMotes(0);

const CAM_TARGET = new THREE.Vector3(-0.5, 0.15, 0.95);
const CAM_BASE_POS = new THREE.Vector3(-0.5, 4.6, 5.0);
const CAM_BASE_DIST = CAM_BASE_POS.distanceTo(CAM_TARGET);
function resize() {
  markShadowsDirty(); // fresh drawing buffer needs a fresh shadow pass
  camera.aspect = window.innerWidth / window.innerHeight;
  // Short screens (phone landscape) pull the camera back along its own view
  // ray — up to ~+22% — so the board keeps clear margins for the HUD, the
  // plates, and the rail instead of running edge to edge underneath them.
  const h = window.innerHeight;
  const pullback = 1 + Math.min(0.22, Math.max(0, (540 - h) / 540) * 0.65);
  const dir = CAM_BASE_POS.clone().sub(CAM_TARGET).normalize();
  camera.position.copy(CAM_TARGET).addScaledVector(dir, CAM_BASE_DIST * pullback);
  camera.lookAt(CAM_TARGET);
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
window.addEventListener("resize", resize);
// iOS Safari suppresses resize while a tab is backgrounded, so an app switch
// (or a rotation while away) can resume with the camera/canvas framed for
// stale dimensions — mis-framed board until something else fires resize.
// Re-frame on every return to visible, bfcache restore, and (belt and
// braces — iOS reports post-rotation dimensions late) orientation change.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  resize();
  // iOS also reclaims WebGL contexts from backgrounded pages. When that
  // happens the canvas freezes on its LAST rendered frame while the DOM and
  // polling stay alive — the game looks wedged (old board behind the menu,
  // mug stuck mid-drink) but is actually still running. If the context is
  // still dead after the restore event has had a beat, reload: the seat
  // token in sessionStorage resumes the match seamlessly.
  if (renderer.getContext().isContextLost()) {
    setTimeout(() => {
      if (renderer.getContext().isContextLost()) location.reload();
    }, 1500);
  }
});
window.addEventListener("pageshow", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 250));
// Without preventDefault on contextlost, the browser never even ATTEMPTS a
// restore — this pair is what lets the reload above almost never be needed.
canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
canvas.addEventListener("webglcontextrestored", () => resize());
resize();

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

const boardGroup = new THREE.Group();
// The painted board (tools/build_assets.py) is exported directly in world
// space — no mirror needed, and layout.ts coordinates are measured from the
// same export.
scene.add(boardGroup);
const dracoLoader = new DRACOLoader();
// Draco decoder shipped by Google via jsDelivr — matches Three.js's expected version.
dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
gltfLoader.load(
  GLB_URL,
  (gltf) => {
    // The GLB is exported already in game space (tile grid centered at
    // origin, scale locked to layout.ts) — no auto-fit needed.
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    boardGroup.add(gltf.scene);
  },
  undefined,
  (err) => console.error("Failed to load", GLB_URL, err),
);

// Each captain gets a beer — one mug per side of the table. Every stone
// brought home earns a swig: the mug tilts back, gulps, and the foam head
// SINKS into the tankard. mug.glb ships as mug_body + mug_foam; the body's
// upper wall is sculpted-and-painted foam lace, so the head must never
// shrink in diameter (the old xz-shrink pulled the cap away from that lace
// and exposed a ragged grey seam — Kasen's "drinking bugs out the foam"
// report, 2026-07-19). Instead the cap keeps 93% width (just inside the
// glass), squashes, and drops below the rim — the lace reads as foam
// clinging to the glass above the sunken head.
interface MugRig {
  root: THREE.Group;
  foam: THREE.Object3D | null;
  basePos: THREE.Vector3;
  baseRotY: number;
  /** The foam node's authored local height — sips sink it from here. */
  foamBaseY: number;
  /** Sips taken (0..4). 4 = slammed empty. */
  sips: number;
  anim: { start: number; kind: "sip" | "slam" } | null;
}
let myMug: MugRig | null = null;
let theirMug: MugRig | null = null;
/** Per-sip foam pose: fixed 0.93 xz (fits the glass bore), y squash + sink
 *  (model units, tuned against Blender renders of every state). */
const FOAM_SIPS = [
  { xz: 1, y: 1, drop: 0 },
  { xz: 0.93, y: 0.8, drop: 0.045 },
  { xz: 0.93, y: 0.62, drop: 0.1 },
  { xz: 0.93, y: 0.45, drop: 0.16 },
  { xz: 0.93, y: 0.3, drop: 0.16 }, // slammed empty — hidden outright
];

gltfLoader.load(
  "/mug.glb",
  (gltf) => {
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    const place = (x: number, z: number, rotY: number): MugRig => {
      const mug = gltf.scene.clone(true) as THREE.Group;
      mug.scale.setScalar(1.15);
      mug.position.set(x, TABLE_Y + 0.575, z);
      mug.rotation.y = rotY;
      scene.add(mug);
      const foam = mug.getObjectByName("mug_foam") ?? null;
      return {
        root: mug,
        foam,
        basePos: mug.position.clone(),
        baseRotY: rotY,
        foamBaseY: foam?.position.y ?? 0,
        sips: 0,
        anim: null,
      };
    };
    myMug = place(0.5, 2.12, -2.44); // beside my coins, handle turned out
    theirMug = place(0.5, -2.0, 2.4); // the opponent's, across the table
    markShadowsDirty(); // two new casters just landed on the table
  },
  undefined,
  (err) => console.error("Failed to load /mug.glb", err),
);

function setFoamSips(rig: MugRig, level: number): void {
  if (!rig.foam) return;
  const p = FOAM_SIPS[Math.min(level, 4)];
  rig.foam.visible = level < 4;
  rig.foam.scale.set(p.xz, p.y, p.xz);
  rig.foam.position.y = rig.foamBaseY - p.drop;
}

function applyFoam(rig: MugRig): void {
  setFoamSips(rig, rig.sips);
}

function drinkSip(rig: MugRig, kind: "sip" | "slam"): void {
  if (rig.anim || rig.sips >= 4) return;
  rig.anim = { start: performance.now(), kind };
  audio.gulp();
}

function resetMug(rig: MugRig | null): void {
  if (!rig) return;
  rig.sips = 0;
  rig.anim = null;
  rig.root.position.copy(rig.basePos);
  rig.root.rotation.set(0, rig.baseRotY, 0);
  applyFoam(rig);
}

/** Drive mug drink/slam animations each frame; the foam step lands at the
 *  tilt's peak so the shrink happens "while drinking". */
function updateMugs(now: number): void {
  for (const rig of [myMug, theirMug]) {
    if (!rig || !rig.anim) continue;
    const { start, kind } = rig.anim;
    const dur = kind === "slam" ? 1500 : 950;
    const t = (now - start) / dur;
    if (t >= 1) {
      rig.anim = null;
      rig.sips = kind === "slam" ? 4 : Math.min(rig.sips + 1, 4);
      applyFoam(rig);
      rig.root.position.copy(rig.basePos);
      rig.root.rotation.set(0, rig.baseRotY, 0);
      continue;
    }
    const maxTilt = kind === "slam" ? 1.9 : 1.15;
    let tilt: number;
    let lift: number;
    if (kind === "slam" && t > 0.62) {
      // the slam: drop fast from the deep tilt, small thud settle
      const d = (t - 0.62) / 0.38;
      tilt = maxTilt * (1 - d * d);
      lift = 0.55 * (1 - d) + (d > 0.9 ? -0.03 * Math.sin((d - 0.9) * 31) : 0);
    } else {
      const phase = kind === "slam" ? t / 0.62 : t;
      tilt = maxTilt * Math.sin(Math.min(phase, 1) * Math.PI * 0.5) * (kind === "sip" && t > 0.55 ? 1 - (t - 0.55) / 0.45 : 1);
      lift = (kind === "slam" ? 0.55 : 0.4) * Math.sin(Math.min(phase, 1) * Math.PI * 0.5) * (kind === "sip" && t > 0.55 ? 1 - (t - 0.55) / 0.45 : 1);
    }
    // Tilt about the WORLD x-axis, toward the drinker: my mug tips back
    // toward me (+z), theirs toward them (-z). Tilting the local axis of a
    // yawed mug sends it sideways into the table.
    const toward = rig === myMug ? 1 : -1;
    rig.root.quaternion
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), rig.baseRotY)
      .premultiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), toward * tilt),
      );
    rig.root.position.y = rig.basePos.y + lift;
    // foam sinks at the drink's peak (idempotent per frame past t=0.5)
    if (t > 0.5) setFoamSips(rig, kind === "slam" ? 4 : Math.min(rig.sips + 1, 4));
  }
}

// ---------------------------------------------------------------------------
// Token markers (8 cylinders — 4 per player)
// ---------------------------------------------------------------------------

const tokenGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.16, 24);
// Prototypes only — each marker clones one so materials stay independent.
// Ownership reads from Kasen's paint on the sculpts (your design red, the
// opponent's blue). Before the sculpts load, the placeholders use flat
// red/blue.
const p1Mat = new THREE.MeshStandardMaterial({ color: 0xc02020, roughness: 0.6 });
const p2Mat = new THREE.MeshStandardMaterial({ color: 0x2040c0, roughness: 0.6 });

const STONE_TINT = 0xdcd3c1; // soft bone; keeps the stones from reading pure white
/** Mirror matches only: the multiplier the OPPONENT's stones wear so two
 *  identical class sculpts read apart at a glance (see applyTokenGeometries).
 *  Cool slate — under it the warm reliefs go dusky while the sculpt stays
 *  legible; chosen against STONE_TINT's warm bone so the split is hue, not
 *  brightness (survives the iPad's reflective glass better). */
const MIRROR_FOE_TINT = 0x93a7c9;

interface TokenMarker {
  mesh: THREE.Mesh;
  target: THREE.Vector3;
  /** Last observed token.position — used to detect transitions:
   *    on-board → reserve   = captured (violent tumble to reserve)
   *    on-board → escaped   = escaped  (triumphant arc to escaped area) */
  lastPosition: number;
  /** Flight animation state. Used for both captures and escapes; the two
   *  visually differ via `flightArcHeight`, `flightSpinAxis`, `flightSpinSpeed`,
   *  and `flightDuration`. When true, position is driven by the flight arc;
   *  when false, normal lerp toward `target` applies. */
  flying: boolean;
  flightStart: number;
  flightDuration: number;
  flightArcHeight: number;
  flightFrom: THREE.Vector3;
  flightTo: THREE.Vector3;
  flightSpinAxis: THREE.Vector3;
  flightSpinSpeed: number;
}

const markers: TokenMarker[] = [];
for (let i = 0; i < 8; i++) {
  // Clone the prototype so this marker has its own material instance —
  // required for per-token emissive control (shield glow).
  const proto = i < 4 ? p1Mat : p2Mat;
  const mat = proto.clone();
  const mesh = new THREE.Mesh(tokenGeo, mat);
  mesh.visible = false;
  mesh.castShadow = true;
  scene.add(mesh);
  markers.push({
    mesh,
    target: new THREE.Vector3(),
    lastPosition: -1,
    flying: false,
    flightStart: 0,
    flightDuration: 0,
    flightArcHeight: 0,
    flightFrom: new THREE.Vector3(),
    flightTo: new THREE.Vector3(),
    flightSpinAxis: new THREE.Vector3(0, 1, 0),
    flightSpinSpeed: 0,
  });
}

// Sculpted token geometries (from pieces.glb): the red-design sculpt always
// goes to p1's tokens, the blue-design sculpt to p2's — a fixed physical
// property of the token, identical on both screens (unlike near/far row
// placement and the Red/Blue label, which stay viewer-relative).
let sculptedTokenGeos: { red: THREE.BufferGeometry; blue: THREE.BufferGeometry } | null = null;

// Master Killer class-token geometries (from pieces-mk.glb): per class, the
// red-team and blue-team fused sculpts — same blank stone, class relief
// (bow / crescent / shield) instead of blossom/star. Populated all-or-nothing
// by ensureMkPieces; until then (or forever, if the fetch fails) the classic
// sculpts stand in.
let classTokenGeos: Partial<
  Record<PlayerClass, { red: THREE.BufferGeometry; blue: THREE.BufferGeometry }>
> | null = null;

function applyTokenGeometries() {
  markers.forEach((marker, i) => {
    const owner: PlayerId = i < 4 ? "p1" : "p2";
    // Master Killer rooms: once a seat's class is known (class pick or the
    // authoritative power block), its four stones wear that class's sculpt.
    // Classic rooms, the tutorial, and the pre-pick moments keep blossom/
    // star; a missing pieces-mk.glb also falls back there — never an
    // invisible stone. Geometry pointer swap only: the marker's material
    // (team tint, ward/Bulwark emissive), raycast identity, and flight
    // state are untouched.
    const cls =
      myVariant === "masterKiller" ? currentPower?.classes[owner] ?? pickedClasses[owner] : null;
    const geos = (cls ? classTokenGeos?.[cls] : null) ?? sculptedTokenGeos;
    if (geos) marker.mesh.geometry = owner === "p1" ? geos.red : geos.blue;
  });
  // Mirror-match distinction (Kasen 2026-07-20): identical class sculpts on
  // both sides read confusable — the vertex paint carries the class relief
  // in the SAME colors for both teams (the red/blue variants differ only in
  // the base coin's decoration). In a mirror, the OPPONENT's four stones
  // take a cool slate multiplier over their vertex paint, viewer-relative:
  // YOUR stones always wear the true palette on your own screen. Applied
  // only once the sculpted materials are live (vertexColors on) — the
  // pre-load placeholder red/blue materials already tell the sides apart.
  {
    const p1c = myVariant === "masterKiller" ? currentPower?.classes.p1 ?? pickedClasses.p1 : null;
    const p2c = myVariant === "masterKiller" ? currentPower?.classes.p2 ?? pickedClasses.p2 : null;
    const mirror = p1c !== null && p1c === p2c;
    const me: PlayerId = myRole ?? "p1";
    markers.forEach((marker, i) => {
      const mat = marker.mesh.material as THREE.MeshStandardMaterial;
      if (!mat.vertexColors) return;
      const owner: PlayerId = i < 4 ? "p1" : "p2";
      mat.color.setHex(mirror && owner !== me ? MIRROR_FOE_TINT : STONE_TINT);
    });
  }
  markShadowsDirty(); // geometry swaps change the casters
}

const CAPTURE_FLIGHT_MS = 700;
const CAPTURE_ARC_HEIGHT = 1.4;
const ESCAPE_FLIGHT_MS = 1000;
const ESCAPE_ARC_HEIGHT = 2.4;
/** How long to wait after gameOver arrives before the win screen appears —
 *  gives the winning token time to complete its escape flight. */
const WIN_SCREEN_DELAY_MS = ESCAPE_FLIGHT_MS + 250;

// ---------------------------------------------------------------------------
// Coins
//
// Two sets of four, one per player, laid out like Soulframe's table: the
// viewer's blossom-marked coins sit in front of the camera, the opponent's
// star-marked coins across the board. Each new flip tumbles the CURRENT
// player's set; the number of coins landing design-face-up shows the flip.
// The rulebook / referee is still authoritative on the count — the client
// just decides randomly WHICH coins land marked-side up to represent it.
// ---------------------------------------------------------------------------

// Flat disc, design face up (+Y) — read directly by the top-down camera.
const coinGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.03, 32);

// Placeholder until the sculpted coins load — plain pale discs.
const coinPlaceholderMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.6 });

interface CoinAnim {
  mesh: THREE.Mesh;
  restPos: THREE.Vector3;
  isFlipping: boolean;
  startTime: number;
  duration: number;
  willShowMarked: boolean;
  spinTurns: number;
}

const COIN_REST_Y = -0.395; // resting on the tabletop
const MY_COIN_Z = 2.05;     // front of the shared camera view
const THEIR_COIN_Z = -1.95; // behind the far reserve row

// Coins rest as a loose little heap next to the player, not a spread-out row:
// a 2x2 cluster jittered in x/z (so the flat discs don't intersect) and
// stacked a few mm in y (so overlaps read as a stack, not z-fighting).
const COIN_PILE = [
  { dx: -0.18, dz: -0.16, dy: 0.000 },
  { dx: 0.17, dz: -0.18, dy: 0.022 },
  { dx: -0.14, dz: 0.17, dy: 0.044 },
  { dx: 0.19, dz: 0.15, dy: 0.066 },
];
const COIN_PILE_X = -0.5; // pile centered under the board's visual center

function makeCoinRow(z: number): CoinAnim[] {
  const row: CoinAnim[] = [];
  for (let i = 0; i < 4; i++) {
    const mesh = new THREE.Mesh(coinGeo, coinPlaceholderMat);
    const p = COIN_PILE[i];
    const restPos = new THREE.Vector3(COIN_PILE_X + p.dx, COIN_REST_Y + p.dy, z + p.dz);
    mesh.position.copy(restPos);
    mesh.castShadow = true;
    // Start at rest showing marked side up (rotation.x = 0).
    scene.add(mesh);
    row.push({
      mesh,
      restPos,
      isFlipping: false,
      startTime: 0,
      duration: 700,
      willShowMarked: true,
      spinTurns: 6,
    });
  }
  return row;
}

// Seat-relative like everything else: the viewer always flips the red
// blossom coins, the opponent always the blue star coins.
const myCoins = makeCoinRow(MY_COIN_Z);
const theirCoins = makeCoinRow(THEIR_COIN_Z);
const allCoins = [...myCoins, ...theirCoins];

// Soft gold glow pooled under each coin pile — a warm halo that makes the
// metal coins the eye-catching "action" spot on the table. A radial-gradient
// canvas texture on a flat plane, additively blended so it reads as light.
function makeGlowTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0.0, "rgba(255, 214, 130, 0.85)");
  grad.addColorStop(0.35, "rgba(240, 190, 96, 0.42)");
  grad.addColorStop(1.0, "rgba(240, 190, 96, 0.0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const glowTex = makeGlowTexture();
// Roll cue: a tight, steady warm halo hugging the player's coin pile —
// only shown while the pile waits to be tapped. No flicker, no table-wide
// pool; it just picks the coins out of the dark.
function makeTightGlowTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0.0, "rgba(255, 205, 130, 0.9)");
  grad.addColorStop(0.5, "rgba(255, 185, 105, 0.5)");
  grad.addColorStop(0.78, "rgba(255, 170, 90, 0.1)");
  grad.addColorStop(1.0, "rgba(255, 170, 90, 0.0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
// Movable-stone cue: a crisp ring with a soft pool of light inside it,
// stamped on the ground under each stone the current flip lets you move.
// Drawn in white — the gold lives on the material's color — so retinting
// (say, per class) stays a one-line change.
function makeEligibleRingTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  // Soft inner pool — the familiar "light on wood" language of the table.
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0.0, "rgba(255, 255, 255, 0.4)");
  grad.addColorStop(0.55, "rgba(255, 255, 255, 0.1)");
  grad.addColorStop(0.95, "rgba(255, 255, 255, 0.0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  // Crisp ring, feathered a couple of px by shadow blur so it never aliases.
  g.strokeStyle = "rgba(255, 255, 255, 0.95)";
  g.lineWidth = 7;
  g.shadowBlur = 6;
  g.shadowColor = "rgba(255, 255, 255, 0.9)";
  g.beginPath();
  g.arc(s / 2, s / 2, 93, 0, Math.PI * 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const myCoinGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(1.05, 1.05),
  new THREE.MeshBasicMaterial({
    map: makeTightGlowTexture(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.55,
  }),
);
myCoinGlow.rotation.x = -Math.PI / 2;
myCoinGlow.position.set(COIN_PILE_X, TABLE_Y + 0.006, MY_COIN_Z);
myCoinGlow.renderOrder = -1;
myCoinGlow.visible = false;
scene.add(myCoinGlow);

// Same cue under my mug while a celebratory swig is waiting to be drunk.
const myMugGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(0.95, 0.95),
  new THREE.MeshBasicMaterial({
    map: makeTightGlowTexture(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.5,
  }),
);
myMugGlow.rotation.x = -Math.PI / 2;
myMugGlow.position.set(0.5, TABLE_Y + 0.006, 2.12); // under my mug
myMugGlow.renderOrder = -1;
myMugGlow.visible = false;
scene.add(myMugGlow);

// Escaped-token tallies per REAL seat, updated from every state broadcast.
// A drop back to zero means a fresh match — mugs refill.
let escapedByOwner: { p1: number; p2: number } = { p1: 0, p2: 0 };

// Dev affordance (localhost only): ?sips=N pretends N of my tokens escaped
// so the mug flow can be exercised without playing a full game.
const debugSips =
  location.hostname === "localhost"
    ? Math.min(4, Number(new URLSearchParams(location.search).get("sips") ?? 0) || 0)
    : 0;

/** Swigs I've earned but not yet drunk. The 4th (victory) swig pours itself. */
function myAvailableSips(): number {
  if (!myMug || myMug.anim || myMug.sips >= 4) return 0;
  const mySide: PlayerId = myRole ?? "p1";
  const earned = Math.min(escapedByOwner[mySide] + debugSips, 4);
  return Math.max(0, earned - myMug.sips);
}

function handleEscapeChanges(now: { p1: number; p2: number }, exhumed = false): void {
  const mySide: PlayerId = myRole ?? "p1";
  const otherSide: PlayerId = mySide === "p1" ? "p2" : "p1";
  if (now.p1 < escapedByOwner.p1 || now.p2 < escapedByOwner.p2) {
    // Backwards tally: either a rematch (board reset — BOTH tallies land on
    // zero) or a Necromancer's Exhume dragging ONE escaped stone back
    // mid-match. Only the rematch refills the mugs — an Exhume must not
    // erase the sips already drunk. The tally still re-baselines below, so
    // the re-escape earns its swig again: the stone really crosses twice.
    // `exhumed` settles the one ambiguous overlap (the victim's ONLY escape
    // exhumed while the caster has none — a 0/0 that is not a reset).
    if (!exhumed && now.p1 === 0 && now.p2 === 0) {
      resetMug(myMug);
      resetMug(theirMug);
    }
  } else {
    // The opponent celebrates their own escapes (their tap on their screen;
    // an automatic swig on ours) once the escape flight has landed.
    if (now[otherSide] > escapedByOwner[otherSide]) {
      const total = now[otherSide];
      setTimeout(() => {
        if (theirMug) drinkSip(theirMug, total >= 4 ? "slam" : "sip");
      }, ESCAPE_FLIGHT_MS + 300);
    }
    // My 4th is the victory swig — it pours itself as part of the flourish.
    if (now[mySide] >= 4 && escapedByOwner[mySide] < 4) {
      setTimeout(() => {
        if (myMug) drinkSip(myMug, "slam");
      }, ESCAPE_FLIGHT_MS + 300);
    }
  }
  escapedByOwner = { ...now };
}

// ---------------------------------------------------------------------------
// The fire in the corner of the room — a warm flickering point light and a
// soft ember glow off past the table's edge (the crackle lives in audio.ts).
// ---------------------------------------------------------------------------
const fireCfg = {
  intensity: 40,
  flicker: 0.7,
  color: "#ff7a26",
  x: -6.8,
  y: 0.85,
  z: -4,
  size: 2.6,
  opacity: 1,
  crackle: 0.9,
};
const fireLight = new THREE.PointLight(0xff7a26, fireCfg.intensity, 11, 2);
fireLight.position.set(fireCfg.x, fireCfg.y, fireCfg.z);
scene.add(fireLight);
const fireSprite = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: glowTex,
    color: 0xff8630,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false, // keep the flame's current look — room fog must not dim it
  }),
);
fireSprite.position.set(fireCfg.x, fireCfg.y - 0.35, fireCfg.z);
fireSprite.scale.set(fireCfg.size, fireCfg.size * 0.73, 1);
scene.add(fireSprite);

// ---------------------------------------------------------------------------
// Movable-stone rings — the "tap here" affordance. One additive ground quad
// per stone (crisp gold ring + soft underglow), shown only under stones the
// current flip lets you move, breathing in sync through the shared material
// (see tick()). Living on the ground keeps the stone's emissive channel free
// for the ward/bulwark status tints.
// ---------------------------------------------------------------------------

/** Ring height: 8 mm above the tile stamp (stone base is target.y - 0.08). */
const ELIGIBLE_RING_Y_OFFSET = -0.072;
/** Tap-confirm pulse length — the "selection" flash on a committed move. */
const CONFIRM_PULSE_MS = 240;
const eligibleRingGeo = new THREE.PlaneGeometry(0.66, 0.66);
const eligibleRingMat = new THREE.MeshBasicMaterial({
  map: makeEligibleRingTexture(),
  color: 0xffc36a, // same gold family as the coin/mug cues — "tap here"
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false, // depthTest stays ON: the stone occludes its far arc
});
const ringMeshes: THREE.Mesh[] = markers.map(() => {
  const m = new THREE.Mesh(eligibleRingGeo, eligibleRingMat);
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 1;
  m.visible = false;
  scene.add(m);
  return m;
});
// The confirm pulse animates opacity alone, so it needs its own material.
const confirmRing = new THREE.Mesh(eligibleRingGeo, eligibleRingMat.clone());
confirmRing.rotation.x = -Math.PI / 2;
confirmRing.renderOrder = 1;
confirmRing.visible = false;
scene.add(confirmRing);
/** Start stamp of the running confirm pulse, or 0 when idle. */
let confirmStart = 0;

// ---------------------------------------------------------------------------
// Capture-hover glow — hovering an enemy token that one of your legal moves
// can take bathes it in a warm halo.
// ---------------------------------------------------------------------------

const hoverGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(0.66, 0.66),
  new THREE.MeshBasicMaterial({
    map: glowTex,
    color: 0xffa332, // deep gold — must read against the white stones
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
);
hoverGlow.rotation.x = -Math.PI / 2;
hoverGlow.visible = false;
hoverGlow.renderOrder = 1;
scene.add(hoverGlow);

/** Enemy token ids capturable by the current legal moves. */
const capturableIds = new Set<number>();

function hideHoverGlow() {
  hoverGlow.visible = false;
}

function updateCapturable(legalMoves: Move[] | null, isMyTurn: boolean) {
  capturableIds.clear();
  hideHoverGlow();
  if (!isMyTurn || !legalMoves) return;
  for (const m of legalMoves) for (const id of m.captures) capturableIds.add(id);
}

// Swap the placeholder cylinders for the painted sculpts once they load.
// Token ownership colors stay owned by the game (red/blue tint over the
// painted stone); the coins' look comes entirely from their vertex paint —
// the design face IS the marked side, so no result tinting is needed.
// If the load fails, the placeholders remain.
gltfLoader.load(
  PIECES_URL,
  (gltf) => {
    const geoOf = (name: string) =>
      (gltf.scene.getObjectByName(name) as THREE.Mesh | undefined)?.geometry;
    const tokenP1 = geoOf("token_p1");
    const tokenP2 = geoOf("token_p2");
    const coinRed = geoOf("coin_red");
    const coinBlue = geoOf("coin_blue");
    if (!tokenP1 || !tokenP2 || !coinRed || !coinBlue) {
      console.error("pieces.glb missing expected meshes", gltf.scene);
      return;
    }
    // Match the cylinders' pivot: local base at y = -0.08 so tokens sit at
    // the same height above the tile stamps as the placeholders did.
    for (const geo of [tokenP1, tokenP2]) {
      geo.computeBoundingBox();
      geo.translate(0, -0.08 - geo.boundingBox!.min.y, 0);
    }
    sculptedTokenGeos = { red: tokenP1, blue: tokenP2 };
    // The stone sculpts carry the paint (white stone + colored relief) —
    // show it as-is instead of the placeholders' flat ownership colors.
    for (const marker of markers) {
      const mat = marker.mesh.material as THREE.MeshStandardMaterial;
      mat.vertexColors = true;
      mat.color.setHex(STONE_TINT);
      mat.needsUpdate = true;
    }
    applyTokenGeometries();
    // Coins come out of the pipeline design-face-up (+Y), which is exactly
    // what the top-down camera wants: rotation.x = 0 rests design-up, and the
    // rotation.x tumble lands design-up (marked) or design-down (blank).
    // Kasen's coin GLB carries its own painted metal material — use it.
    const coinMat =
      (gltf.scene.getObjectByName("coin_red") as THREE.Mesh).material;
    for (const coin of myCoins) coin.mesh.geometry = coinRed;
    for (const coin of theirCoins) coin.mesh.geometry = coinBlue;
    for (const coin of allCoins) coin.mesh.material = coinMat;
    markShadowsDirty(); // stones + coins just became real casters
  },
  undefined,
  (err) => console.error("Failed to load", PIECES_URL, err),
);

// Fetch the Master Killer class tokens the FIRST time an MK room is seen
// (join, resume, or reload — classic rooms, the tutorial, and the menu never
// pay for it), so the sculpts are usually decoded before the class pick
// resolves. On any failure the classic sculpts simply remain.
let mkPiecesRequested = false;
function ensureMkPieces() {
  if (mkPiecesRequested) return;
  mkPiecesRequested = true;
  gltfLoader.load(
    PIECES_MK_URL,
    (gltf) => {
      const geoOf = (name: string) =>
        (gltf.scene.getObjectByName(name) as THREE.Mesh | undefined)?.geometry;
      const loaded: NonNullable<typeof classTokenGeos> = {};
      // Per-class tolerance (was all-or-nothing): a class whose sculpt
      // hasn't shipped in the glb yet simply keeps the classic blossom/star
      // (applyTokenGeometries' own fallback) instead of dragging every
      // OTHER class down with it — the seam that lets a new class's rules
      // ship ahead of (or without) its Blender relief.
      for (const cls of ["archer", "mage", "warrior", "necromancer", "cleric", "rogue"] as const) {
        const red = geoOf(`token_${cls}_red`);
        const blue = geoOf(`token_${cls}_blue`);
        if (!red || !blue) {
          console.warn(`pieces-mk.glb has no ${cls} sculpt — classic tokens for that class`);
          continue;
        }
        // Same pivot rule as pieces.glb: local base at y = -0.08.
        for (const geo of [red, blue]) {
          geo.computeBoundingBox();
          geo.translate(0, -0.08 - geo.boundingBox!.min.y, 0);
        }
        loaded[cls] = { red, blue };
      }
      classTokenGeos = loaded;
      // Idempotent copy of the pieces.glb marker-material upgrade — needed
      // in case this file wins the load race against pieces.glb (the class
      // sculpts carry vertex paint too).
      for (const marker of markers) {
        const mat = marker.mesh.material as THREE.MeshStandardMaterial;
        mat.vertexColors = true;
        mat.color.setHex(STONE_TINT);
        mat.needsUpdate = true;
      }
      applyTokenGeometries();
    },
    undefined,
    (err) => console.error("Failed to load", PIECES_MK_URL, err),
  );
}

function triggerCoinFlip(markedCount: number, set: CoinAnim[]) {
  bumpKinetic();
  const now = performance.now();
  // Pick markedCount coin indices uniformly at random to show the marked face.
  const indices = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const markedSet = new Set(indices.slice(0, markedCount));

  for (let i = 0; i < 4; i++) {
    set[i].isFlipping = true;
    set[i].startTime = now + Math.random() * 110;
    // A quick, readable tumble that settles — not a blur, not sluggish.
    set[i].duration = 680 + Math.random() * 220;
    set[i].willShowMarked = markedSet.has(i);
    set[i].spinTurns = 2 + Math.floor(Math.random() * 2); // 2 or 3 whole turns
  }
}

function updateCoins(now: number) {
  for (const coin of allCoins) {
    if (!coin.isFlipping) continue;
    const elapsed = now - coin.startTime;
    if (elapsed < 0) continue;
    if (elapsed >= coin.duration) {
      coin.mesh.rotation.x = coin.willShowMarked ? 0 : Math.PI;
      coin.mesh.position.y = coin.restPos.y;
      coin.isFlipping = false;
    } else {
      const t = elapsed / coin.duration;
      // Ease-out the spin so the coin tumbles fast off the table then slows
      // and settles onto its face — a real toss decelerates into landing,
      // rather than spinning at a constant rate and snapping to a stop.
      const spin = 1 - Math.pow(1 - t, 2.4);
      const finalRot = coin.willShowMarked ? 0 : Math.PI;
      coin.mesh.rotation.x = (coin.spinTurns * Math.PI * 2 + finalRot) * spin;
      // Toss arc that peaks early and drops back down as it settles.
      const lift = Math.sin(Math.pow(t, 0.85) * Math.PI);
      coin.mesh.position.y = coin.restPos.y + lift * 0.28;
    }
  }
}

/** `exhumed` = this broadcast carried a lastExhume, so a backwards escaped
 *  tally is a dragged-back stone, never a rematch (see handleEscapeChanges). */
function refreshMarkers(state: GameState, exhumed = false) {
  const reserveSlot = { p1: 0, p2: 0 };
  const escapedSlot = { p1: 0, p2: 0 };
  const now = performance.now();
  state.tokens.forEach((token, idx) => {
    const marker = markers[idx];
    marker.mesh.visible = true;
    // Ownership shows through the sculpt's relief design (and, before the
    // sculpts load, the placeholder's flat color) — nothing to recolor here.
    // (Emissive belongs to the status tints alone — see updateTokenTints();
    // move eligibility renders as ground rings in tick(), off the material.)

    // Slot counters stay keyed by the true owner; only the rendered side is
    // remapped so my tokens take the near red row on every client.
    let p;
    if (token.position === -1) {
      p = reservePos(viewSide(token.owner), reserveSlot[token.owner]++);
    } else if (token.position >= PATH_LENGTH) {
      p = escapedPos(viewSide(token.owner), escapedSlot[token.owner]++);
    } else {
      p = tileWorldPos(viewSide(token.owner), token.position);
    }
    marker.target.set(p.x, p.y, p.z);

    // Flight detection: any transition off the board is animated.
    const wasOnBoard =
      marker.lastPosition >= 0 && marker.lastPosition < PATH_LENGTH;
    const wasOnShield =
      marker.lastPosition >= 0 &&
      marker.lastPosition < PATH_LENGTH &&
      BOARD_LAYOUT[marker.lastPosition].type === "shield";
    const nowOnShield =
      token.position >= 0 &&
      token.position < PATH_LENGTH &&
      BOARD_LAYOUT[token.position].type === "shield";

    if (wasOnBoard && token.position === -1) {
      // Captured — violent random-axis tumble back to reserve.
      marker.flying = true;
      marker.flightStart = now;
      marker.flightDuration = CAPTURE_FLIGHT_MS;
      marker.flightArcHeight = CAPTURE_ARC_HEIGHT;
      marker.flightFrom.copy(marker.mesh.position);
      marker.flightTo.copy(marker.target);
      marker.flightSpinAxis
        .set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5)
        .normalize();
      marker.flightSpinSpeed = 5 + Math.random() * 4;
    } else if (wasOnBoard && token.position >= PATH_LENGTH) {
      // Escaped — triumphant high arc with a slow forward flip.
      marker.flying = true;
      marker.flightStart = now;
      marker.flightDuration = ESCAPE_FLIGHT_MS;
      marker.flightArcHeight = ESCAPE_ARC_HEIGHT;
      marker.flightFrom.copy(marker.mesh.position);
      marker.flightTo.copy(marker.target);
      // Forward flip around X axis reads as a dive / victory somersault.
      marker.flightSpinAxis.set(1, 0, 0);
      marker.flightSpinSpeed = 1.3 + Math.random() * 0.5;
    } else if (
      token.position !== marker.lastPosition &&
      token.position >= 0 &&
      token.position < PATH_LENGTH
    ) {
      // Normal move (including entering from the hand) — a quick low hop so
      // the piece clears the board rim and stays visible in flight instead
      // of lerping through geometry.
      marker.flying = true;
      marker.flightStart = now;
      marker.flightDuration = 380;
      marker.flightArcHeight = 0.38;
      marker.flightFrom.copy(marker.mesh.position);
      marker.flightTo.copy(marker.target);
      marker.flightSpinAxis.set(1, 0, 0);
      marker.flightSpinSpeed = 0; // no tumble — just the hop
    }

    marker.lastPosition = token.position;
  });

  // Beer bookkeeping: tally escaped tokens per seat and react to changes
  // (earned swigs, the opponent's auto-swig, rematch refills).
  const nowEscaped: { p1: number; p2: number } = { p1: 0, p2: 0 };
  for (const t of state.tokens) {
    if (t.position >= PATH_LENGTH) nowEscaped[t.owner]++;
  }
  handleEscapeChanges(nowEscaped, exhumed);
}

// ---------------------------------------------------------------------------
// Protection VFX — emissive tint alone stopped reading the moment the class
// sculpts took over the stones (teal emissive on a blue Warrior sculpt is
// invisible; Kasen's exact complaint on the 2026-07-17 iPad pass). Protected
// stones now wear a dedicated rig in the OWNING CLASS's canon color — the
// same hexes as the plate gems and targeting rings, so color = author:
//   Ward (Mage passive)        -> mage purple spinning rune-ring
//   Bulwark (Warrior cast)     -> warrior blue rune-ring + translucent dome
//   Sheltering on a shield tile -> faint still steel ring (information, not
//                                  spectacle — the tile art carries the rest)
// (The rig set had a fourth limb — Ward Breaker safety, table-gold ring —
// until the transient-safety mechanic itself was removed 2026-07-17.)
// Pool of 8 rigs assigned per broadcast in updateTokenTints, animated and
// stone-tracked in tick(). Classic rooms never assign any. Pure radial
// decals — no surface materials touched (the 2026-07-18 moiré revert was
// the tiled wood textures, not these).
// ---------------------------------------------------------------------------
type StatusKind = "ward" | "bulwark" | "vanish" | "shieldTile" | "thrall" | "soulClaim" | "blessed" | "wounded";
const STATUS_TINTS: Record<StatusKind, number> = {
  ward: 0xb45cff,
  bulwark: 0x3f83ff,
  // Vanish is Bulwark's exact protection under a Rogue cast (see
  // VANISH_COST's doc in master-killer.ts) — same rig/dome treatment, just
  // the class's own moonlit steel instead of warrior blue.
  vanish: 0x9fb4c9,
  shieldTile: 0xcfdcec,
  // Possession wears the necromancer's blood red — the enemy stone serving
  // the graveyard is marked in its master's color, not its owner's.
  thrall: 0xd94a45,
  // Soul Claim on a RESERVE stone — the rig loop overrides with the claim
  // owner's temperature; this entry just keeps the map total.
  soulClaim: 0xd94a45,
  // The cleric's consecrated gold (DOCK_RING_TINTS.cleric) — a live
  // blessing burns full gold; a wounded stone's broken light is the same
  // gold ashed down, so the pair reads as one story at a glance.
  blessed: 0xe0b341,
  wounded: 0x8a7448,
};
/** Dashed rune-ring, drawn white so the material color carries the class —
 *  deliberately a different visual language from the solid "movable" ring. */
function makeStatusRingTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const dashes = 12;
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.lineWidth = 9;
  g.shadowBlur = 7;
  g.shadowColor = "rgba(255,255,255,0.9)";
  for (let i = 0; i < dashes; i++) {
    const a0 = (i / dashes) * Math.PI * 2;
    g.beginPath();
    g.arc(s / 2, s / 2, 90, a0, a0 + (Math.PI * 2 / dashes) * 0.55);
    g.stroke();
  }
  g.shadowBlur = 0;
  g.strokeStyle = "rgba(255,255,255,0.35)";
  g.lineWidth = 2;
  g.beginPath();
  g.arc(s / 2, s / 2, 74, 0, Math.PI * 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
/** Chain-link ring for POSSESSION — visually distinct from the dashed
 *  rune-ring the other statuses wear: solid band with link ticks, the
 *  shackle around an enslaved stone. Drawn white; the material color
 *  carries the POSSESSOR's side temperature (warm = yours). */
function makeChainRingTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.shadowBlur = 6;
  g.shadowColor = "rgba(255,255,255,0.9)";
  g.lineWidth = 7;
  g.beginPath();
  g.arc(s / 2, s / 2, 88, 0, Math.PI * 2);
  g.stroke();
  // Chain links: short cross-ticks riding the band.
  g.lineWidth = 4;
  const links = 10;
  for (let i = 0; i < links; i++) {
    const a = (i / links) * Math.PI * 2;
    const x = s / 2 + Math.cos(a) * 88;
    const y = s / 2 + Math.sin(a) * 88;
    g.beginPath();
    g.arc(x, y, 8, 0, Math.PI * 2);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const chainRingTex = makeChainRingTexture();

// Sized so the dash ring (radius 90/256 of the plane) clearly CIRCLES a
// stone (Ø ~0.44) instead of hiding under it, yet stays inside one tile
// (pitch ~0.7) so a protected stone never smears onto its neighbors.
const statusRingGeo = new THREE.PlaneGeometry(0.94, 0.94);
const statusRingTex = makeStatusRingTexture();
const statusDomeGeo = new THREE.SphereGeometry(0.27, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
interface StatusRig {
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  dome: THREE.Mesh;
  domeMat: THREE.MeshBasicMaterial;
}
const STATUS_RIG_COUNT = 8;
const statusRigs: StatusRig[] = [];
for (let i = 0; i < STATUS_RIG_COUNT; i++) {
  const ringMat = new THREE.MeshBasicMaterial({
    map: statusRingTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(statusRingGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 1;
  ring.visible = false;
  const domeMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.12,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(statusDomeGeo, domeMat);
  dome.renderOrder = 2;
  dome.visible = false;
  scene.add(ring, dome);
  statusRigs.push({ ring, ringMat, dome, domeMat });
}
/** Which stones currently wear which protection — rebuilt per broadcast. */
const statusMarks: { idx: number; kind: StatusKind }[] = [];

// --- Corpse decals (necromancer rework) ------------------------------------
// A grave mark on the tile where the necromancer's last kill fell — visible
// to BOTH seats (the victim's re-entry-denial play depends on seeing it).
// One decal per seat (a necromancer mirror can hold two corpses at once).
// Position from tileWorldPos — corpse tiles are contested (4-11), the same
// physical square in either numbering.
function makeCorpseTexture(): THREE.CanvasTexture {
  // A tiny GRAVESTONE, not an X (Kasen 2026-07-20: the X read as
  // "forbidden", not "a corpse lies here") — rounded headstone on a mound,
  // drawn white so the material color carries the OWNER tint.
  const s = 128;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.fillStyle = "rgba(255,255,255,0.28)";
  g.shadowBlur = 6;
  g.shadowColor = "rgba(255,255,255,0.8)";
  g.lineWidth = 5;
  // The headstone: rounded top, planted just above center.
  g.beginPath();
  g.moveTo(46, 84);
  g.lineTo(46, 52);
  g.arc(64, 52, 18, Math.PI, 0);
  g.lineTo(82, 84);
  g.closePath();
  g.fill();
  g.stroke();
  // The mound it stands on.
  g.beginPath();
  g.moveTo(30, 88);
  g.quadraticCurveTo(64, 76, 98, 88);
  g.stroke();
  // A soul-mote drifting off the stone's shoulder.
  g.beginPath();
  g.arc(90, 40, 4, 0, Math.PI * 2);
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const corpseDecalGeo = new THREE.PlaneGeometry(0.5, 0.5);
const corpseDecalTex = makeCorpseTexture();
const corpseDecals: THREE.Mesh[] = (["p1", "p2"] as const).map(() => {
  const mat = new THREE.MeshBasicMaterial({
    map: corpseDecalTex,
    color: 0xd94a45, // the necromancer's blood red, canon
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(corpseDecalGeo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
});

// Floating countdown badges — the number of turns a possession has left
// rides ABOVE the enslaved stone itself (screen-projected DOM, one per
// possible thrall). Temperature matches the rest of the possession
// language: warm ring = yours, cold = the enemy's.
const thrallBadges = (["p1", "p2"] as const).map(() => {
  const el = document.createElement("div");
  el.className = "thrall-badge";
  document.body.appendChild(el);
  return el;
});

/** Sync the two corpse decals to the latest broadcast — called from
 *  updateTokenTints (the per-broadcast status pass). */
function updateCorpseDecals() {
  (["p1", "p2"] as PlayerId[]).forEach((side, i) => {
    const corpse = currentPower?.corpse?.[side] ?? null;
    const mesh = corpseDecals[i];
    if (!corpse) {
      mesh.visible = false;
      return;
    }
    // Ownership reads as temperature, viewer-relative: YOUR grave burns the
    // class's warm red; the ENEMY's grave is cold slate — unmistakable even
    // in a necromancer mirror with two graves on the row.
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(
      viewSide(side) === "p1" ? 0xd94a45 : 0x7e9bd6,
    );
    const pos = tileWorldPos(side, corpse.tile);
    mesh.position.set(pos.x, pos.y + 0.012, pos.z);
    mesh.visible = true;
  });
}

/** Master Killer only: mark warded / Bulwarked / Ward Breaker-safe /
 *  shield-tile-sheltered tokens for the protection rigs, plus a matching
 *  emissive lift on the sculpt itself. Reuses the real isWarded() from
 *  master-killer.ts against a minimal PowerState built from the public
 *  `power` field, so the client can never drift from the server's own
 *  definition of "warded". Bulwark's protected-ness is simpler — the server
 *  already hands over the exact token id list (bulwarkedTokenIds). Classic
 *  rooms (currentPower === null) always take the clear-everything branch —
 *  a no-op against the materials' own black-emissive default, so classic
 *  visuals are untouched. */
function updateTokenTints(state: GameState) {
  const bulwarked = currentPower ? new Set(currentPower.bulwarkedTokenIds) : null;
  const fakePower: PowerState | null = currentPower
    ? {
        classes: currentPower.classes,
        charges: currentPower.charges,
        reflipsUsedThisTurn: 0,
        shieldStreak: { p1: 0, p2: 0 },
        ultimateReady: { p1: false, p2: false },
        bulwarked: {},
        bulwarkSaves: {},
        // Real possession state, not a stub: isWarded consults it (a
        // possessed token is never warded), and the thrall tint below
        // reads it too. Vitality likewise real — the blessed/wounded
        // branches below key off it.
        corpse: currentPower.corpse ?? { p1: null, p2: null },
        thrall: currentPower.thrall ?? { p1: null, p2: null },
        vitality: currentPower.vitality ?? {},
      }
    : null;
  // Which token (if any) is currently a thrall — possession outranks every
  // other status read (a possessed stone can't be warded or Bulwarked by
  // rule, so the branches below are mutually exclusive by construction).
  const thrallIds = new Set<number>();
  if (currentPower?.thrall) {
    for (const side of ["p1", "p2"] as PlayerId[]) {
      const th = currentPower.thrall[side];
      if (th) thrallIds.add(th.tokenId);
    }
  }
  // Soul-Claimed reserve stones: the enemy necromancer's mark + a full
  // soul bank means this stone in your hand CANNOT be played — the exact
  // client mirror of the rulebook's Soul Claim entry gate. Map token id ->
  // the claiming side.
  const claimedBy = new Map<number, PlayerId>();
  for (const side of ["p1", "p2"] as PlayerId[]) {
    const corpse = currentPower?.corpse?.[side] ?? null;
    if (corpse && (currentPower?.charges?.[side] ?? 0) >= REVIVE_COST) {
      claimedBy.set(corpse.tokenId, side);
    }
  }
  statusMarks.length = 0;
  state.tokens.forEach((token, idx) => {
    const mat = markers[idx].mesh.material as THREE.MeshStandardMaterial;
    let kind: StatusKind | null = null;
    if (token.position === -1 && claimedBy.has(token.id)) {
      kind = "soulClaim";
      const claimer = claimedBy.get(token.id)!;
      mat.emissive.setHex(viewSide(claimer) === "p1" ? 0xd94a45 : 0x4f6cb0);
      mat.emissiveIntensity = 0.5;
    } else if (thrallIds.has(token.id)) {
      kind = "thrall";
      // The claim's temperature is the POSSESSOR's, viewer-relative: your
      // thrall burns warm, the enemy's glows cold — the necromancer-mirror
      // disambiguator.
      const owner = (["p1", "p2"] as PlayerId[]).find(
        (pl) => currentPower?.thrall?.[pl]?.tokenId === token.id,
      );
      mat.emissive.setHex(owner && viewSide(owner) === "p1" ? 0xd94a45 : 0x4f6cb0);
      mat.emissiveIntensity = 0.62;
    } else if (fakePower && isWarded(state, fakePower, token)) {
      kind = "ward";
      mat.emissive.setHex(0x8040ff); // violet — Mage ward
      mat.emissiveIntensity = 0.55;
    } else if (bulwarked && bulwarked.has(token.id)) {
      // Same underlying protection map (see VANISH_COST's doc); which
      // class cast it decides the color/label only.
      const vanished = currentPower?.classes[token.owner] === "rogue";
      kind = vanished ? "vanish" : "bulwark";
      mat.emissive.setHex(vanished ? 0x9fb4c9 : 0x2f6bff);
      mat.emissiveIntensity = 0.5;
    } else if (currentPower?.vitality?.[token.id] === "blessed" && token.position >= 0) {
      kind = "blessed";
      mat.emissive.setHex(0xe0b341); // consecrated gold — the second life burns
      mat.emissiveIntensity = 0.45;
    } else if (currentPower?.vitality?.[token.id] === "wounded" && token.position >= 0) {
      kind = "wounded";
      mat.emissive.setHex(0x8a7448); // ashed gold — the blessing broke, the scar shows
      mat.emissiveIntensity = 0.3;
    } else {
      if (
        currentPower &&
        token.position >= 0 &&
        token.position < PATH_LENGTH &&
        BOARD_LAYOUT[token.position].type === "shield"
      ) {
        kind = "shieldTile"; // rig only — no emissive, it's the quiet one
      }
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
    }
    if (kind && statusMarks.length < STATUS_RIG_COUNT) statusMarks.push({ idx, kind });
  });
  updateCorpseDecals();
}

// ---------------------------------------------------------------------------
// HUD + move buttons
// ---------------------------------------------------------------------------

const hud = document.getElementById("hud") as HTMLDivElement;
const status = document.getElementById("status") as HTMLDivElement;
const movesEl = document.getElementById("moves") as HTMLDivElement;

// --- Avatar plates (Hearthstone-style class frames) ---
// Bottom-left: my portrait + charge gems + turn glow. Top-right: the
// opponent's. Hidden outside Master Killer rooms. The plate is pure DISPLAY
// (who you are, how many charges you hold, whose turn it is); ability
// triggering lives in the Ability Dock (buildDock/updateDock below) — the
// gem-button row anchored off this plate's right shoulder.
const plateMe = document.getElementById("plate-me") as HTMLDivElement;
const plateThem = document.getElementById("plate-them") as HTMLDivElement;
const portraitMe = document.getElementById("portrait-me") as HTMLImageElement;
const portraitThem = document.getElementById("portrait-them") as HTMLImageElement;
const gemsMe = document.getElementById("gems-me") as HTMLDivElement;
const gemsThem = document.getElementById("gems-them") as HTMLDivElement;
const plateNameMe = document.getElementById("plate-name-me") as HTMLDivElement;
const plateNameThem = document.getElementById("plate-name-them") as HTMLDivElement;

// Gem sockets are PER-CLASS now: everyone banks CHARGE_CAP, but the
// necromancer's frame carries a third socket — the SOUL GEM, the pip only
// a kill can light (see NECRO_CHARGE_CAP's doc in master-killer.ts). Built
// on demand whenever a plate's class changes; starts as the common two.
function rebuildGemSockets(container: HTMLDivElement, cls: PlayerClass | null) {
  const cap = cls === "necromancer" ? NECRO_CHARGE_CAP : CHARGE_CAP;
  if (container.childElementCount === cap && (cap === CHARGE_CAP || container.querySelector(".soul"))) return;
  container.innerHTML = "";
  for (let i = 0; i < cap; i++) {
    const gem = document.createElement("span");
    gem.className = i >= CHARGE_CAP ? "gem soul" : "gem";
    container.appendChild(gem);
  }
}
for (const container of [gemsMe, gemsThem]) rebuildGemSockets(container, null);

/** Classes as known during the class-pick phase — lets each plate appear the
 *  moment its class is chosen, before the first state broadcast
 *  (currentPower) carries the authoritative power info. */
let pickedClasses: { p1: PlayerClass | null; p2: PlayerClass | null } = { p1: null, p2: null };

function setGems(container: HTMLDivElement, lit: number) {
  container.querySelectorAll(".gem").forEach((g, i) => g.classList.toggle("lit", i < lit));
}

/** Flash a plate's gems: "flare" on a charge gained, "spend" on one spent. */
function flashGems(container: HTMLDivElement, kind: "flare" | "spend") {
  container.classList.remove("flare", "spend");
  void container.offsetWidth; // restart the CSS animation
  container.classList.add(kind);
  setTimeout(() => container.classList.remove(kind), 900);
}

/** Sync both avatar plates (portrait, gems, name, turn glow). Each plate
 *  appears as soon as that side's class is KNOWN — during class pick that
 *  comes from pickedClasses; once the match is underway, currentPower is
 *  authoritative. Classic rooms take the hide branch. */
function updatePlates(state: GameState | null) {
  // Stones first: every path where class knowledge appears or vanishes
  // (class pick, replays, resyncs, seat/menu resets) already funnels through
  // here, so this one call keeps the board's token sculpts in sync too.
  applyTokenGeometries();
  // The Ability Dock rides the plate: any refresh that can change class or
  // charges (state replays, resyncs, class pick) re-syncs the dock too.
  updateDock();
  const mySide: PlayerId = myRole ?? "p1";
  const theirSide: PlayerId = mySide === "p1" ? "p2" : "p1";
  const mine = currentPower ? currentPower.classes[mySide] : pickedClasses[mySide];
  const theirs = currentPower ? currentPower.classes[theirSide] : pickedClasses[theirSide];
  if (myVariant !== "masterKiller" || (!mine && !theirs)) {
    plateMe.classList.remove("show", "turn");
    plateThem.classList.remove("show", "turn");
    return;
  }
  const live = state !== null && state.winner === null;
  if (mine) {
    plateMe.dataset.class = mine;
    const src = `/avatars/${mine}.webp`;
    if (!portraitMe.src.endsWith(src)) portraitMe.src = src;
    plateNameMe.textContent = classLabel(mine);
    rebuildGemSockets(gemsMe, mine);
    setGems(gemsMe, currentPower ? currentPower.charges[mySide] : 0);
    plateMe.classList.toggle("turn", live && state!.currentPlayer === mySide);
    plateMe.classList.add("show");
  } else {
    plateMe.classList.remove("show", "turn");
  }
  if (theirs) {
    plateThem.dataset.class = theirs;
    const src = `/avatars/${theirs}.webp`;
    if (!portraitThem.src.endsWith(src)) portraitThem.src = src;
    plateNameThem.textContent = classLabel(theirs);
    rebuildGemSockets(gemsThem, theirs);
    setGems(gemsThem, currentPower ? currentPower.charges[theirSide] : 0);
    plateThem.classList.toggle("turn", live && state!.currentPlayer !== mySide);
    plateThem.classList.add("show");
  } else {
    plateThem.classList.remove("show", "turn");
  }
}

let myRole: PlayerId | null = null;
let currentMoves: Move[] | null = null;
/** Every roll of the player's coins waits for a tap on their pile. */
let rollPending: { flip: number; legalMoves: Move[] | null; state: GameState } | null = null;

// --- Master Killer mode (additive; all null/"classic" in classic rooms) ---
let myVariant: "classic" | "masterKiller" = "classic";
/** Public class/charge/ward info — mirrors protocol.ts's `state.power`. */
let currentPower: {
  classes: Record<PlayerId, PlayerClass>;
  charges: Record<PlayerId, number>;
  pushTargets: number[];
  chargedShotTargets: number[];
  ultimateReady: Record<PlayerId, boolean>;
  blinkStrikeTargets: number[];
  warpathTargets: number[];
  bulwarkTargets: number[];
  bulwarkedTokenIds: number[];
  /** Optional (older servers omit it): how many Re-flips the current
   *  player has already fired this turn — gates the Re-flip button
   *  together with charges (see renderPowerActions). */
  reflipsUsedThisTurn?: number;
  /** Necromancer rework (2026-07-19): each player's banked corpse (only
   *  while raisable — the server hides a dead-lettered marker), the active
   *  possession, and where a Revive would rise for the CURRENT player
   *  (null = not castable) — the client's whole gem gate. Exhume's targets
   *  are the opponent's ESCAPED token ids, pushTargets' population rule. */
  corpse?: Record<PlayerId, { tokenId: number; tile: number } | null>;
  thrall?: Record<PlayerId, { tokenId: number; turnsLeft: number } | null>;
  reviveSpawnTile?: number | null;
  corpseExplosionTargets?: number[];
  exhumeTargets?: number[];
  /** Optional (older servers omit them): raw lifecycle numbers behind
   *  bulwarkedTokenIds and the streak — surfaced for the activity log's
   *  effects panel, never used for gameplay decisions client-side. */
  bulwarkTurns?: Record<number, number>;
  bulwarkSavesLeft?: Record<number, number>;
  shieldStreak?: Record<PlayerId, number>;
  /** Cleric (2026-07-21): Bless/Heal target pools for the CURRENT player
   *  (affordability baked in server-side — empty = not castable),
   *  Benediction's would-change pool (ultimateReady-gated), and every
   *  token's blessed/wounded state (public table-state — the gold rings
   *  both seats see). */
  blessTargets?: number[];
  healTargets?: number[];
  benedictionTargets?: number[];
  vitality?: Record<number, "blessed" | "wounded">;
  /** Rogue (2026-07-21, Vanish added 2026-07-22): Pickpocket target pool
   *  for the CURRENT player (affordability baked in server-side), Vanish's
   *  own OWN-stone pool (affordability NOT baked in — Bulwark's own
   *  convention, gate on charges client-side same as bulwarkTargets), and
   *  Grand Heist's ultimate pool (ultimateReady-gated). */
  pickpocketTargets?: number[];
  vanishTargets?: number[];
  grandHeistTargets?: number[];
} | null = null;
/** The current player's power-boosted move list (only populated on my own
 *  turn — same security rule as legalMoves). Kept alongside currentMoves
 *  (which gets the same array structurally, via tap-to-move) so Warrior's
 *  Charge buttons can read chargeAvailable/from/to per move. */
let currentPowerMoves: PowerMove[] | null = null;
/** Master Killer targeting — ONE mutually exclusive armed state for every
 *  aim-then-tap ability (the dock's gems arm it; the canvas tap consumes
 *  it). Arming anything disarms whatever else was armed, so Bulwark-vs-
 *  Reinforced exclusivity (and every other pairing) falls out for free.
 *  `targetIds` always come from the server's own lists — enemy tokens for
 *  Push/Charged Shot/ultimates, MY OWN tokens for Bulwark and Charge — and
 *  findTargetUnderPointer works over any of them regardless of owner. */
type ArmedKind =
  | "push"
  | "chargedShot"
  | "blinkStrike"
  | "warpath"
  | "bulwark"
  | "bulwarkReinforced"
  | "charge"
  | "bless"
  | "heal"
  | "pickpocket"
  | "vanish"
  | "grandHeist";
let armed: { kind: ArmedKind; targetIds: Set<number> } | null = null;
/** Warrior Charge: token id -> index into currentPowerMoves for every
 *  sweep-capable move of the current roll (rebuilt by updateDock). The
 *  server emits at most one PowerMove per token, so the map is
 *  unambiguous — and a Charge tap sends this INDEX, never move data. */
const chargeMoveIndexByToken = new Map<number, number>();

// --- Opening flip-off ---
/** True while the match start waits for THIS player to tap their pile.
 *  Reuses the same glow cue and tap target as the per-turn roll gate. */
let openingTapArmed = false;
/** Flips already animated this opening round (animate only the new ones). */
let seenOpeningFlips: { p1: number | null; p2: number | null } = { p1: null, p2: null };

/** Which physical side an owner renders on for THIS viewer. Every player
 *  sees their own tokens as Red on the near row and the opponent as Blue on
 *  the far row, regardless of their p1/p2 seat — so the seat only exists in
 *  the protocol, never on screen. Before the seat is known, assume p1. */
function viewSide(owner: PlayerId): PlayerId {
  return owner === (myRole ?? "p1") ? "p1" : "p2";
}

function setStatus(text: string, klass?: "ok" | "err") {
  status.textContent = text;
  status.className = klass ?? "";
}

// Display convention: 1-indexed tiles matching the user's mental model.
//   reserve      -> "off"
//   internal 0   -> "tile 1"    (first playable)
//   internal 14  -> "tile 15"   (finish)
//   internal 15  -> "OUT"       (escaped)
function tileLabel(pos: number): string {
  if (pos === -1) return "off";
  if (pos >= PATH_LENGTH) return "OUT";
  return `${pos + 1}`;
}

// Per-player token numbering: each player sees their own tokens as 1..4.
// Internal IDs 0..3 belong to p1, 4..7 belong to p2.
function tokenLabel(internalId: number): string {
  const perPlayer = (internalId % 4) + 1;
  return `tok${perPlayer}`;
}

function moveLabel(m: Move): string {
  const tags = [
    m.captures.length ? "CAPTURE" : "",
    m.landsOnShield ? "+SHIELD" : "",
    m.causesWin ? "WIN" : "",
  ].filter(Boolean).join(" ");
  return `${tokenLabel(m.tokenId)}: ${tileLabel(m.from)}→${tileLabel(m.to)}${tags ? " " + tags : ""}`;
}

function classLabel(cls: PlayerClass): string {
  return cls.charAt(0).toUpperCase() + cls.slice(1);
}

function renderHud(state: GameState, flip: number | null) {
  const yours = state.currentPlayer === myRole;
  const myColor = "Red"; // seat-relative: every player sees themselves as Red
  const turnLabel = yours
    ? `<b style="color:#ffd370">Your turn</b>`
    : `<b>Opponent's turn</b>`;
  // Class + charge info lives on the avatar plates now — the HUD keeps only
  // what the plates don't show: whose turn, and the current flip.
  hud.innerHTML = `
    <div>You: <b>${myColor}</b></div>
    <div>${turnLabel}</div>
    <div>Flip: <b>${flip ?? "—"}</b></div>
    ${state.winner ? `<div style="color:#ffd700">${state.winner === myRole ? "You win!" : "Opponent wins"}</div>` : ""}
  `;
}

/** Set of token IDs the current player can move this turn. Read every frame
 *  to drive the pulse highlight, and consulted on canvas taps to decide
 *  which tokens are eligible for a tap-to-move click. */
const eligibleTokenIds = new Set<number>();
/** Token ID -> index into `currentMoves`. Populated at the same time as
 *  eligibleTokenIds so a tap can look up the move to send. */
const moveIndexByToken = new Map<number, number>();

// --- Ability cards -----------------------------------------------------
// Hovering a dock gem (desktop) or holding one ~280ms (touch) opens a card
// above the gem that says what the ability actually does — cost, effect,
// edge cases — like any game's tooltip. A quick tap still fires/arms.
const ABILITY_INFO: Record<string, { name: string; cost: string; desc: string; klass: PlayerClass }> = {
  reflip: {
    name: "Re-flip",
    cost: "1 mana each · keeps your turn",
    klass: "mage",
    desc: `Don't like your roll? Flip all four coins again instead of moving — up to ${REFLIPS_PER_TURN} times a turn, one mana each. Mind your Ward: it only holds at full mana, so any re-flip from full drops it — unless the new flip is a zero, which pays the mana right back.`,
  },
  push: {
    name: "Push",
    cost: "1 mana",
    klass: "archer",
    desc: "Shove an enemy stone in shared water back one pace. Push it onto your own stone or off the board and it's sent home — and the mana comes right back.",
  },
  chargedShot: {
    name: "Charged Shot",
    cost: `${CHARGE_CAP} mana`,
    klass: "archer",
    desc: `A heavier shot: knock an enemy stone back ${CHARGED_SHOT_DISTANCE} paces — ${CHARGED_SHOT_WARD_DISTANCE} if Warded, the one shot that can reach a Warded stone. Send it home and one mana comes back.`,
  },
  charge: {
    name: "Charge",
    cost: "1 mana",
    klass: "warrior",
    desc: "Turn this move into a sweep: one enemy stone between your start and landing is captured too, Warded or not.",
  },
  bulwark: {
    name: "Bulwark",
    cost: "1 mana",
    klass: "warrior",
    desc: "Shield one of your own stones: it can't be captured or swept by a Charge — though an ultimate still punches through. Fades after a few turns, or the moment it saves the stone.",
  },
  bulwarkReinforced: {
    name: "Reinforced Bulwark",
    cost: `${CHARGE_CAP} mana`,
    klass: "warrior",
    desc: "A Bulwark with everything doubled: it lasts twice as many turns AND shrugs off the first save instead of fading — only the second save (or time) brings it down. A plain Push can't budge it; only a Charged Shot moves it.",
  },
  blinkStrike: {
    name: "Blink Strike",
    cost: "Ultimate · 3 shield landings in a row",
    klass: "mage",
    desc: "Teleport your furthest-along stone onto any enemy in shared water, capturing it — straight through shields, Wards, and Bulwarks.",
  },
  warpath: {
    name: "Warpath",
    cost: "Ultimate · 3 shield landings in a row",
    klass: "warrior",
    desc: "Teleport your least-advanced stone onto any enemy in shared water — capturing it and every enemy stone along the way, through shields, Wards, and Bulwarks.",
  },
  snipe: {
    name: "Snipe",
    cost: "Passive · always on",
    klass: "archer",
    desc: "Every landing in shared water also fells an unprotected enemy stone exactly one tile ahead of where you land — a free second capture, no mana, no aiming. Shields, Wards, and Bulwarks turn it.",
  },
  rainOfArrows: {
    name: "Rain of Arrows",
    cost: "Ultimate · fires on its own",
    klass: "archer",
    desc: "Chain three shield-tile landings in a row and the sky answers: the moment the third lands, arrows strike one random enemy in shared water down through every protection. No aiming, no spending — it simply happens.",
  },
  ward: {
    name: "Ward",
    cost: "Passive · while your mana is full",
    klass: "mage",
    desc: "While your mana is full, your most-advanced stone is shielded: it cannot be captured or targeted. Spend any mana and the Ward falls until you refill. Warriors, thralls, and ultimates pierce it.",
  },
  wardBreaker: {
    name: "Ward Breaker",
    cost: "Passive · always on",
    klass: "warrior",
    desc: "Wards mean nothing to you: landing on a Warded enemy breaks the Ward and captures it all the same, and your Charge sweep cuts through Warded stones too. Shield tiles and Bulwarks still hold.",
  },
  revive: {
    name: "Revive",
    cost: `${REVIVE_COST} mana · keeps your turn`,
    klass: "necromancer",
    desc: `Raise the enemy stone you last killed as your THRALL, on the very tile it died. For ${THRALL_TURNS} of your turns it fights for you — it moves on your flips, kills like any stone, and its blade ignores the Mage's Ward — but it can never leave shared water, and then it crumbles home. Your flip stands: the risen dead may be the one that moves.`,
  },
  corpseExplosion: {
    name: "Corpse Explosion",
    cost: `${CORPSE_EXPLOSION_COST} mana`,
    klass: "necromancer",
    desc: "Detonate the marked corpse instead of raising it: every unprotected enemy stone beside the grave is blasted one tile back — a blocked landing sends it all the way home. The blast desecrates the corpse (no thrall, no mana from its kills), and shields, Wards, and Bulwarks all turn it. The same grave, two rites: burn it now, or raise it at full mana.",
  },
  exhume: {
    name: "Exhume",
    cost: "Ultimate · 3 shield landings in a row",
    klass: "necromancer",
    desc: `Death honors no finish line: drag one of the opponent's ESCAPED stones back aboard at tile ${EXHUME_RETURN_POSITION + 1} — if that tile is taken it settles on the nearest free one behind — and it must sail the home stretch again. The one power that can undo an escape.`,
  },
  bless: {
    name: "Bless",
    cost: `${BLESS_COST} mana · keeps your turn`,
    klass: "cleric",
    desc: `A quick prayer over one of your stones: it gains a second life. The first blow that would kill it only WOUNDS it — the stone survives, the attacker gets nothing for the strike, and if they landed on its tile it staggers back to the nearest open water. Your turn continues: bless, then still make your move.`,
  },
  heal: {
    name: "Heal",
    cost: `${HEAL_COST} mana`,
    klass: "cleric",
    desc: "Lay hands on a WOUNDED stone and restore its blessing — ready to turn the next killing blow again. Mending takes your whole turn: a broken blessing is a real setback, not a free bounce-back.",
  },
  benediction: {
    name: "Benediction",
    cost: "Ultimate · 3 shield landings in a row",
    klass: "cleric",
    desc: "Bless your entire army on the board at once — every unblessed and wounded stone rises under the light together. The prayer takes the turn; the protection stays until broken.",
  },
  sanctifiedGround: {
    name: "Sanctified Ground",
    cost: "Passive · always on",
    klass: "cleric",
    desc: "The shield tiles are holy ground to you: every time one of your stones lands on one, ALL your wounded stones are mended back to blessed — on top of the extra turn and mana every shield landing already grants.",
  },
  // Passive — no dock slot (same rule as the Archer's Snipe), so nothing
  // opens this card yet; the entry keeps the tooltip copy in the one place
  // every ability's copy lives, ready for the guide/plate surfaces.
  soulHarvest: {
    name: "Soul Harvest",
    cost: "Passive · always on",
    klass: "necromancer",
    desc: `Your kills feed you: every enemy stone you send home pays ${REVIVE_COST} mana — filling even your third crystal, the Soul Gem, which no other income can touch — and leaves its corpse marked where it fell. While your mana is full, the marked body cannot rise on its own: the soul is yours until you spend it.`,
  },
  larceny: {
    name: "Larceny",
    cost: "Passive · always on",
    klass: "rogue",
    desc: `Every stone you send home pays twice: your own mana climbs as usual, and ${PICKPOCKET_STEAL} mana drains straight out of their pocket too. A wound doesn't count — only a real kill pays.`,
  },
  pickpocket: {
    name: "Pickpocket",
    cost: `${PICKPOCKET_COST} mana · keeps your turn`,
    klass: "rogue",
    desc: `Reach into an enemy stone's pocket in shared water and lift ${PICKPOCKET_STEAL} mana — no fight, no protection stops you, since nothing is actually striking the stone. Your turn continues: pick the pocket, then still make your move.`,
  },
  vanish: {
    name: "Vanish",
    cost: `${VANISH_COST} mana`,
    klass: "rogue",
    desc: "Slip one of your own stones into the shadows: it can't be captured, swept, or targeted by any ability — though an ultimate still finds it. Fades after a few turns, or the moment it saves the stone.",
  },
  grandHeist: {
    name: "Grand Heist",
    cost: "Ultimate · 3 shield landings in a row",
    klass: "rogue",
    desc: "Teleport your furthest-along stone onto any enemy in shared water and take it — straight through shields, Wards, and Bulwarks — then empty their ENTIRE bank on the spot. A capture and a robbery in the same breath.",
  },
};

const abilityTip = document.getElementById("ability-tip") as HTMLDivElement;
const abilityTipName = abilityTip.querySelector(".tip-name") as HTMLDivElement;
const abilityTipCost = abilityTip.querySelector(".tip-cost") as HTMLDivElement;
const abilityTipPips = abilityTip.querySelector(".tip-pips") as HTMLDivElement;
const abilityTipDesc = abilityTip.querySelector(".tip-desc") as HTMLDivElement;
const abilityTipWarn = abilityTip.querySelector(".tip-warn") as HTMLDivElement;

function showAbilityTip(ability: string, anchor: HTMLElement) {
  const info = ABILITY_INFO[ability];
  if (!info) return;
  abilityTipName.textContent = info.name;
  abilityTipCost.textContent = info.cost;
  abilityTipDesc.textContent = info.desc;
  // Cost pips mirror the dock button's (ultimates carry no pip row), and
  // Re-flip's card warns about the Ward while the Ward is actually up.
  const pipCost = DOCK_COST[ability] ?? 0;
  abilityTipPips.innerHTML = "<i></i>".repeat(pipCost);
  abilityTipPips.classList.toggle("show", pipCost > 0);
  abilityTipWarn.classList.toggle(
    "show",
    ability === "reflip" &&
      currentPower !== null &&
      currentPower.charges[myRole ?? "p1"] === CHARGE_CAP,
  );
  abilityTip.dataset.class = info.klass;
  const rect = anchor.getBoundingClientRect();
  // Centered over the button, clamped to the viewport edges.
  const half = 160;
  const x = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8);
  abilityTip.style.left = `${x}px`;
  abilityTip.style.bottom = `${window.innerHeight - rect.top + 10}px`;
  abilityTip.classList.add("show");
}

function hideAbilityTip() {
  abilityTip.classList.remove("show");
}

function renderMoves(legalMoves: Move[] | null, isMyTurn: boolean) {
  currentMoves = legalMoves;
  eligibleTokenIds.clear();
  moveIndexByToken.clear();
  if (isMyTurn && legalMoves) {
    for (let i = 0; i < legalMoves.length; i++) {
      eligibleTokenIds.add(legalMoves[i].tokenId);
      moveIndexByToken.set(legalMoves[i].tokenId, i);
    }
  }
  updateCapturable(legalMoves, isMyTurn);
  // No move buttons — tap-to-move via canvas raycast.
  movesEl.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Ability Dock — the plate-anchored gem buttons that trigger class powers.
//
// Built ONCE per class by buildDock() (state changes toggle CSS classes, so
// transitions animate instead of snapping); updateDock() re-reads
// currentPower / currentPowerMoves on every overlay and maps each ability
// onto the visual states the #dock CSS defines. Aim-then-tap abilities arm
// the single `armed` state above; the canvas pointerdown consumes it. The
// dock only ever sends ids/indexes from server-sent lists — trust model
// unchanged.
// ---------------------------------------------------------------------------

const dockEl = document.getElementById("dock") as HTMLDivElement;
const ribbonEl = document.getElementById("target-ribbon") as HTMLDivElement;
const ribbonIconEl = ribbonEl.querySelector(".ribbon-icon") as HTMLSpanElement;
const ribbonTextEl = ribbonEl.querySelector(".ribbon-text") as HTMLSpanElement;
const vignetteEl = document.getElementById("target-vignette") as HTMLDivElement;

/** Gem icons are the proc-banner SVG set (proc-icons.ts) — one shared
 *  iconography, so the gem you tap and the banner that celebrates it wear
 *  the same art. Every dock ability id is a ProcIconId by construction. */
/** Charge cost per ability — drives the pip rows here and on the card.
 *  Ultimates cost no charges (their price is the shield streak, telegraphed
 *  by the always-visible dormant slot), so they carry no pips. */
const DOCK_COST: Record<string, number> = {
  reflip: 1,
  push: 1,
  chargedShot: CHARGE_CAP,
  charge: 1,
  bulwark: 1,
  bulwarkReinforced: CHARGE_CAP,
  blinkStrike: 0,
  warpath: 0,
  revive: REVIVE_COST,
  corpseExplosion: CORPSE_EXPLOSION_COST,
  exhume: 0,
  snipe: 0,
  rainOfArrows: 0,
  ward: 0,
  wardBreaker: 0,
  soulHarvest: 0,
  bless: BLESS_COST,
  heal: HEAL_COST,
  benediction: 0,
  sanctifiedGround: 0,
  larceny: 0,
  pickpocket: PICKPOCKET_COST,
  vanish: VANISH_COST,
  grandHeist: 0,
};
/** Short names for the 10px labels under the gems (cards carry full names). */
const DOCK_NAMES: Record<string, string> = {
  reflip: "Re-flip",
  push: "Push",
  chargedShot: "Charged Shot",
  charge: "Charge",
  bulwark: "Bulwark",
  bulwarkReinforced: "Reinforced",
  blinkStrike: "Blink Strike",
  warpath: "Warpath",
  revive: "Revive",
  corpseExplosion: "Explosion",
  exhume: "Exhume",
  snipe: "Snipe",
  rainOfArrows: "Rain of Arrows",
  ward: "Ward",
  wardBreaker: "Ward Breaker",
  soulHarvest: "Soul Harvest",
  bless: "Bless",
  heal: "Heal",
  benediction: "Benediction",
  sanctifiedGround: "Sanctified",
  larceny: "Larceny",
  pickpocket: "Pickpocket",
  vanish: "Vanish",
  grandHeist: "Grand Heist",
};
/** Slot order per class. Ult slots are ALWAYS built — dormant until ready,
 *  so the goal is visible from turn one. Archer's ult (Rain of Arrows) is
 *  passive and gets no slot. */
const DOCK_SLOTS: Record<PlayerClass, { ability: string; ult?: boolean; passive?: boolean }[]> = {
  // EVERY class shows its FULL kit — passives included, leading the arc, and
  // the archer's auto-firing ultimate too (Kasen 2026-07-20: "you shouldn't
  // have to check your rulebook to be reminded of how to play your
  // character"). Passive slots never cast: a tap opens their card, and
  // their glow reflects the passive's LIVE condition (Ward lit only at a
  // full bank; Rain of Arrows lit one shield landing from firing).
  archer: [
    { ability: "snipe", passive: true },
    { ability: "push" },
    { ability: "chargedShot" },
    { ability: "rainOfArrows", ult: true, passive: true },
  ],
  mage: [
    { ability: "ward", passive: true },
    { ability: "reflip" },
    { ability: "blinkStrike", ult: true },
  ],
  warrior: [
    { ability: "wardBreaker", passive: true },
    { ability: "charge" },
    { ability: "bulwark" },
    { ability: "bulwarkReinforced" },
    { ability: "warpath", ult: true },
  ],
  necromancer: [
    { ability: "soulHarvest", passive: true },
    { ability: "corpseExplosion" },
    { ability: "revive" },
    { ability: "exhume", ult: true },
  ],
  cleric: [
    { ability: "sanctifiedGround", passive: true },
    { ability: "bless" },
    { ability: "heal" },
    { ability: "benediction", ult: true },
  ],
  rogue: [
    { ability: "larceny", passive: true },
    { ability: "pickpocket" },
    { ability: "vanish" },
    { ability: "grandHeist", ult: true },
  ],
};
/** Ground-ring tint while targeting — the caster's class color (the ring
 *  texture is drawn white so this is a plain material recolor, see tick()). */
const DOCK_RING_TINTS: Record<PlayerClass, number> = {
  archer: 0x3ddc65,
  mage: 0xb45cff,
  warrior: 0x3f83ff,
  // Blood red — necro theme is red, Kasen's 2026-07-19 canon call (portrait
  // and skull token lead; the ash-violet placeholder retired with it). Must
  // stay in lockstep with index.html's data-class="necromancer" blocks.
  necromancer: 0xd94a45,
  // Consecrated gold — the cleric's whole visual language (blessing rings,
  // wounded scars, dock gems). Lockstep with index.html's
  // data-class="cleric" blocks, same rule as the necromancer's.
  cleric: 0xe0b341,
  // Moonlit steel — the rogue's whole visual language (dock, ribbon, procs,
  // ability tip). Lockstep with index.html's data-class="rogue" blocks,
  // same rule as every other class's.
  rogue: 0x9fb4c9,
};
/** What the ribbon asks the player to do, per armed ability. */
const RIBBON_COPY: Record<ArmedKind, string> = {
  push: "tap a glowing enemy stone",
  chargedShot: "tap a glowing enemy stone",
  charge: "tap one of your glowing stones to sweep",
  bulwark: "tap one of your stones to shield",
  bulwarkReinforced: "tap one of your stones",
  blinkStrike: "tap an enemy to strike",
  warpath: "tap an enemy to end on",
  bless: "tap one of your stones to bless",
  heal: "tap a wounded stone to mend",
  pickpocket: "tap a glowing enemy stone",
  vanish: "tap one of your stones to hide it",
  grandHeist: "tap an enemy to strike",
};

/** Class the dock is currently built for — rebuild only on change. */
let dockClass: PlayerClass | null = null;
/** True when it's my turn, the flip is revealed, and no roll gate is up —
 *  the only time dock taps do anything. Mirrors the boolean the old
 *  #moves ability rail received. */
let dockActive = false;
/** Change detector: disarm only when the power situation ACTUALLY changed,
 *  so heartbeat polls (which re-apply the same overlay) stop wiping an
 *  armed state mid-aim. */
let dockKey = "";

function buildDock(cls: PlayerClass) {
  if (dockClass === cls) return;
  dockClass = cls;
  hideAbilityTip();
  dockEl.dataset.class = cls;
  dockEl.innerHTML = "";
  const slots = DOCK_SLOTS[cls];
  slots.forEach((slot, i) => {
    // Gems sit IN the plate's gold frame along the 11-to-2 o'clock arc
    // (clock angle, clockwise from 12: 11h = -30°, 2h = +60°), spread
    // evenly endpoints-inclusive. The slot carries only the unit vector;
    // CSS turns it into a rim position via --arc-r, so every breakpoint
    // rescales for free. The button keeps its own transform channel for
    // the shake/armed animations.
    const deg = slots.length === 1 ? 15 : -30 + (90 * i) / (slots.length - 1);
    const rad = (deg * Math.PI) / 180;
    const wrap = document.createElement("div");
    wrap.className = "dock-slot";
    wrap.style.setProperty("--ax", Math.sin(rad).toFixed(4));
    wrap.style.setProperty("--ay", (-Math.cos(rad)).toFixed(4));
    const btn = document.createElement("button");
    btn.className = `dock-btn${slot.ult ? " ult" : ""}${slot.passive ? " passive" : ""}`;
    btn.dataset.ability = slot.ability;
    const cost = DOCK_COST[slot.ability];
    btn.innerHTML =
      `<span class="dock-gem"><span class="dock-icon">${PROC_ICONS[slot.ability as ProcIconId]}</span>` +
      (slot.ability === "reflip"
        ? `<span class="dock-uses">${"<i></i>".repeat(REFLIPS_PER_TURN)}</span><span class="dock-warn"></span>`
        : "") +
      (cost > 0 ? `<span class="dock-cost">${"<i></i>".repeat(cost)}</span>` : "") +
      `</span><span class="dock-name">${DOCK_NAMES[slot.ability]}</span>`;
    wrap.appendChild(btn);
    dockEl.appendChild(wrap);
  });
}

type DockState = "ready" | "noafford" | "spent";
/** Pure affordability: can `ability` be cast RIGHT NOW, and if not, why.
 *  (Whether it's even my turn is the caller's `.off` gate, not this.) */
function abilityState(ability: string, charges: number, reflipsUsed: number): { state: DockState; reason?: string } {
  const p = currentPower!;
  const mySide: PlayerId = myRole ?? "p1";
  const needCharges = (n: number) => (n === 1 ? "Need 1 mana" : `Need ${n} mana`);
  switch (ability) {
    case "reflip":
      if (reflipsUsed >= REFLIPS_PER_TURN) return { state: "spent", reason: "No re-flips left this turn" };
      if (charges < 1) return { state: "noafford", reason: needCharges(1) };
      return { state: "ready" };
    case "push":
      if (charges < 1) return { state: "noafford", reason: needCharges(1) };
      if (p.pushTargets.length === 0) return { state: "noafford", reason: "No enemies in shared water" };
      return { state: "ready" };
    case "chargedShot":
      if (charges < CHARGE_CAP) return { state: "noafford", reason: needCharges(CHARGE_CAP) };
      if (p.chargedShotTargets.length === 0) return { state: "noafford", reason: "No enemies in shared water" };
      return { state: "ready" };
    case "charge":
      if (charges < 1) return { state: "noafford", reason: needCharges(1) };
      if (chargeMoveIndexByToken.size === 0) return { state: "noafford", reason: "No sweep on this roll" };
      return { state: "ready" };
    case "bulwark":
      if (charges < 1) return { state: "noafford", reason: needCharges(1) };
      if (p.bulwarkTargets.length === 0) return { state: "noafford", reason: "No stones to shield" };
      return { state: "ready" };
    case "bulwarkReinforced":
      if (charges < CHARGE_CAP) return { state: "noafford", reason: needCharges(CHARGE_CAP) };
      if (p.bulwarkTargets.length === 0) return { state: "noafford", reason: "No stones to shield" };
      return { state: "ready" };
    case "blinkStrike":
    case "warpath": {
      if (!p.ultimateReady[mySide]) return { state: "spent", reason: "Chain 3 shield landings to awaken" };
      const targets = ability === "blinkStrike" ? p.blinkStrikeTargets : p.warpathTargets;
      if (targets.length === 0) return { state: "noafford", reason: "No enemies in shared water" };
      return { state: "ready" };
    }
    // The server's reviveSpawnTile is the single oracle; the client only
    // decomposes WHY it's null into a teachable reason, in the order the
    // player can actually act on: free the slot, mark a corpse, fill the
    // soul bank.
    case "corpseExplosion": {
      if ((p.corpseExplosionTargets ?? []).length > 0) return { state: "ready" };
      if (!p.corpse?.[mySide]) return { state: "noafford", reason: "No corpse — kill to mark one" };
      if (charges < CORPSE_EXPLOSION_COST) return { state: "noafford", reason: `Need ${CORPSE_EXPLOSION_COST} mana` };
      return { state: "noafford", reason: "No enemies near the grave" };
    }
    case "revive": {
      if ((p.reviveSpawnTile ?? null) !== null) return { state: "ready" };
      if (p.thrall?.[mySide]) return { state: "noafford", reason: "Your thrall still serves" };
      if (!p.corpse?.[mySide]) return { state: "noafford", reason: "No corpse — kill to mark one" };
      if (charges < REVIVE_COST) return { state: "noafford", reason: `Need ${REVIVE_COST} mana` };
      return { state: "noafford", reason: "Revive not castable" };
    }
    case "exhume":
      if (!p.ultimateReady[mySide]) return { state: "spent", reason: "Chain 3 shield landings to awaken" };
      if ((p.exhumeTargets ?? []).length === 0) return { state: "noafford", reason: "No escaped enemies to drag back" };
      return { state: "ready" };
    case "bless": {
      if ((p.blessTargets ?? []).length > 0) return { state: "ready" };
      if (charges < BLESS_COST) return { state: "noafford", reason: needCharges(BLESS_COST) };
      return { state: "noafford", reason: "No stones to bless" };
    }
    case "heal": {
      if ((p.healTargets ?? []).length > 0) return { state: "ready" };
      if (charges < HEAL_COST) return { state: "noafford", reason: needCharges(HEAL_COST) };
      return { state: "noafford", reason: "No wounded stones" };
    }
    case "benediction":
      if (!p.ultimateReady[mySide]) return { state: "spent", reason: "Chain 3 shield landings to awaken" };
      if ((p.benedictionTargets ?? []).length === 0)
        return { state: "noafford", reason: "Your army is already blessed" };
      return { state: "ready" };
    case "pickpocket": {
      if ((p.pickpocketTargets ?? []).length > 0) return { state: "ready" };
      if (charges < PICKPOCKET_COST) return { state: "noafford", reason: needCharges(PICKPOCKET_COST) };
      return { state: "noafford", reason: "No mana worth taking nearby" };
    }
    case "vanish":
      if (charges < VANISH_COST) return { state: "noafford", reason: needCharges(VANISH_COST) };
      if ((p.vanishTargets ?? []).length === 0) return { state: "noafford", reason: "No stones to hide" };
      return { state: "ready" };
    case "grandHeist":
      if (!p.ultimateReady[mySide]) return { state: "spent", reason: "Chain 3 shield landings to awaken" };
      if ((p.grandHeistTargets ?? []).length === 0) return { state: "noafford", reason: "No enemies in shared water" };
      return { state: "ready" };
  }
  return { state: "noafford" };
}

/** Sync the dock to the latest power info. `active` mirrors the boolean the
 *  old ability rail took (my turn + flip revealed + roll gate down);
 *  omitted → keep the last value (plate-driven refreshes mid-turn). */
function updateDock(active?: boolean) {
  if (active !== undefined) dockActive = active;
  const mySide: PlayerId = myRole ?? "p1";
  const cls = myVariant === "masterKiller" && currentPower ? currentPower.classes[mySide] : null;
  if (!cls) {
    disarm();
    dockEl.classList.remove("show", "off");
    dockClass = null;
    dockKey = "";
    return;
  }
  buildDock(cls);
  dockEl.classList.add("show");
  dockEl.classList.toggle("off", !dockActive);

  const p = currentPower!;
  const charges = p.charges[mySide];
  // Off-turn the server's count describes the OPPONENT's turn — show my
  // Re-flip as unspent (full ticks) until my turn actually starts.
  const reflipsUsed = dockActive ? (p.reflipsUsedThisTurn ?? 0) : 0;

  // Warrior: which of my tokens can Charge this roll, with which move index.
  chargeMoveIndexByToken.clear();
  if (cls === "warrior" && currentPowerMoves) {
    for (let i = 0; i < currentPowerMoves.length; i++) {
      if (currentPowerMoves[i].chargeAvailable) chargeMoveIndexByToken.set(currentPowerMoves[i].tokenId, i);
    }
  }

  // Disarm only when the situation really changed — a heartbeat poll that
  // re-applies the same overlay must not wipe an armed state mid-aim.
  const key = [
    lastSeq,
    dockActive,
    cls,
    charges,
    reflipsUsed,
    p.ultimateReady[mySide],
    p.pushTargets.join(),
    p.chargedShotTargets.join(),
    p.blinkStrikeTargets.join(),
    p.warpathTargets.join(),
    p.bulwarkTargets.join(),
    p.reviveSpawnTile ?? "",
    (p.corpseExplosionTargets ?? []).join(),
    JSON.stringify(p.corpse ?? null),
    JSON.stringify(p.thrall ?? null),
    (p.exhumeTargets ?? []).join(),
    (p.blessTargets ?? []).join(),
    (p.healTargets ?? []).join(),
    (p.benedictionTargets ?? []).join(),
    JSON.stringify(p.vitality ?? null),
    [...chargeMoveIndexByToken.keys()].join(),
  ].join("|");
  if (key !== dockKey) {
    dockKey = key;
    disarm();
  }

  for (const btn of dockEl.querySelectorAll<HTMLButtonElement>(".dock-btn")) {
    const ability = btn.dataset.ability!;
    if (btn.classList.contains("passive")) {
      // Live-condition glow: Ward only while the bank is full; Rain of
      // Arrows when one shield landing from firing; the always-on
      // passives simply stay lit.
      const streak = p.shieldStreak?.[mySide] ?? 0;
      const on =
        ability === "ward"
          ? charges === CHARGE_CAP
          : ability === "rainOfArrows"
            ? streak >= 2
            : true;
      btn.classList.toggle("on", on);
      btn.dataset.state = "passive";
      btn.dataset.reason = "";
      continue;
    }
    const s = abilityState(ability, charges, reflipsUsed);
    // Off-turn the dock is glanceable, not judgmental: the whole row dims
    // (.off) and the per-button ready/noafford treatments stand down.
    btn.classList.toggle("ready", dockActive && s.state === "ready");
    btn.classList.toggle("noafford", dockActive && s.state === "noafford");
    btn.classList.toggle("spent", s.state === "spent");
    btn.dataset.state = s.state;
    btn.dataset.reason = s.reason ?? "";
    const cost = DOCK_COST[ability];
    btn.querySelectorAll(".dock-cost i").forEach((pip, i) => pip.classList.toggle("lit", i < Math.min(charges, cost)));
    if (ability === "reflip") {
      const remaining = Math.max(0, REFLIPS_PER_TURN - reflipsUsed);
      btn.querySelectorAll(".dock-uses i").forEach((tickEl, i) => tickEl.classList.toggle("lit", i < remaining));
      (btn.querySelector(".dock-warn") as HTMLSpanElement).classList.toggle("show", charges === CHARGE_CAP);
    }
  }
}

/** Enter targeting mode for `kind`: lock the gem, dim its siblings, raise
 *  the vignette + instruction ribbon, and re-point the ground rings at the
 *  target set in the caster's class color (see tick()). Arming over another
 *  armed ability just switches — one state, mutually exclusive. */
function armAbility(kind: ArmedKind) {
  if (!currentPower || !dockActive) return;
  disarm();
  const p = currentPower;
  const ids = new Set<number>(
    kind === "push"
      ? p.pushTargets
      : kind === "chargedShot"
        ? p.chargedShotTargets
        : kind === "blinkStrike"
          ? p.blinkStrikeTargets
          : kind === "warpath"
            ? p.warpathTargets
            : kind === "charge"
              ? [...chargeMoveIndexByToken.keys()]
              : kind === "bless"
                ? (p.blessTargets ?? [])
                : kind === "heal"
                  ? (p.healTargets ?? [])
                  : kind === "pickpocket"
                    ? (p.pickpocketTargets ?? [])
                    : kind === "vanish"
                      ? (p.vanishTargets ?? [])
                      : kind === "grandHeist"
                        ? (p.grandHeistTargets ?? [])
                        : p.bulwarkTargets, // bulwark / bulwarkReinforced
  );
  if (ids.size === 0) return;
  armed = { kind, targetIds: ids };
  for (const btn of dockEl.querySelectorAll<HTMLButtonElement>(".dock-btn")) {
    btn.classList.toggle("armed", btn.dataset.ability === kind);
    btn.classList.toggle("dim", btn.dataset.ability !== kind);
  }
  ribbonEl.dataset.class = dockClass ?? "";
  ribbonIconEl.innerHTML = PROC_ICONS[kind];
  ribbonTextEl.innerHTML =
    `<b>${ABILITY_INFO[kind].name}</b> — ${RIBBON_COPY[kind]} ` +
    `<span class="ribbon-hint">· tap elsewhere to cancel</span>`;
  ribbonEl.classList.add("show");
  vignetteEl.classList.add("show");
}

/** Leave targeting mode — idempotent, safe to call with nothing armed. */
function disarm() {
  armed = null;
  for (const btn of dockEl.querySelectorAll(".dock-btn")) btn.classList.remove("armed", "dim");
  ribbonEl.classList.remove("show");
  vignetteEl.classList.remove("show");
  hideHoverGlow();
}

/** The ONLY place armed casts become wire messages — every shape is an id
 *  or an index into a server-sent list, per the trust model. */
function fireArmed(tokenId: number) {
  if (!armed) return;
  const kind = armed.kind;
  switch (kind) {
    case "push":
      sendToServer({ type: "usePower", action: { kind: "push", targetTokenId: tokenId } });
      break;
    case "chargedShot":
      sendToServer({ type: "usePower", action: { kind: "chargedShot", targetTokenId: tokenId } });
      break;
    case "blinkStrike":
      sendToServer({ type: "usePower", action: { kind: "blinkStrike", targetTokenId: tokenId } });
      break;
    case "warpath":
      sendToServer({ type: "usePower", action: { kind: "warpath", targetTokenId: tokenId } });
      break;
    case "bulwark":
      sendToServer({ type: "usePower", action: { kind: "bulwark", tokenId } });
      break;
    case "bulwarkReinforced":
      sendToServer({ type: "usePower", action: { kind: "bulwark", tokenId, reinforced: true } });
      break;
    case "charge": {
      const moveIndex = chargeMoveIndexByToken.get(tokenId);
      if (moveIndex !== undefined) sendToServer({ type: "usePower", action: { kind: "charge", moveIndex } });
      break;
    }
    case "bless":
      sendToServer({ type: "usePower", action: { kind: "bless", targetTokenId: tokenId } });
      break;
    case "heal":
      sendToServer({ type: "usePower", action: { kind: "heal", targetTokenId: tokenId } });
      break;
    case "pickpocket":
      sendToServer({ type: "usePower", action: { kind: "pickpocket", targetTokenId: tokenId } });
      break;
    case "vanish":
      sendToServer({ type: "usePower", action: { kind: "vanish", tokenId } });
      break;
    case "grandHeist":
      sendToServer({ type: "usePower", action: { kind: "grandHeist", targetTokenId: tokenId } });
      break;
  }
  flashDockButton(kind, "fired");
}

/** Restartable one-shot CSS animation on a dock button. */
function flashDockButton(ability: string, anim: "fired" | "shake") {
  const btn = dockEl.querySelector<HTMLButtonElement>(`.dock-btn[data-ability="${ability}"]`);
  if (!btn) return;
  btn.classList.remove(anim);
  void btn.offsetWidth; // restart the CSS animation from frame 0
  btn.classList.add(anim);
  setTimeout(() => btn.classList.remove(anim), anim === "fired" ? 320 : 420);
}

// --- Dock input: tap to arm/fire, hold to peek the ability card ------------
/** Hold a gem this long to peek its card instead of casting. */
const HOLD_MS = 280;
let peekTimer = 0;
let peeking = false;
/** Set when a hold-to-peek just ended, so the release's click doesn't cast. */
let suppressDockClick = false;

dockEl.addEventListener("pointerdown", (e) => {
  if (viewingHistory()) return; // board frozen on a historical frame
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".dock-btn");
  if (!btn) return;
  suppressDockClick = false;
  clearTimeout(peekTimer);
  peekTimer = window.setTimeout(() => {
    peeking = true;
    showAbilityTip(btn.dataset.ability!, btn);
  }, HOLD_MS);
});
function endDockPeek() {
  clearTimeout(peekTimer);
  if (peeking) {
    peeking = false;
    hideAbilityTip();
    suppressDockClick = true;
  }
}
dockEl.addEventListener("pointerup", endDockPeek);
dockEl.addEventListener("pointercancel", endDockPeek);
dockEl.addEventListener("pointerleave", endDockPeek);
// iOS long-press must not pop the selection callout over the gems.
dockEl.addEventListener("contextmenu", (e) => e.preventDefault());

// Desktop: hovering a gem shows its card, like any game tooltip. Peeking
// deliberately works in every state — off-turn and unaffordable included.
dockEl.addEventListener("pointerover", (e) => {
  if (!window.matchMedia("(hover: hover)").matches) return;
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".dock-btn");
  if (btn) showAbilityTip(btn.dataset.ability!, btn);
});
dockEl.addEventListener("pointerout", (e) => {
  if (!window.matchMedia("(hover: hover)").matches) return;
  const to = (e as PointerEvent).relatedTarget as HTMLElement | null;
  if (!to || !to.closest(".dock-btn")) hideAbilityTip();
});

dockEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".dock-btn");
  if (!btn) return;
  if (suppressDockClick) {
    suppressDockClick = false;
    return; // that was a peek release, not a cast
  }
  const ability = btn.dataset.ability!;
  if (btn.classList.contains("passive")) {
    // Passives never cast — a tap IS the explainer (works off-turn too).
    hideAbilityTip();
    showAbilityTip(ability, btn);
    return;
  }
  if (dockEl.classList.contains("off")) return; // glanceable, never tappable
  hideAbilityTip();
  if (btn.dataset.state !== "ready") {
    // Can't cast: headshake + the reason, so the gate teaches itself.
    flashDockButton(ability, "shake");
    if (btn.dataset.reason) showAnnouncement(btn.dataset.reason, "skip", 1400);
    return;
  }
  if (ability === "reflip") {
    // Fires instantly — no target to pick, and the Ward-drop badge already
    // warned (speed over confirm friction). The roll gate re-arms via the
    // usual pendingFlipSeq path, so the player taps their coins again.
    sendToServer({ type: "usePower", action: { kind: "reflip" } });
    flashDockButton(ability, "fired");
    return;
  }
  if (ability === "exhume") {
    // Fires instantly too, Re-flip's precedent: every escaped enemy stone
    // is equivalent (they sit in one pile past the prow and the server's
    // occupancy walk decides the landing), so a board tap would be a choice
    // carrying no information. The id still comes from the server's own
    // exhumeTargets list — trust model unchanged.
    const t = currentPower?.exhumeTargets?.[0];
    if (t !== undefined) {
      sendToServer({ type: "usePower", action: { kind: "exhume", targetTokenId: t } });
      flashDockButton(ability, "fired");
    }
    return;
  }
  if (ability === "revive") {
    // Instant as well: the corpse fully determines what rises and where
    // (reviveSpawnTile gated `ready` above), so there is nothing to aim.
    sendToServer({ type: "usePower", action: { kind: "revive" } });
    flashDockButton(ability, "fired");
    return;
  }
  if (ability === "corpseExplosion") {
    // Instant: the marked corpse is the epicenter — nothing to aim.
    sendToServer({ type: "usePower", action: { kind: "corpseExplosion" } });
    flashDockButton(ability, "fired");
    return;
  }
  if (ability === "benediction") {
    // Instant, Revive's precedent: the pool is "your whole unblessed
    // on-board army" — a board tap would be a choice carrying no
    // information. The server re-validates against the shared oracle.
    sendToServer({ type: "usePower", action: { kind: "benediction" } });
    flashDockButton(ability, "fired");
    return;
  }
  if (armed?.kind === ability) disarm(); // re-tap the armed gem = cancel
  else armAbility(ability as ArmedKind);
});

// Cancel affordances beyond tap-outside: the ribbon's ✕ and Escape.
(document.getElementById("ribbon-cancel") as HTMLButtonElement).addEventListener("click", () => disarm());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && armed) disarm();
});

movesEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  // "Play Again" branch. No more per-move buttons live here.
  if (btn.dataset.newmatch) {
    sendToServer({ type: "newMatch" });
    movesEl.innerHTML = "";
    return;
  }
});

// ---------------------------------------------------------------------------
// Tap-to-move — raycast from pointer into scene, choose the topmost hit
// among eligible tokens, send its move.
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function findEligibleMeshUnderPointer(clientX: number, clientY: number): number | null {
  if (eligibleTokenIds.size === 0) return null;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = markers.map((m) => m.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  for (const hit of hits) {
    const tokenIdx = meshes.indexOf(hit.object as THREE.Mesh);
    if (tokenIdx !== -1 && eligibleTokenIds.has(tokenIdx)) {
      return tokenIdx;
    }
  }
  return null;
}

/** Generous hit zone around my mug — a swig should never miss. */
function isMyMugUnderPointer(clientX: number, clientY: number): boolean {
  if (!myMug) return false;
  const v = myMug.basePos.clone();
  v.y += 0.35; // aim at the mug's belly, not the table
  v.project(camera);
  const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
  return Math.hypot(clientX - sx, clientY - sy) < 110;
}

// ---------------------------------------------------------------------------
// Status cards — the Hearthstone rule: every mark on the board explains
// itself on a tap. Tapping a stone that ISN'T an actionable move target (or
// tapping the grave decal) pops the same card the dock's gems use, filled
// with that status's copy and its LIVE numbers (thrall turns left, Bulwark
// turns/saves). Kasen's 2026-07-20 report: "you never know what the icons
// mean or what's happening."
// ---------------------------------------------------------------------------
let infoCardTimer = 0;
function showInfoCardAt(clientX: number, clientY: number, info: { name: string; cost: string; desc: string; klass: string }) {
  abilityTipName.textContent = info.name;
  abilityTipCost.textContent = info.cost;
  abilityTipDesc.textContent = info.desc;
  abilityTipPips.classList.remove("show");
  abilityTipWarn.classList.remove("show");
  abilityTip.dataset.class = info.klass;
  const half = 160;
  const x = Math.min(Math.max(clientX, half + 8), window.innerWidth - half - 8);
  abilityTip.style.left = `${x}px`;
  abilityTip.style.bottom = `${window.innerHeight - clientY + 24}px`;
  abilityTip.classList.add("show");
  clearTimeout(infoCardTimer);
  infoCardTimer = window.setTimeout(hideAbilityTip, 4500);
}

/** Raycast over ALL visible stones (not just eligible ones). */
function findAnyTokenUnderPointer(clientX: number, clientY: number): number | null {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const list = markers.map((_, i) => i).filter((i) => markers[i].mesh.visible);
  const meshes = list.map((i) => markers[i].mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? list[meshes.indexOf(hits[0].object as THREE.Mesh)] : null;
}

/** The tapped grave decal's owner, if any. */
function findCorpseDecalUnderPointer(clientX: number, clientY: number): PlayerId | null {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const visible = corpseDecals.filter((m) => m.visible);
  const hits = raycaster.intersectObjects(visible, false);
  if (!hits.length) return null;
  return corpseDecals.indexOf(hits[0].object as THREE.Mesh) === 0 ? "p1" : "p2";
}

/** The explainer for whatever status the tapped stone wears, live numbers
 *  included — null for an unmarked stone. */
function statusCardFor(idx: number): { name: string; cost: string; desc: string; klass: string } | null {
  const mark = statusMarks.find((m) => m.idx === idx);
  if (!mark || !currentPower) return null;
  const tokenId = idx; // token ids are array-ordered 0-7 by construction
  switch (mark.kind) {
    case "thrall": {
      const side = (["p1", "p2"] as PlayerId[]).find((p) => currentPower!.thrall?.[p]?.tokenId === tokenId);
      const th = side ? currentPower.thrall?.[side] : null;
      const mine = side === (myRole ?? "p1");
      const n = th?.turnsLeft ?? 0;
      return {
        name: "Thrall",
        cost: `serves ${n} more turn${n === 1 ? "" : "s"}`,
        klass: "necromancer",
        desc: `This fallen stone fights for ${mine ? "YOU" : "the enemy Necromancer"}: it moves on ${mine ? "your" : "their"} coin flips, kills like any stone, and its blade ignores the Mage's Ward. It can never leave shared water — when its service ends it crumbles back to its owner's hand. Kill it early to end the possession.`,
      };
    }
    case "ward":
      return {
        name: "Warded",
        cost: "while the Mage holds full mana",
        klass: "mage",
        desc: "The Mage's most-advanced stone is shielded: it cannot be captured or targeted — except by a Warrior's Ward Breaker, a thrall's blade, or an ultimate. The Ward falls the moment the Mage spends any mana.",
      };
    case "bulwark": {
      const turns = currentPower.bulwarkTurns?.[tokenId];
      const saves = currentPower.bulwarkSavesLeft?.[tokenId];
      return {
        name: saves !== undefined ? "Reinforced Bulwark" : "Bulwark",
        cost: `${turns ?? "?"} turn${turns === 1 ? "" : "s"} left${saves !== undefined ? ` · ${saves} save${saves === 1 ? "" : "s"}` : ""}`,
        klass: "warrior",
        desc: `A Warrior's shield stands over this stone: it cannot be captured or swept, and no Push or Charged Shot can send it home${saves !== undefined ? " — and a plain Push can't budge it at all" : ""}. Ultimates still punch through. It fades when its turns run out${saves !== undefined ? " or its saves are spent" : " or the moment it blocks a capture"}.`,
      };
    }
    case "vanish": {
      const turns = currentPower.bulwarkTurns?.[tokenId];
      return {
        name: "Vanished",
        cost: `${turns ?? "?"} turn${turns === 1 ? "" : "s"} left`,
        klass: "rogue",
        desc: "The Rogue has slipped this stone into the shadows: it cannot be captured, swept, or targeted by any ability. Ultimates still punch through. It fades when its turns run out or the moment it blocks a capture.",
      };
    }
    case "soulClaim": {
      const claimer = (["p1", "p2"] as PlayerId[]).find(
        (pl) => currentPower?.corpse?.[pl]?.tokenId === tokenId,
      );
      const theirs = claimer && viewSide(claimer) !== "p1";
      return {
        name: "Soul Claimed",
        cost: "cannot re-enter play",
        klass: "necromancer",
        desc: theirs
          ? "The enemy Necromancer holds this stone's soul: while their mana stays full, it cannot leave your hand. The claim lapses the moment they spend any mana — or resolves when they detonate or raise the corpse."
          : "You hold this stone's soul: while your mana stays full, it cannot re-enter the enemy's hand. Spend any mana and they may reclaim it.",
      };
    }
    case "shieldTile":
      return {
        name: "Shield Tile",
        cost: "safe ground",
        klass: "warrior",
        desc: "A stone standing here cannot be captured, and LANDING here grants an extra turn plus a mana. Chain three shield landings in a row to awaken your ultimate.",
      };
    case "blessed":
      return {
        name: "Blessed",
        cost: "a second life · until broken",
        klass: "cleric",
        desc: "This stone carries the Cleric's blessing: the first blow that would kill it only WOUNDS it — the stone survives (staggering back if the attacker needs its tile), and the attacker earns just one mana for breaking the light. A blessed stone's own strikes carry the light through the Mage's Ward. Ultimates still kill it outright.",
      };
    case "wounded":
      return {
        name: "Wounded",
        cost: "the blessing is broken",
        klass: "cleric",
        desc: "This stone's blessing broke absorbing a killing blow. It fights on with one life like any mortal stone — until the Cleric spends a turn to Heal it, mends it by landing on a shield tile, or blesses the army anew with Benediction.",
      };
  }
  return null;
}

canvas.addEventListener("pointerdown", (e) => {
  if (viewingHistory()) {
    // Board taps are dead while scrubbing — pulse the banner as the answer.
    historyBanner.style.transform = "translateX(-50%) scale(1.06)";
    setTimeout(() => (historyBanner.style.transform = "translateX(-50%)"), 140);
    return;
  }
  // Opening flip-off: same tap target and glow as the roll gate.
  if (openingTapArmed) {
    if (isMyCoinUnderPointer(e.clientX, e.clientY)) {
      openingTapArmed = false;
      sendToServer({ type: "openingFlip" });
      hud.innerHTML = `<div>Flip for first move</div><div>Flipping…</div>`;
    }
    return;
  }
  // Master Killer: an ability is armed — this tap either picks a target or
  // cancels. Either way it never falls through to sips/roll/move handling.
  // (Dock and ribbon taps land on their own DOM buttons, never here.)
  if (armed) {
    const target = findTargetUnderPointer(armed.targetIds, e.clientX, e.clientY);
    if (target !== null) fireArmed(target);
    disarm(); // fired or missed — targeting mode ends (tap-outside cancels)
    return;
  }
  // A waiting swig: tap the mug, drink to the stone you brought home.
  if (myAvailableSips() > 0 && isMyMugUnderPointer(e.clientX, e.clientY)) {
    const mySide: PlayerId = myRole ?? "p1";
    const earned = Math.min(escapedByOwner[mySide] + debugSips, 4);
    drinkSip(myMug!, earned >= 4 && myMug!.sips === 3 ? "slam" : "sip");
    return;
  }
  // Roll gate: your flip happens when you tap your coin pile.
  if (rollPending) {
    if (isMyCoinUnderPointer(e.clientX, e.clientY)) {
      const pending = rollPending;
      rollPending = null;
      triggerCoinFlip(pending.flip, myCoins);
      renderHud(pending.state, pending.flip);
      renderMoves(pending.legalMoves, true);
      updateDock(true);
      if (pending.legalMoves && pending.legalMoves.length > 0)
        coach(
          "move",
          "Now tap a glowing stone to sail it that many paces. Your route: down your shore, up the shared middle, then back home to the dock.",
        );
    }
    return;
  }
  const tokenId = findEligibleMeshUnderPointer(e.clientX, e.clientY);
  if (tokenId === null) {
    // Not an actionable stone — every MARK explains itself on a tap:
    // statuses first (they sit on stones), then the grave decal.
    hideAbilityTip();
    const idx = findAnyTokenUnderPointer(e.clientX, e.clientY);
    const card = idx !== null ? statusCardFor(idx) : null;
    if (card) {
      showInfoCardAt(e.clientX, e.clientY, card);
      return;
    }
    const graveSide = findCorpseDecalUnderPointer(e.clientX, e.clientY);
    if (graveSide) {
      const mine = graveSide === (myRole ?? "p1");
      showInfoCardAt(e.clientX, e.clientY, {
        name: "Marked Corpse",
        cost: mine ? "your kill lies here" : "the enemy's kill lies here",
        klass: "necromancer",
        desc: mine
          ? "The stone you killed here is marked. Spend 2 mana on Corpse Explosion to blast everything beside this grave, or all 3 on Revive to raise it as your thrall — right on this tile. While your mana is full, its owner cannot bring it back."
          : "The enemy Necromancer killed a stone here and marked its corpse. If their mana dips below full, re-enter that stone from your hand to reclaim the soul — otherwise expect an explosion from this grave, or the corpse rising against you.",
      });
      return;
    }
    return;
  }
  const moveIdx = moveIndexByToken.get(tokenId);
  if (moveIdx === undefined) return;
  sendToServer({ type: "chooseMove", moveIndex: moveIdx });
  // Confirm flash: the tapped stone's ring pops outward as the move commits.
  const cm = markers[tokenId];
  confirmRing.position.set(
    cm.mesh.position.x,
    cm.target.y + ELIGIBLE_RING_Y_OFFSET,
    cm.mesh.position.z,
  );
  confirmRing.scale.setScalar(1);
  (confirmRing.material as THREE.MeshBasicMaterial).opacity = 0.85;
  confirmRing.visible = true;
  confirmStart = performance.now();
  // Immediate feedback: clear eligibility + hover glow this frame.
  eligibleTokenIds.clear();
  moveIndexByToken.clear();
  capturableIds.clear();
  hideHoverGlow();
});

// Cursor + hover feedback: pointer style over an eligible token, and a warm
// halo under a capturable enemy token.
/** Which of `ids` (token indices) is under the pointer, if any — shared by
 *  capture-hover and Master Killer's Push targeting. */
function findTargetUnderPointer(ids: Set<number>, clientX: number, clientY: number): number | null {
  if (ids.size === 0) return null;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const list = [...ids].filter((i) => markers[i].mesh.visible);
  const meshes = list.map((i) => markers[i].mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? list[meshes.indexOf(hits[0].object as THREE.Mesh)] : null;
}

function findCapturableUnderPointer(clientX: number, clientY: number): number | null {
  return findTargetUnderPointer(capturableIds, clientX, clientY);
}

function isMyCoinUnderPointer(clientX: number, clientY: number): boolean {
  // Generous hit zone: anywhere near the pile counts — clicking the gap
  // between the four coins must still roll.
  const v = new THREE.Vector3(COIN_PILE_X, COIN_REST_Y, MY_COIN_Z).project(camera);
  const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
  if (Math.hypot(clientX - sx, clientY - sy) < 115) return true;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(myCoins.map((c) => c.mesh), false).length > 0;
}

canvas.addEventListener("pointermove", (e) => {
  const hit = findEligibleMeshUnderPointer(e.clientX, e.clientY);
  const capturable = findCapturableUnderPointer(e.clientX, e.clientY);
  // Whatever ability is armed: one lookup over its own target set.
  const armedTarget = armed ? findTargetUnderPointer(armed.targetIds, e.clientX, e.clientY) : null;
  const rollable =
    ((rollPending !== null || openingTapArmed) && isMyCoinUnderPointer(e.clientX, e.clientY)) ||
    (myAvailableSips() > 0 && isMyMugUnderPointer(e.clientX, e.clientY));
  canvas.style.cursor =
    hit !== null || capturable !== null || armedTarget !== null || rollable ? "pointer" : "default";
  const glowTarget = armedTarget ?? capturable;
  if (glowTarget !== null) {
    const m = markers[glowTarget];
    hoverGlow.position.set(m.target.x, m.target.y - 0.062, m.target.z);
    hoverGlow.visible = true;
  } else {
    hideHoverGlow();
  }
});

function showPlayAgainButton() {
  movesEl.innerHTML = `<button data-newmatch="1" class="play-again">Play Again</button>`;
}

// ---------------------------------------------------------------------------
// Win screen overlay
// ---------------------------------------------------------------------------

const winScreen = document.getElementById("win-screen") as HTMLDivElement;
const winTitle = document.getElementById("win-title") as HTMLHeadingElement;
const winSubtitle = document.getElementById("win-subtitle") as HTMLDivElement;
const winFlavor = document.getElementById("win-flavor") as HTMLDivElement;
const winStats = document.getElementById("win-stats") as HTMLDivElement;
const winPlayAgainBtn = document.getElementById("win-play-again") as HTMLButtonElement;
const winCloseBtn = document.getElementById("win-close") as HTMLButtonElement;

interface GameOverStats {
  turns: number;
  captures: { p1: number; p2: number };
}

function showWinScreen(winner: PlayerId, stats: GameOverStats) {
  const iWon = myRole !== null && winner === myRole;
  const winnerColor = playerLabel(winner);
  winTitle.textContent = iWon ? "You won!" : "You lost";
  winTitle.className = iWon ? "won" : "lost";
  winSubtitle.textContent = `${winnerColor} escaped all four tokens first`;
  // One tavern beat for CPU games; empty in PvP (the .flavor div hides itself).
  winFlavor.textContent =
    inCpuGame && cpuDifficulty
      ? iWon
        ? { easy: "The Tipsy Patron slides off the stool.", standard: "The Barkeep tips their cap.", hard: "The Champion yields the table." }[cpuDifficulty]
        : { easy: "Even the Tipsy Patron has their night.", standard: "The Barkeep keeps the table.", hard: "The Champion drinks well tonight." }[cpuDifficulty]
      : "";

  const opponent: PlayerId = myRole === "p1" ? "p2" : "p1";
  const yourCaps = myRole ? stats.captures[myRole] : 0;
  const theirCaps = myRole ? stats.captures[opponent] : 0;
  winStats.innerHTML = `
    <div class="label">Turns played</div><div class="value">${stats.turns}</div>
    <div class="label">Your captures</div><div class="value">${yourCaps}</div>
    <div class="label">Opponent captures</div><div class="value">${theirCaps}</div>
  `;
  winScreen.classList.add("show");
}

function hideWinScreen() {
  winScreen.classList.remove("show");
}

winPlayAgainBtn.addEventListener("click", () => {
  hideWinScreen();
  sendToServer({ type: "newMatch" });
  movesEl.innerHTML = "";
});
winCloseBtn.addEventListener("click", () => {
  hideWinScreen();
  // Fall back to the bottom Play Again button so there's always a way forward.
  showPlayAgainButton();
});

// ---------------------------------------------------------------------------
// Audio unlock + mute toggle
// ---------------------------------------------------------------------------

const muteToggle = document.getElementById("mute-toggle") as HTMLButtonElement;
const volumeSlider = document.getElementById("volume") as HTMLInputElement;
volumeSlider.value = localStorage.getItem("regatta-volume") ?? "20";
audio.setVolume(Number(volumeSlider.value) / 100);
volumeSlider.addEventListener("input", () => {
  audio.setVolume(Number(volumeSlider.value) / 100);
  localStorage.setItem("regatta-volume", volumeSlider.value);
});

// Autoplay policy: audio can only start after SOME user gesture. The first
// tap/click anywhere unlocks the context, and the already-requested music
// starts immediately. No overlay — just the mute button on screen.
window.addEventListener("pointerdown", () => audio.unlock(), { once: true });
audio.startMusic();
// iOS — worst in the installed PWA — parks the AudioContext in an
// "interrupted" state on every app switch (and can reject the first resume
// outright), then never auto-recovers. Re-kick the whole chain on every
// gesture and on return to the foreground; no-op while healthy.
window.addEventListener("pointerdown", () => audio.resumeIfNeeded());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) audio.resumeIfNeeded();
});
window.addEventListener("pageshow", () => audio.resumeIfNeeded());

// ---------------------------------------------------------------------------
// App feel: on the first tap, go fullscreen + lock landscape where the
// browser allows it (Chrome/Android, most desktop). Browsers forbid
// auto-fullscreen without a gesture, and iOS Safari has no Fullscreen API at
// all — there the manifest ("Add to Home Screen") is the real app path, so
// we fail silently and just rely on the rotate hint. An ✕ exits fullscreen.
// ---------------------------------------------------------------------------
const fsExit = document.getElementById("fs-exit") as HTMLButtonElement;
const rotateHint = document.getElementById("rotate-hint") as HTMLDivElement;

function isPhone(): boolean {
  return (
    /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent) &&
    Math.min(window.innerWidth, window.innerHeight) < 820
  );
}

async function enterAppMode(): Promise<void> {
  const el = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>;
  };
  try {
    if (!document.fullscreenElement) {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    }
  } catch { /* unsupported (iOS Safari) — ignore */ }
  try {
    const orient = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
    };
    if (orient?.lock) await orient.lock("landscape");
  } catch { /* not lockable (desktop, iOS) — ignore */ }
}

function updateRotateHint(): void {
  const portrait = window.innerHeight > window.innerWidth;
  rotateHint.classList.toggle("show", isPhone() && portrait);
}
window.addEventListener("resize", updateRotateHint);
window.addEventListener("orientationchange", updateRotateHint);
updateRotateHint();

document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("fs", !!document.fullscreenElement);
});
fsExit.addEventListener("click", (e) => {
  e.stopPropagation();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
});

// First real interaction enters app mode (only worth it on phones; on desktop
// a game in fullscreen with no window chrome is more annoying than helpful).
if (isPhone()) {
  window.addEventListener("pointerdown", () => void enterAppMode(), { once: true });
}

// The audio button opens the volume popout; the icon tracks the level.
// Dragging to zero is the mute — one control, no separate mute state.
const railEl = document.getElementById("rail") as HTMLDivElement;
function updateAudioIcon() {
  const v = Number(volumeSlider.value);
  muteToggle.textContent = v === 0 ? "🔇" : v < 40 ? "🔈" : "🔊";
}
muteToggle.addEventListener("click", () => {
  railEl.classList.toggle("audio-open");
});
volumeSlider.addEventListener("input", () => {
  audio.setMuted(false); // any slider touch un-mutes; zero IS the mute
  updateAudioIcon();
});
updateAudioIcon();
// Tapping the board puts the popout (and any open ability card) away.
canvas.addEventListener("pointerdown", () => {
  railEl.classList.remove("audio-open");
  hideAbilityTip();
  exitConfirm.classList.remove("show");
});

// The door out — back to the main menu, with a "you sure?" beat first so a
// stray tap can't abandon a live match. Leaving clears the saved seat, so
// the next load doesn't auto-resume a table we walked away from. Solo games
// (CPU and tutorial) also offer Restart: fresh game, same mode — a tutorial
// restarts its coaching from the very top.
const exitToggle = document.getElementById("exit-toggle") as HTMLButtonElement;
const exitConfirm = document.getElementById("exit-confirm") as HTMLDivElement;
const exitRestart = document.getElementById("exit-restart") as HTMLButtonElement;
exitToggle.addEventListener("click", () => {
  exitRestart.style.display = inCpuGame ? "" : "none"; // no restarting an opponent
  exitConfirm.classList.toggle("show");
});
(document.getElementById("exit-no") as HTMLButtonElement).addEventListener("click", () => {
  exitConfirm.classList.remove("show");
});
(document.getElementById("exit-yes") as HTMLButtonElement).addEventListener("click", () => {
  exitConfirm.classList.remove("show");
  resetToMenu("");
});
exitRestart.addEventListener("click", () => {
  exitConfirm.classList.remove("show");
  const wasTutorial = tutorialMode;
  const variant = myVariant; // resetToMenu wipes these — capture first
  const difficulty = cpuDifficulty ?? undefined; // keep the same foe on restart
  resetToMenu("");
  menuEl.classList.remove("show"); // straight into the fresh game, no menu flash
  tutorialMode = wasTutorial;
  coachShown.clear();
  sendToServer({ type: "join", mode: "cpu", variant, difficulty });
});

// ---------------------------------------------------------------------------
// In-match chat (PvP only). The chat button lives in the rail; it's shown
// only in PvP rooms (no one to talk to vs the CPU). Rendering is textContent-
// only — never innerHTML — so a chat line can never inject markup.
// ---------------------------------------------------------------------------
const chatToggle = document.getElementById("chat-toggle") as HTMLButtonElement;
const chatPanel = document.getElementById("chat-panel") as HTMLDivElement;
const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;

function renderChat(log: { seat: PlayerId; text: string }[]) {
  chatLog.innerHTML = "";
  if (log.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Say hello…";
    chatLog.appendChild(empty);
    return;
  }
  for (const m of log) {
    const mine = m.seat === myRole;
    const line = document.createElement("div");
    line.className = `line ${mine ? "me" : "them"}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = mine ? "You:" : "Opponent:";
    const body = document.createElement("span");
    body.textContent = m.text; // textContent → no HTML injection
    line.append(who, body);
    chatLog.appendChild(line);
  }
  chatLog.scrollTop = chatLog.scrollHeight; // stick to newest
}

function openChat() {
  chatPanel.classList.add("open");
  chatToggle.classList.remove("unread");
  chatInput.focus();
}
chatToggle.addEventListener("click", () => {
  if (chatPanel.classList.contains("open")) chatPanel.classList.remove("open");
  else openChat();
});
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendToServer({ type: "chat", text });
  chatInput.value = "";
});

/** Show the chat affordance only in PvP; reset its state between matches. */
function setChatAvailable(pvp: boolean) {
  chatToggle.classList.toggle("show", pvp);
  if (!pvp) {
    chatPanel.classList.remove("open");
    chatToggle.classList.remove("unread");
    chatLog.innerHTML = "";
    chatInput.value = "";
  }
}

// ---------------------------------------------------------------------------
// Announcement banner
//
// Renders a short, high-contrast message in the center of the screen after
// each turn transition — so silent auto-skips and "did the game just give
// me an extra turn?" moments become fully visible. Also invaluable for
// spotting rulebook bugs: if the banner says "shield" on a non-shield tile,
// something's wrong.
// ---------------------------------------------------------------------------

const announce = document.getElementById("announce") as HTMLDivElement;
let announceTimer: number | null = null;

function showAnnouncement(text: string, klass?: string, ms = 1800) {
  if (announceTimer !== null) clearTimeout(announceTimer);
  announce.textContent = text;
  announce.className = `show ${klass ?? ""}`;
  announceTimer = window.setTimeout(() => {
    announce.className = "";
    announceTimer = null;
  }, ms);
}

// --- Ability proc banner (Master Killer) -----------------------------------
// The flashy class-colored callout ("Reroll!", "Warpath!") that pops center
// screen when a power fires. It rides the same state events as the detail
// banner above, so both players see every proc — the caster and the victim.
const procEl = document.getElementById("proc") as HTMLDivElement;
const procText = procEl.querySelector(".proc-text") as HTMLDivElement;
const procIcon = procEl.querySelector(".proc-icon") as HTMLDivElement;

/** Paint one proc RIGHT NOW — queue-internal; everyone else calls showProc. */
function displayProc(klass: PlayerClass, text: string, icon: ProcIconId) {
  procEl.dataset.class = klass;
  procText.textContent = text;
  // Static trusted strings from proc-icons.ts only — never server-derived.
  procIcon.innerHTML = PROC_ICONS[icon];
  procIcon.dataset.icon = icon; // ultimates upscale via a CSS attribute hook
  procEl.classList.remove("show");
  void procEl.offsetWidth; // restart the CSS animation from frame 0
  procEl.classList.add("show");
}

// Batched event replay (a bot turn + the next flip answered by one poll, or
// an iPad returning from the background) used to call the banner back-to-back
// and only the LAST proc survived the restart — the visible banner was
// routinely the OTHER player's event in the other player's color. Queue
// instead: show immediately when idle, otherwise hold each proc for a
// readable beat. Capped — a long catch-up drops the OLDEST, newest info wins.
const PROC_SPACING_MS = 950; // pop-in settles ~360ms in; hold runs to 1560ms
const PROC_QUEUE_CAP = 3;
let procQueue: Array<{ klass: PlayerClass; text: string; icon: ProcIconId }> = [];
let procBusyUntil = 0;
let procDrainTimer: number | null = null;

function showProc(klass: PlayerClass, text: string, icon: ProcIconId) {
  bumpKinetic();
  const now = performance.now();
  if (now >= procBusyUntil && procQueue.length === 0) {
    displayProc(klass, text, icon);
    procBusyUntil = now + PROC_SPACING_MS;
    return;
  }
  if (procQueue.length >= PROC_QUEUE_CAP) procQueue.shift();
  procQueue.push({ klass, text, icon });
  if (procDrainTimer === null) {
    procDrainTimer = window.setTimeout(drainProcQueue, Math.max(0, procBusyUntil - now));
  }
}

function drainProcQueue() {
  procDrainTimer = null;
  const next = procQueue.shift();
  if (!next) return;
  displayProc(next.klass, next.text, next.icon);
  procBusyUntil = performance.now() + PROC_SPACING_MS;
  if (procQueue.length > 0) {
    procDrainTimer = window.setTimeout(drainProcQueue, PROC_SPACING_MS);
  }
}

/** A fresh match (menu reset or rematch flip-off) owes nothing to the last
 *  one — drop any procs still waiting their beat. */
function clearProcQueue() {
  procQueue = [];
  procBusyUntil = 0;
  if (procDrainTimer !== null) {
    clearTimeout(procDrainTimer);
    procDrainTimer = null;
  }
}

// Manual-QA affordance: fire any proc from the console, e.g.
//   __proc("mage", "Reroll!", "reflip")
// Deliberately unconditional — tsconfig has no vite/client types, so an
// import.meta.env.DEV gate would not typecheck.
(window as unknown as { __proc: typeof showProc }).__proc = showProc;

// --- Tutorial coach ---------------------------------------------------------
// "Regatta Tutorial" from the menu is a REAL classic game vs the CPU with a
// coach riding along: each first (flip-off, roll, move, shield, capture,
// exact-roll home, the swig) gets one plain-words card, then never repeats.
// Pure presentation — the server doesn't know tutorials exist, and a reload
// mid-tutorial simply resumes as a normal CPU game.
let tutorialMode = false;
const coachShown = new Set<string>();
const coachEl = document.getElementById("coach") as HTMLDivElement;
const coachTextEl = coachEl.querySelector(".coach-text") as HTMLDivElement;

function coach(step: string, text: string) {
  if (!tutorialMode || coachShown.has(step)) return;
  coachShown.add(step);
  coachTextEl.textContent = text;
  coachEl.classList.remove("show");
  void coachEl.offsetWidth; // restart the slide-in
  coachEl.classList.add("show");
}
function hideCoach() {
  coachEl.classList.remove("show");
}
coachEl.addEventListener("click", hideCoach);

function playerLabel(p: PlayerId): string {
  // Seat-relative: the viewer is always "Red", the opponent always "Blue".
  return p === (myRole ?? "p1") ? "Red" : "Blue";
}

function tileDisplay(pos: number): string {
  if (pos === -1) return "off";
  if (pos >= PATH_LENGTH) return "OUT";
  return String(pos + 1);
}

/** "(+1⚡)" / "(-1⚡)" — appended to whichever announcement is already
 *  showing, so a charge change never has to invent its own separate toast.
 *  `delta` comes straight from the server's own before/after diff
 *  (lastChargeEvent) — never re-derived from the move shape here, so the
 *  client can't drift from the real charge-economy rules. */
function chargeSuffix(delta: number): string {
  return ` (${delta > 0 ? "+" : ""}${delta}⚡)`;
}

function announceFromState(msg: {
  state: GameState;
  lastMove: Move | PowerMove | null;
  lastMovePlayer: PlayerId | null;
  lastPush?: { targetTokenId: number } | null;
  lastChargedShot?: { targetTokenId: number } | null;
  lastBulwark?: { tokenId: number; reinforced?: boolean } | null;
  lastBulwarkBlock?: { tokenIds: number[] } | null;
  lastChargeEvent?: { player: PlayerId; delta: number } | null;
  lastRainOfArrows?: { targetTokenId: number | null } | null;
  lastUltimate?: {
    kind: "blinkStrike" | "warpath" | "grandHeist";
    targetTokenId: number;
    sweptTokenIds: number[];
    drained?: number;
  } | null;
  lastChargeSweep?: { sweptTokenIds: number[] } | null;
  lastReflip?: { player: PlayerId } | null;
  lastRevive?: { tokenId: number; tile: number } | null;
  lastThrallExpired?: { tokenId: number } | null;
  lastCorpseDenied?: { tokenId: number } | null;
  lastCorpseExplosion?: { tile: number; struckTokenIds: number[]; sentHomeIds: number[] } | null;
  lastExhume?: { targetTokenId: number; returnedTo: number } | null;
  lastBless?: { tokenId: number } | null;
  lastHeal?: { tokenId: number } | null;
  lastBenediction?: { tokenIds: number[] } | null;
  lastWound?: { tokenIds: number[] } | null;
  lastMend?: { tokenIds: number[] } | null;
  lastPickpocket?: { targetTokenId: number; stolen: number } | null;
  lastVanish?: { tokenId: number } | null;
  power?: { classes: Record<PlayerId, PlayerClass> };
  wasSkipped: boolean;
  skippedPlayer: PlayerId | null;
  skipReason: "flip-zero" | "no-legal-move" | null;
}) {
  const chargeFor = (player: PlayerId): string =>
    msg.lastChargeEvent && msg.lastChargeEvent.player === player ? chargeSuffix(msg.lastChargeEvent.delta) : "";
  // Class lookup for the proc banner — absent in classic rooms, so every
  // showProc below is inert there by construction.
  const classOf = (player: PlayerId | null | undefined): PlayerClass | null =>
    player && msg.power ? (msg.power.classes[player] ?? null) : null;

  if (msg.wasSkipped && msg.skippedPlayer) {
    const who = playerLabel(msg.skippedPlayer);
    const isMe = msg.skippedPlayer === myRole;
    const label = isMe ? "Your" : `${who}'s`;
    const reason =
      msg.skipReason === "flip-zero"
        ? "flipped 0 — skip"
        : "no legal move — skip";
    coach(
      "skip",
      "A zero — the turn passes. So does having no legal move. It happens to every sailor; the coins owe you nothing.",
    );
    showAnnouncement(`${label} turn: ${reason}${chargeFor(msg.skippedPlayer)}`, "skip");
    return;
  }

  // Mage Re-flip proc — the same commit can ALSO reveal a Bulwark block
  // below (a re-flip that lands on a warded threat), and that branch returns
  // early. Fire the Reroll BEFORE it so the queue plays both, purple then
  // blue, instead of Blocked! swallowing the mage's own proc.
  if (msg.lastReflip && classOf(msg.lastReflip.player) === "mage") {
    showProc("mage", "Reroll!", "reflip");
  }

  // Necromancer Revive proc — hoisted for the Reroll's exact reason: the
  // same commit can ALSO reveal a Bulwark block (the risen thrall can
  // expose a warded threat, see applyMkRevive), and that branch returns
  // early. The POSSESSOR is the caster — the risen stone's real owner is
  // the VICTIM, so the class lookup goes through the opponent of the
  // body's owner (2-player game: the necromancer is always the other seat).
  if (msg.lastRevive) {
    const bodyOwner = msg.state.tokens.find((t) => t.id === msg.lastRevive!.tokenId)?.owner;
    const caster = bodyOwner === "p1" ? "p2" : "p1";
    if (classOf(caster) === "necromancer") showProc("necromancer", "Revive!", "revive");
  }

  // A thrall crumbling / a corpse denied both announce quietly before the
  // main chain (they share commits with ordinary moves).
  if (msg.lastThrallExpired) {
    const bodyOwner = msg.state.tokens.find((t) => t.id === msg.lastThrallExpired!.tokenId)?.owner;
    const caster = bodyOwner === "p1" ? "p2" : "p1";
    if (classOf(caster) === "necromancer") showProc("necromancer", "Thrall Crumbles", "thrallExpired");
  }
  if (msg.lastCorpseDenied) {
    const denier = msg.state.tokens.find((t) => t.id === msg.lastCorpseDenied!.tokenId)?.owner;
    const necro = denier === "p1" ? "p2" : "p1";
    if (classOf(necro) === "necromancer") showProc("necromancer", "Soul Reclaimed", "corpseDenied");
  }
  if (msg.lastCorpseExplosion && msg.lastMovePlayer && classOf(msg.lastMovePlayer) === "necromancer") {
    showProc("necromancer", "Corpse Explosion!", "corpseExplosion");
  }

  // Cleric procs that share commits with the ongoing turn. Bless keeps the
  // turn (Re-flip's contract), so — like Reroll — it's a proc, not a
  // returning announcement: the real move follows on the same flip. The
  // caster is the blessed stone's owner (Bless only ever targets own
  // stones), NOT lastMovePlayer, which a turn-keeping commit leaves at its
  // previous value.
  if (msg.lastBless) {
    const owner = msg.state.tokens.find((t) => t.id === msg.lastBless!.tokenId)?.owner;
    if (classOf(owner) === "cleric") showProc("cleric", "Bless!", "bless");
  }
  // A blessing BROKE this commit — the stone survived a killing blow. The
  // proc wears the VICTIM's (cleric's) color; the main move/push/blast
  // announcement still follows.
  if (msg.lastWound && msg.lastWound.tokenIds.length > 0) {
    const owner = msg.state.tokens.find((t) => t.id === msg.lastWound!.tokenIds[0])?.owner;
    if (classOf(owner) === "cleric") showProc("cleric", "Blessing Breaks!", "wound");
  }
  // Sanctified Ground fired on a shield landing — mends ride the landing's
  // own commit and announcement.
  if (msg.lastMend && msg.lastMend.tokenIds.length > 0) {
    const owner = msg.state.tokens.find((t) => t.id === msg.lastMend!.tokenIds[0])?.owner;
    if (classOf(owner) === "cleric") showProc("cleric", "Sanctified Ground", "sanctifiedGround");
  }
  // Rogue's Pickpocket keeps the turn (Bless's contract) — a proc, not a
  // returning announcement. Turn-keeping means lastMovePlayer is stale (a
  // prior commit's value, same reason Bless can't use it either); but
  // Pickpocket never passes the turn AT ALL, so whoever currently holds it
  // (state.currentPlayer) must be the caster — a simpler, equally sound
  // derivation than Bless's own "the target's owner" trick (which doesn't
  // apply here since Pickpocket's target is the ENEMY's stone, not the
  // caster's own).
  if (msg.lastPickpocket) {
    const caster = msg.state.currentPlayer;
    if (classOf(caster) === "rogue") {
      showProc("rogue", "Pickpocket!", "pickpocket");
      const isMe = caster === myRole;
      const subject = isMe ? "You" : playerLabel(caster);
      const target = isMe ? "their" : "your";
      showAnnouncement(`${subject} picked ${target} pocket for ${msg.lastPickpocket.stolen} mana`, "capture");
    }
  }

  // Bulwark actually blocking a capture is its own signal, independent of
  // lastMovePlayer (it fires the instant a fresh flip reveals the block —
  // see master-killer.ts's tickBulwarkForNewTurn — which can be before the
  // blocked player's opponent has even chosen a move this turn).
  if (msg.lastBulwarkBlock && msg.lastBulwarkBlock.tokenIds.length > 0) {
    const first = msg.state.tokens.find((t) => t.id === msg.lastBulwarkBlock!.tokenIds[0]);
    const isMine = first?.owner === myRole;
    const subject = isMine ? "Your" : "Their";
    const plural = msg.lastBulwarkBlock.tokenIds.length > 1 ? "s" : "";
    const k = classOf(first?.owner);
    if (k) showProc(k, "Blocked!", "bulwarkBlock");
    showAnnouncement(`${subject} Bulwark${plural} blocked a capture!`, "shield");
    return;
  }

  // Revive's full announcement (the proc already fired above). The
  // resulting tile comes from the authoritative state, lastPush's pattern —
  // never re-derived from the constants here.
  if (msg.lastRevive) {
    const risen = msg.state.tokens.find((t) => t.id === msg.lastRevive!.tokenId);
    if (risen) {
      const caster = risen.owner === "p1" ? "p2" : "p1";
      const isMe = caster === myRole;
      const subject = isMe ? "You" : playerLabel(caster);
      const whose = isMe ? "their" : "your";
      showAnnouncement(
        `${subject} raised ${whose} fallen stone as a THRALL on ${tileDisplay(risen.position)}${chargeFor(caster)}`,
        "shield",
      );
    }
    return;
  }

  if (msg.lastCorpseExplosion && msg.lastMovePlayer) {
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : playerLabel(msg.lastMovePlayer);
    const struck = msg.lastCorpseExplosion.struckTokenIds.length;
    const home = msg.lastCorpseExplosion.sentHomeIds.length;
    showAnnouncement(
      `${subject} detonated the corpse on ${tileDisplay(msg.lastCorpseExplosion.tile)} — ` +
        `${struck} stone${struck === 1 ? "" : "s"} blasted${home > 0 ? `, ${home} sent home` : ""}` +
        `${chargeFor(msg.lastMovePlayer)}`,
      "shield",
    );
    return;
  }

  // Heal ends the turn (a whole turn spent mending), so it announces and
  // returns like its Bulwark sibling; Benediction is an ultimate resolving.
  if (msg.lastHeal && msg.lastMovePlayer) {
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : playerLabel(msg.lastMovePlayer);
    const target = isMe ? "your" : "their";
    if (classOf(msg.lastMovePlayer) === "cleric") showProc("cleric", "Healed", "heal");
    showAnnouncement(
      `${subject} healed ${target} wounded stone — the blessing burns again${chargeFor(msg.lastMovePlayer)}`,
      "shield",
    );
    return;
  }
  if (msg.lastBenediction && msg.lastMovePlayer) {
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : playerLabel(msg.lastMovePlayer);
    const target = isMe ? "your" : "their";
    const n = msg.lastBenediction.tokenIds.length;
    if (classOf(msg.lastMovePlayer) === "cleric") showProc("cleric", "Benediction!", "benediction");
    showAnnouncement(
      `${subject} sang the Benediction — ${n} of ${target} stone${n === 1 ? "" : "s"} blessed at once!`,
      "ultimate",
    );
    return;
  }

  if (msg.lastBulwark && msg.lastMovePlayer) {
    const who = playerLabel(msg.lastMovePlayer);
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : who;
    const target = isMe ? "your" : "their";
    const reinforced = msg.lastBulwark.reinforced === true;
    const k = classOf(msg.lastMovePlayer);
    if (k) showProc(k, reinforced ? "Reinforced Bulwark!" : "Bulwark!", reinforced ? "bulwarkReinforced" : "bulwark");
    showAnnouncement(
      `${subject} raised ${reinforced ? "a REINFORCED Bulwark" : "Bulwark"} on ${target} token${chargeFor(msg.lastMovePlayer)}`,
      "shield",
    );
    return;
  }

  if (msg.lastPush && msg.lastMovePlayer) {
    const who = playerLabel(msg.lastMovePlayer);
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : who;
    const target = isMe ? "opponent's" : "your";
    const targetToken = msg.state.tokens.find((t) => t.id === msg.lastPush!.targetTokenId);
    const sentHome = !targetToken || targetToken.position === -1;
    const where = sentHome ? "all the way home" : `to ${tileDisplay(targetToken.position)}`;
    const k = classOf(msg.lastMovePlayer);
    if (k) showProc(k, "Push!", "push");
    showAnnouncement(`${subject} pushed ${target} token ${where}${chargeFor(msg.lastMovePlayer)}`, "capture");
    return;
  }

  if (msg.lastChargedShot && msg.lastMovePlayer) {
    const who = playerLabel(msg.lastMovePlayer);
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : who;
    const target = isMe ? "opponent's" : "your";
    const targetToken = msg.state.tokens.find((t) => t.id === msg.lastChargedShot!.targetTokenId);
    const sentHome = !targetToken || targetToken.position === -1;
    const where = sentHome ? "all the way home" : `to ${tileDisplay(targetToken.position)}`;
    const k = classOf(msg.lastMovePlayer);
    if (k) showProc(k, "Charged Shot!", "chargedShot");
    showAnnouncement(
      `${subject} loosed a Charged Shot — ${target} token knocked ${where}${chargeFor(msg.lastMovePlayer)}`,
      "capture",
    );
    return;
  }

  if (msg.lastVanish && msg.lastMovePlayer) {
    const who = playerLabel(msg.lastMovePlayer);
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : who;
    const target = isMe ? "your" : "their";
    const k = classOf(msg.lastMovePlayer);
    if (k) showProc(k, "Vanish!", "vanish");
    showAnnouncement(
      `${subject} slipped ${target} token into the shadows${chargeFor(msg.lastMovePlayer)}`,
      "shield",
    );
    return;
  }

  if (msg.lastUltimate && msg.lastMovePlayer) {
    const who = playerLabel(msg.lastMovePlayer);
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : who;
    const target = isMe ? "opponent's" : "your";
    const label =
      msg.lastUltimate.kind === "blinkStrike" ? "Blink Strike" : msg.lastUltimate.kind === "warpath" ? "Warpath" : "Grand Heist";
    const sweptCount = msg.lastUltimate.sweptTokenIds.length;
    const sweepPhrase = sweptCount > 0 ? `, sweeping ${sweptCount} more` : "";
    const drained = msg.lastUltimate.drained ?? 0;
    const heistPhrase = drained > 0 ? ` and emptied ${target} bank for ${drained} mana` : "";
    const k = classOf(msg.lastMovePlayer);
    if (k) showProc(k, `${label}!`, msg.lastUltimate.kind);
    showAnnouncement(
      `${subject} unleashed ${label} — captured ${target} token${sweptCount > 0 ? "s" : ""}${sweepPhrase}${heistPhrase}!${chargeFor(msg.lastMovePlayer)}`,
      "ultimate",
    );
    return;
  }

  // Necromancer's Exhume — an ultimate resolving, so it sits with its
  // Blink Strike/Warpath siblings (turn-ending, lastMovePlayer is the
  // caster). The landing tile is the server's own `returnedTo`, never the
  // occupancy walk re-derived here.
  if (msg.lastExhume && msg.lastMovePlayer) {
    const who = playerLabel(msg.lastMovePlayer);
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : who;
    const target = isMe ? "opponent's" : "your";
    const k = classOf(msg.lastMovePlayer);
    if (k) showProc(k, "Exhume!", "exhume");
    showAnnouncement(
      `${subject} exhumed ${target} escaped token — dragged back to ${tileDisplay(msg.lastExhume.returnedTo)}!`,
      "ultimate",
    );
    return;
  }

  const m = msg.lastMove;
  if (m && msg.lastMovePlayer) {
    const who = playerLabel(msg.lastMovePlayer);
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : who;
    const suffix = chargeFor(msg.lastMovePlayer);
    const k = classOf(msg.lastMovePlayer);

    // Move-borne ability procs fire even on a winning move — the win screen
    // celebrates the outcome, the proc celebrates the power that caused it.
    // ONE proc per commit, highest priority first: Rain of Arrows outranks a
    // same-move Snipe (it used to rely on banner overwrite for that — under
    // the queue an overwrite would mean "show both," so it's explicit now).
    if (k) {
      if (msg.lastRainOfArrows) showProc(k, "Rain of Arrows!", "rainOfArrows");
      else if (msg.lastChargeSweep) showProc(k, "Charge!", "charge");
      else if ("bonusCaptures" in m && m.bonusCaptures.length > 0) showProc(k, "Snipe!", "snipe");
      else if ("breaksWard" in m && m.breaksWard) showProc(k, "Ward Breaker!", "wardBreaker");
    }

    if (m.causesWin) {
      // Win screen will handle the celebration; don't double-announce.
      return;
    }
    if (msg.lastRainOfArrows) {
      const targetPhrase =
        msg.lastRainOfArrows.targetTokenId != null
          ? `strikes ${isMe ? "an opponent's" : "your"} token`
          : "finds no target";
      showAnnouncement(`${subject} chained 3 shields — Rain of Arrows ${targetPhrase}!${suffix}`, "ultimate");
      return;
    }
    if (m.landsOnShield) {
      coach(
        "shield",
        "A shield tile! Landing on one grants an extra turn, and the stone standing there cannot be captured.",
      );
      showAnnouncement(`${subject} landed on shield (${tileDisplay(m.to)}) — extra turn${suffix}`, "shield");
      return;
    }
    // Master Killer moves may carry Snipe/Charge-sweep bonus captures on
    // top of captures — PowerMove is a structural superset of Move, so
    // these fields are simply absent (undefined) on a classic Move. The
    // sweep count comes from lastChargeSweep (what the Charge actually
    // took), NOT the move's chargeSweepCaptures, which is only the preview
    // offered before the player chose whether to spend the charge.
    const bonusCaptures = "bonusCaptures" in m ? m.bonusCaptures.length : 0;
    const sweepCaptures = msg.lastChargeSweep ? msg.lastChargeSweep.sweptTokenIds.length : 0;
    const totalCaptures = m.captures.length + bonusCaptures + sweepCaptures;
    if (totalCaptures > 0) {
      const target = isMe ? "opponent's" : "your";
      coach(
        "capture",
        "A capture! Land on an enemy stone in shared water and it's sent home to start its journey over. Stones on your own shore are always safe.",
      );
      // Necromancer kills narrate the corpse (Hearthstone rule: the board
      // never changes silently) — the marker just appeared on the death
      // tile, and the announcement says so.
      const necroKill =
        msg.lastMovePlayer &&
        classOf(msg.lastMovePlayer) === "necromancer" &&
        (msg as { power?: { corpse?: Record<PlayerId, unknown> } }).power?.corpse?.[msg.lastMovePlayer];
      showAnnouncement(
        `${subject} captured ${target} token${totalCaptures > 1 ? "s" : ""} on ${tileDisplay(m.to)}` +
          `${necroKill ? " — corpse marked" : ""}${suffix}`,
        "capture",
      );
      return;
    }
    if (m.to >= PATH_LENGTH) {
      coach(
        "escape",
        "A stone made it home! The dock demands an exact roll — overshoot and the stone must wait for another turn.",
      );
      showAnnouncement(`${subject} escaped a token`, "escape");
      return;
    }
    // Normal quiet move — no announcement, UNLESS it still earned a charge
    // (a zero-flip is handled by the skip branch above, so this is really
    // just defensive — normal moves earn a charge only via capture/shield,
    // both already handled — but keep the fallthrough safe regardless).
    if (suffix) showAnnouncement(`${subject} moved${suffix}`, "capture");
    return;
  }

  // No move, no push, no skip — the only thing left that can reach here is
  // a Re-flip (which doesn't end the turn, so none of the above fire).
  // Keyed on lastReflip so a net-zero charge delta (re-flip cost refunded by
  // a zero replacement flip) still announces — lastChargeEvent alone missed
  // roughly one re-flip in sixteen entirely.
  const reflipper = msg.lastReflip?.player ?? msg.lastChargeEvent?.player;
  if (reflipper) {
    const who = playerLabel(reflipper);
    const isMe = reflipper === myRole;
    const subject = isMe ? "You" : who;
    // Deploy-order fallback: an old server sends no lastReflip, so the
    // hoisted proc at the top never fired — keep today's behavior here.
    if (!msg.lastReflip && classOf(reflipper) === "mage") showProc("mage", "Reroll!", "reflip");
    const suffix = msg.lastChargeEvent ? chargeSuffix(msg.lastChargeEvent.delta) : "";
    showAnnouncement(`${subject} re-flipped${suffix}`, "shield");
  }
}

// ---------------------------------------------------------------------------
// Transport — HTTP long-polling against /api/room (Vercel function or the
// local referee; identical contract). There is NO held-open connection:
// the client POSTs a long-poll that the server answers as soon as the room's
// event seq advances (or its ~20s cap lapses), then immediately re-polls.
// Nothing exists for the host to recycle, so the old every-5-minutes
// WebSocket drop is gone by construction — a reload or a backgrounded tab
// simply resumes by polling with its seat token.
//
// Rendering model:
//   - EVENTS (seq-ordered frames from the server's log) drive everything
//     transient: announcements, board animation, coin tumbles, gem flashes.
//     Each is replayed exactly once, gated by lastSeq.
//   - The OVERLAY (the rest of the poll response) drives everything
//     interactive and idempotent: whose turn, legal moves, the roll gate,
//     class pick, chat, game over.
//   - The roll gate arms ONLY when a new my-flip event arrives (seq-gated
//     via armedFlipSeq) — a quiet re-poll or a resume can never force the
//     "tap to roll" ritual for a flip that was already revealed. That is the
//     fix for the old reconnect-reroll bug.
// ---------------------------------------------------------------------------

// Seat session — survives page reloads (mobile browsers kill tabs freely).
interface SeatSession {
  room: string;
  seat: PlayerId;
  seatToken: string;
}
function loadSession(): SeatSession | null {
  try {
    const raw = sessionStorage.getItem("regatta-session");
    return raw ? (JSON.parse(raw) as SeatSession) : null;
  } catch {
    return null;
  }
}
function saveSession(s: SeatSession) {
  try {
    sessionStorage.setItem("regatta-session", JSON.stringify(s));
  } catch {}
}
function clearSession() {
  try {
    sessionStorage.removeItem("regatta-session");
  } catch {}
}

let session: SeatSession | null = null;
/** Highest event seq this client has fully rendered. */
let lastSeq = 0;
/** Seq of the newest my-flip reveal event seen (candidate for arming). */
let pendingFlipSeq = 0;
/** Seq of the my-flip reveal the roll gate last armed for. */
let armedFlipSeq = 0;
/** Poll-loop generation — bumping it retires any in-flight loop. */
let pollGen = 0;
/** Winner already celebrated (dedupes the win modal across polls). */
let shownWinner: PlayerId | null = null;
let lastChatLen = 0;

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function post(body: unknown): Promise<unknown> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status);
  return data;
}

/** Replay one server event — all the TRANSIENT effects, exactly once. */
function replayEvent(ev: RoomEvent) {
  bumpKinetic(); // fail-safe full rate for whatever this frame animates
  if (ev.kind === "chat" || ev.kind === "classPick") return; // overlay-rendered
  // Scrubbing history: the event is already captured in the activity log;
  // the board stays frozen on the selected frame until "Back to live".
  if (viewingHistory()) return;
  if (ev.kind === "opening") {
    hideWinScreen(); // a rematch re-enters the flip-off
    clearProcQueue(); // last match's queued procs die with it
    const mySide: PlayerId = myRole ?? "p1";
    // Tumble any flips we haven't shown yet this round.
    for (const seat of ["p1", "p2"] as PlayerId[]) {
      const count = ev.flips[seat];
      if (count !== null && seenOpeningFlips[seat] === null) {
        triggerCoinFlip(count, seat === mySide ? myCoins : theirCoins);
      }
    }
    seenOpeningFlips = { ...ev.flips };
    if (ev.first !== null) {
      seenOpeningFlips = { p1: null, p2: null };
      const isMe = ev.first === myRole;
      showAnnouncement(isMe ? "You take first move!" : "Opponent takes first move", isMe ? "escape" : "skip");
    } else if (ev.tie) {
      setTimeout(() => showAnnouncement("Tie — flip again!", "shield"), 900);
    } else if (ev.flips[mySide] === null) {
      showAnnouncement("Flip for first move — tap your coins", "shield");
    }
    return;
  }
  // kind === "state"
  if (ev.state.winner === null) hideWinScreen();
  // Announce BEFORE refreshing markers so the banner lands with the animation.
  announceFromState(ev);
  refreshMarkers(ev.state, ev.lastExhume != null);
  currentPower = ev.power ?? null;
  // Thrall countdown telegraph: the moment a possession enters its LAST
  // turn, say so — the crumble should never feel like a surprise.
  for (const side of ["p1", "p2"] as PlayerId[]) {
    const turnsNow = ev.power?.thrall?.[side]?.turnsLeft ?? null;
    if (turnsNow === 1 && (prevThrallTurns[side] ?? 0) > 1) {
      showProc("necromancer", "Thrall Fades — Last Turn", "thrallExpired");
    }
    prevThrallTurns[side] = turnsNow;
  }
  updateTokenTints(ev.state);
  updatePlates(ev.state);
  if (ev.lastChargeEvent) {
    const container = viewSide(ev.lastChargeEvent.player) === "p1" ? gemsMe : gemsThem;
    flashGems(container, ev.lastChargeEvent.delta > 0 ? "flare" : "spend");
  }
  if (ev.flip !== null) {
    const mine = ev.state.currentPlayer === (myRole ?? "p1");
    if (mine) {
      // My fresh flip: remember its seq — the overlay arms the tap gate.
      pendingFlipSeq = ev.seq;
    } else {
      triggerCoinFlip(ev.flip, theirCoins);
    }
  }
}

/** Last seen thrall turns per side — drives the last-turn telegraph. */
const prevThrallTurns: Record<PlayerId, number | null> = { p1: null, p2: null };

/** Apply the response's CURRENT overlay — idempotent, interactive state. */
function applyOverlay(v: RoomResponse) {
  const mySide: PlayerId = myRole ?? "p1";
  myVariant = v.variant;
  if (v.variant === "masterKiller") ensureMkPieces(); // covers resume + reload
  inCpuGame = v.vsCpu;
  cpuDifficulty = v.difficulty ?? null; // covers join, resume, AND reload

  // Waiting room (PvP, empty seat): surface the invite code + link.
  if (!v.started) {
    hud.textContent = "Waiting for opponent…";
    if (myRoom && !v.vsCpu) showRoomInfo(myRoom);
    return;
  }
  hideRoomInfo();
  setChatAvailable(!v.vsCpu);
  if (v.chat.length !== lastChatLen) {
    renderChat(v.chat);
    if (v.chat.length > lastChatLen && !chatPanel.classList.contains("open")) {
      chatToggle.classList.add("unread");
    }
    lastChatLen = v.chat.length;
  }

  // Class pick overlay.
  if (v.phase === "classPick" && v.classPick) {
    currentPower = null;
    currentPowerMoves = null;
    pickedClasses = { ...v.classPick.classes };
    classpickEl.classList.add("show");
    renderClassPick(v.classPick);
    updatePlates(null);
    hud.textContent = "Pick your class";
    return;
  }
  classpickEl.classList.remove("show");

  if (v.phase === "opening") {
    rollPending = null;
    // Both plates stay up through the flip-off — classes are decided by now,
    // and the public power block carries them even if the classPick overlay
    // resolved too fast for pickedClasses to have caught our own pick.
    currentPower = v.power ?? null;
    updateTokenTints(v.state);
    updatePlates(null);
    updateDock(false); // visible but dormant through the flip-off
    const iFlipped = v.openingFlips[mySide] !== null;
    openingTapArmed = !iFlipped;
    if (!iFlipped)
      coach(
        "welcome",
        "Welcome aboard! The goal: sail all four of your stones down your shore, through shared water, and home to the far dock. First, the flip-off — tap your silver coins.",
      );
    hud.innerHTML = iFlipped
      ? `<div>Flip for first move</div><div>Waiting for opponent…</div>`
      : `<div>Flip for first move</div><div style="color:#ffd370">Tap your coins</div>`;
    return;
  }
  openingTapArmed = false;

  // ---- play ----
  currentPower = v.power ?? null;
  currentPowerMoves = v.powerMoves ?? null;
  // Recompute protection tints/rigs from every applied view, not only from
  // event replays — event-less applies (opening, action echoes, reconnect
  // edges) must never leave a stale ward/Bulwark rig on the board.
  updateTokenTints(v.state);
  const mine = v.yourTurn;
  const movesForTap: Move[] | null = myVariant === "masterKiller" ? v.powerMoves : v.legalMoves;
  updatePlates(v.state);

  if (v.flip !== null && mine) {
    if (pendingFlipSeq > armedFlipSeq) {
      // A flip reveal we haven't shown: arm the tap gate (once per flip).
      armedFlipSeq = pendingFlipSeq;
      rollPending = { flip: v.flip, legalMoves: movesForTap, state: v.state };
      coach(
        "roll",
        "Your turn. Tap your glowing coins to roll — every coin that lands design-up is one pace, zero to four.",
      );
      renderHud(v.state, null);
      hud.innerHTML += `<div style="color:#ffd370">Tap your coins to roll</div>`;
      renderMoves(null, false);
      updateDock(false);
    } else if (!rollPending) {
      // Already revealed (tapped) — keep the interactive surfaces fresh.
      renderHud(v.state, v.flip);
      renderMoves(movesForTap, true);
      updateDock(true);
    }
    // else: gate armed, waiting on the tap — leave it alone.
  } else {
    rollPending = null;
    renderHud(v.state, v.flip);
    renderMoves(v.flip !== null && mine ? movesForTap : null, mine && v.flip !== null);
    updateDock(mine && v.flip !== null);
  }

  // Game over — celebrate once per winner.
  if (v.gameOver && shownWinner !== v.gameOver.winner) {
    shownWinner = v.gameOver.winner;
    coach(
      "end",
      "That's Regatta! When you're ready for class powers, pick Master Killer from the menu — every class keeps a chapter in the book.",
    );
    setStatus(`Game over — ${playerLabel(v.gameOver.winner)} wins`, "ok");
    const { winner, stats } = v.gameOver;
    setTimeout(() => {
      if (viewingHistory()) {
        // Rewound view — don't cover it; exitHistory clears shownWinner so
        // the celebration re-fires the moment we return to live.
        shownWinner = null;
        return;
      }
      showWinScreen(winner, stats);
      showPlayAgainButton();
    }, WIN_SCREEN_DELAY_MS + 1500); // extra beat: the winner's mug slams first
  }
  if (!v.gameOver) shownWinner = null;
}

// ============================================================================
// ACTIVITY LOG + REPLAY — every state event the poll stream delivers is kept
// client-side (the server retains only a short replay window; the full-game
// history exists only here), rendered as a tap-to-rewind list. Selecting an
// entry freezes live rendering (events still arrive and are captured — the
// board just stops following them), re-renders that frame through the SAME
// refreshMarkers/updateTokenTints/updatePlates path the live game uses, and
// shows a derived effects breakdown (frame-vs-frame diff + the event's own
// last* signals): Kasen's 2026-07-19 diagnosis ask — "when events occur on
// board we have no way of seeing if they are actually correct". "Play out"
// steps the remaining frames; "Live" snaps back (win screen, overlays and
// input re-arm via the cached last poll response).
// ============================================================================
type StateEvent = Extract<RoomEvent, { kind: "state" }>;
const LOG_CAP = 2000;
const activityLog: RoomEvent[] = [];
let logSelected = -1; // index into activityLog; -1 = following live
let logPlayTimer: number | null = null;
let lastResponse: RoomResponse | null = null;

const logPanel = document.getElementById("activity-log") as HTMLDivElement;
const logEntriesEl = document.getElementById("log-entries") as HTMLDivElement;
const logToggle = document.getElementById("log-toggle") as HTMLButtonElement;
const historyBanner = document.getElementById("history-banner") as HTMLDivElement;
const historyBannerText = document.getElementById("history-banner-text") as HTMLSpanElement;

function viewingHistory(): boolean {
  return logSelected >= 0;
}

function captureLogEvent(ev: RoomEvent) {
  if (ev.kind === "chat" || ev.kind === "classPick") return;
  activityLog.push(ev);
  if (activityLog.length > LOG_CAP) activityLog.splice(0, activityLog.length - LOG_CAP);
  if (logPanel.classList.contains("open") && !viewingHistory()) renderLogList();
}

function resetActivityLog() {
  stopPlayOut();
  activityLog.length = 0;
  logSelected = -1;
  logPanel.classList.remove("viewing");
  historyBanner.classList.remove("show");
  if (logPanel.classList.contains("open")) renderLogList();
}

const classHex = (cls: PlayerClass | null | undefined): string =>
  cls ? `#${DOCK_RING_TINTS[cls].toString(16).padStart(6, "0")}` : "#8a7a5f";

/** You/Opponent labels when seated; P1/P2 for spectatorless edge cases. */
function logLabel(p: PlayerId): string {
  return myRole ? (p === myRole ? "You" : "Opponent") : p.toUpperCase();
}

function actorOf(ev: StateEvent): PlayerId {
  // Revive commits leave lastMovePlayer stale by contract (the turn never
  // changed hands) — the caster is the OPPONENT of the risen body's owner
  // (possession never changes token.owner). Re-flip names its player
  // outright for the same reason.
  if (ev.lastRevive) {
    const o = ev.state.tokens.find((t) => t.id === ev.lastRevive!.tokenId)?.owner;
    if (o) return o === "p1" ? "p2" : "p1";
  }
  if (ev.lastReflip) return ev.lastReflip.player;
  // Bless keeps the turn too (same stale-lastMovePlayer contract as
  // Revive) — the caster IS the blessed stone's owner (own-stone target).
  if (ev.lastBless) {
    const o = ev.state.tokens.find((t) => t.id === ev.lastBless!.tokenId)?.owner;
    if (o) return o;
  }
  return ev.lastMovePlayer ?? ev.state.currentPlayer;
}

/** One line for the list; the effects panel carries the detail. */
function summarizeEvent(ev: StateEvent): string {
  if (ev.state.winner) return `${logLabel(ev.state.winner)} win${ev.state.winner === myRole ? "" : "s"} the game`;
  if (ev.lastExhume) return `Exhume — dragged back to ${tileDisplay(ev.lastExhume.returnedTo)}`;
  if (ev.lastUltimate) return ev.lastUltimate.kind === "blinkStrike" ? "Blink Strike" : "Warpath";
  if (ev.lastRainOfArrows)
    return ev.lastRainOfArrows.targetTokenId === null ? "Rain of Arrows — no target" : "Rain of Arrows";
  if (ev.lastRevive) return `Revive — thrall rises on ${tileDisplay(ev.lastRevive.tile)}`;
  if (ev.lastCorpseExplosion) return `Corpse Explosion on ${tileDisplay(ev.lastCorpseExplosion.tile)}`;
  if (ev.lastChargeSweep) return `Charge — sweep of ${ev.lastChargeSweep.sweptTokenIds.length}`;
  if (ev.lastBenediction) return `Benediction — ${ev.lastBenediction.tokenIds.length} blessed`;
  if (ev.lastPush) return "Push";
  if (ev.lastChargedShot) return "Charged Shot";
  if (ev.lastBulwark) return ev.lastBulwark.reinforced ? "Reinforced Bulwark cast" : "Bulwark cast";
  if (ev.lastBless) return "Bless — turn continues";
  if (ev.lastHeal) return "Heal";
  if (ev.lastReflip) return "Re-flip";
  if (ev.lastMove) {
    const m = ev.lastMove;
    const caps = m.captures.length + ("bonusCaptures" in m ? m.bonusCaptures.length : 0);
    return `moves ${tileDisplay(m.from)} → ${tileDisplay(m.to)}${caps > 0 ? ` · captures ${caps}` : ""}`;
  }
  if (ev.wasSkipped) return `flip ${ev.flip ?? "—"} · turn skipped`;
  if (ev.lastBulwarkBlock) return `flip ${ev.flip ?? "—"} · Bulwark blocked!`;
  return ev.flip !== null ? `flip ${ev.flip}` : "state";
}

function prevStateEvent(i: number): StateEvent | null {
  for (let k = i - 1; k >= 0; k--) {
    const e = activityLog[k];
    if (e.kind === "state") return e;
  }
  return null;
}

/** The diagnosis view: every observable consequence of this frame, derived
 *  from the frame-vs-frame diff plus the event's own last* signals — the
 *  same data the live client renders from, so what it says is what the
 *  server actually did. */
function describeEffects(i: number): string[] {
  const ev = activityLog[i] as StateEvent;
  const prev = prevStateEvent(i);
  const fx: string[] = [];
  const cls = (p: PlayerId): string => {
    const c = ev.power?.classes?.[p];
    return c ? ` (${c})` : "";
  };
  const owner = (id: number): PlayerId | null =>
    ev.state.tokens.find((t) => t.id === id)?.owner ?? prev?.state.tokens.find((t) => t.id === id)?.owner ?? null;
  // Per-player numbering (stone 1-4), NEVER the raw internal id: players
  // count four stones a side, and "stone #6" reads as nonsense — Kasen's
  // 2026-07-20 "the log displays incorrect moves" report.
  const ownedLabel = (id: number): string => {
    const o = owner(id);
    return o ? `${logLabel(o)}'s stone ${(id % 4) + 1}` : `stone ${(id % 4) + 1}`;
  };

  const actor = actorOf(ev);
  fx.push(`Actor: <b>${logLabel(actor)}</b>${cls(actor)}`);
  if (ev.flip !== null) fx.push(`Coin flip: <b>${ev.flip}</b>`);
  if (ev.wasSkipped) fx.push(`<b>Turn skipped</b> — no legal moves${ev.skipReason ? ` (${ev.skipReason})` : ""}`);

  if (ev.lastMove) {
    const m = ev.lastMove;
    fx.push(`Move: ${ownedLabel(m.tokenId)} ${tileDisplay(m.from)} → <b>${tileDisplay(m.to)}</b>`);
    if (m.landsOnShield) fx.push(`Landed on a <b>shield tile</b> — extra turn + charge`);
  }
  if (ev.lastReflip) fx.push(`<b>Re-flip</b>: same turn, replacement coin toss`);
  if (ev.lastRevive)
    fx.push(
      `<b>Revive</b>: ${ownedLabel(ev.lastRevive.tokenId)} rises as a THRALL on ${tileDisplay(ev.lastRevive.tile)} — turn continues`,
    );
  if (ev.lastThrallExpired)
    fx.push(`<b>Thrall crumbles</b>: ${ownedLabel(ev.lastThrallExpired.tokenId)} returns to reserve`);
  if (ev.lastCorpseExplosion)
    fx.push(
      `<b>Corpse Explosion</b> on ${tileDisplay(ev.lastCorpseExplosion.tile)}: struck ${ev.lastCorpseExplosion.struckTokenIds.map((id) => ownedLabel(id)).join(", ") || "nothing"}${ev.lastCorpseExplosion.sentHomeIds.length > 0 ? ` — ${ev.lastCorpseExplosion.sentHomeIds.map((id) => ownedLabel(id)).join(", ")} sent home` : ""}`,
    );
  if (ev.lastCorpseDenied)
    fx.push(`<b>Soul reclaimed</b>: ${ownedLabel(ev.lastCorpseDenied.tokenId)} re-entered — the Revive is denied`);
  if (ev.lastBless)
    fx.push(`<b>Bless</b>: ${ownedLabel(ev.lastBless.tokenId)} gains a second life — turn continues`);
  if (ev.lastHeal) fx.push(`<b>Heal</b>: ${ownedLabel(ev.lastHeal.tokenId)} mended — the blessing burns again`);
  if (ev.lastBenediction)
    fx.push(
      `<b>Benediction</b>: blessed ${ev.lastBenediction.tokenIds.map((id) => ownedLabel(id)).join(", ") || "no one"}`,
    );
  if (ev.lastWound)
    for (const id of ev.lastWound.tokenIds)
      fx.push(`<b>Blessing breaks</b>: ${ownedLabel(id)} survives the killing blow — wounded, not captured`);
  if (ev.lastMend)
    fx.push(
      `<b>Sanctified Ground</b>: shield landing mends ${ev.lastMend.tokenIds.map((id) => ownedLabel(id)).join(", ")}`,
    );
  if (ev.lastPush) fx.push(`<b>Push</b>: ${ownedLabel(ev.lastPush.targetTokenId)} knocked back`);
  if (ev.lastChargedShot) fx.push(`<b>Charged Shot</b>: ${ownedLabel(ev.lastChargedShot.targetTokenId)} struck`);
  if (ev.lastChargeSweep)
    fx.push(
      ev.lastChargeSweep.sweptTokenIds.length > 0
        ? `<b>Charge sweep</b>: swept ${ev.lastChargeSweep.sweptTokenIds.map((id) => ownedLabel(id)).join(", ")}`
        : `<b>Charge</b>: sweep took no extra stones`,
    );
  if (ev.lastRainOfArrows)
    fx.push(
      ev.lastRainOfArrows.targetTokenId === null
        ? `<b>Rain of Arrows</b> fired — no valid target`
        : `<b>Rain of Arrows</b>: ${ownedLabel(ev.lastRainOfArrows.targetTokenId)} struck down`,
    );
  if (ev.lastUltimate)
    fx.push(
      `<b>${ev.lastUltimate.kind === "blinkStrike" ? "Blink Strike" : "Warpath"}</b>: target ${ownedLabel(ev.lastUltimate.targetTokenId)}${ev.lastUltimate.sweptTokenIds.length > 0 ? `, swept ${ev.lastUltimate.sweptTokenIds.map((id) => ownedLabel(id)).join(", ")}` : ""}`,
    );
  if (ev.lastExhume)
    fx.push(`<b>Exhume</b>: escaped ${ownedLabel(ev.lastExhume.targetTokenId)} dragged back to ${tileDisplay(ev.lastExhume.returnedTo)}`);

  // Board diff: sent home / escaped / entered (raise entries described above).
  if (prev) {
    for (const t of ev.state.tokens) {
      const was = prev.state.tokens.find((p) => p.id === t.id);
      if (!was) continue;
      if (was.position >= 0 && was.position < PATH_LENGTH && t.position === -1)
        fx.push(`<b>Captured</b>: ${ownedLabel(t.id)} sent home (was ${tileDisplay(was.position)})`);
      if (was.position < PATH_LENGTH && t.position >= PATH_LENGTH) fx.push(`<b>Escaped</b>: ${ownedLabel(t.id)} is out!`);
    }
  }

  // Charge economy: exact before/after per player.
  if (ev.power && prev?.power) {
    for (const p of ["p1", "p2"] as PlayerId[]) {
      const a = prev.power.charges[p];
      const b = ev.power.charges[p];
      if (a !== b) fx.push(`Charges ${logLabel(p)}: ${a} → <b>${b}</b>`);
    }
  }
  if (ev.flip === 0 && ev.lastChargeEvent && ev.lastChargeEvent.delta > 0)
    fx.push(`Zero flip — <b>consolation charge</b> banked`);

  // Shield streak + ultimate readiness (the Exhume/Warpath/Blink gate).
  if (ev.power?.shieldStreak && prev?.power?.shieldStreak) {
    for (const p of ["p1", "p2"] as PlayerId[]) {
      const a = prev.power.shieldStreak[p];
      const b = ev.power.shieldStreak[p];
      if (a !== b) fx.push(`Shield streak ${logLabel(p)}: ${a} → <b>${b}</b>`);
    }
  }
  if (ev.power && prev?.power) {
    for (const p of ["p1", "p2"] as PlayerId[]) {
      if (!prev.power.ultimateReady[p] && ev.power.ultimateReady[p])
        fx.push(`<b>ULTIMATE READY</b> for ${logLabel(p)} — streak complete`);
      if (prev.power.ultimateReady[p] && !ev.power.ultimateReady[p]) fx.push(`Ultimate spent by ${logLabel(p)}`);
    }
  }

  // Bulwark lifecycle — the raw countdown/save numbers behind the glow.
  if (ev.lastBulwarkBlock)
    for (const id of ev.lastBulwarkBlock.tokenIds)
      fx.push(`<b>Bulwark BLOCKED</b> a threat to ${ownedLabel(id)} — it still guards for the rest of this turn`);
  const bwNow = ev.power?.bulwarkTurns ?? {};
  const bwPrev = prev?.power?.bulwarkTurns ?? {};
  const svNow = ev.power?.bulwarkSavesLeft ?? {};
  const svPrev = prev?.power?.bulwarkSavesLeft ?? {};
  if (ev.power?.bulwarkTurns || prev?.power?.bulwarkTurns) {
    for (const idStr of Object.keys(bwNow)) {
      const id = Number(idStr);
      if (bwPrev[id] === undefined)
        fx.push(`<b>Bulwark raised</b> on ${ownedLabel(id)} — ${bwNow[id]} turns${(svNow[id] ?? 1) > 1 ? `, ${svNow[id]} saves` : ""}`);
      else if (bwNow[id] < bwPrev[id]) fx.push(`Bulwark on ${ownedLabel(id)} ticks: <b>${bwNow[id]}</b> turn${bwNow[id] === 1 ? "" : "s"} left`);
      if (svPrev[id] !== undefined && svNow[id] !== undefined && svNow[id] < svPrev[id])
        fx.push(`Bulwark on ${ownedLabel(id)} spent a save — <b>${svNow[id]}</b> left`);
    }
    for (const idStr of Object.keys(bwPrev)) {
      const id = Number(idStr);
      if (bwNow[id] !== undefined) continue;
      if (ev.lastBulwarkBlock?.tokenIds.includes(id))
        fx.push(`Bulwark on ${ownedLabel(id)} <b>consumed</b> by that block — glow falls when the turn ends`);
      else if (bwPrev[id] === 1) fx.push(`Bulwark on ${ownedLabel(id)} <b>expired</b> (countdown reached 0)`);
      else fx.push(`Bulwark on ${ownedLabel(id)} ended (stone captured or spent)`);
    }
  }

  if (prev && prev.state.currentPlayer !== ev.state.currentPlayer)
    fx.push(`Turn passes: ${logLabel(prev.state.currentPlayer)} → <b>${logLabel(ev.state.currentPlayer)}</b>`);
  else if (ev.state.extraTurn) fx.push(`<b>Extra turn</b> — same player goes again`);
  if (ev.state.winner) fx.push(`<b>GAME OVER</b> — ${logLabel(ev.state.winner)} win${ev.state.winner === myRole ? "" : "s"}`);
  return fx;
}

function renderLogList() {
  const start = Math.max(0, activityLog.length - 500);
  let html = start > 0 ? `<div class="log-divider">${start} earlier events trimmed</div>` : "";
  if (activityLog.length === 0) html = `<div class="log-divider">No events yet</div>`;
  for (let i = start; i < activityLog.length; i++) {
    const ev = activityLog[i];
    if (ev.kind === "opening") {
      html += `<div class="log-divider">— flip-off —</div>`;
      continue;
    }
    if (ev.kind !== "state") continue;
    const actor = actorOf(ev);
    const sel = i === logSelected;
    html +=
      `<button class="log-entry${sel ? " sel" : ""}" data-i="${i}">` +
      `<span class="le-turn">#${ev.seq}</span>` +
      `<span class="le-who" style="color:${classHex(ev.power?.classes?.[actor])};background:${classHex(ev.power?.classes?.[actor])}"></span>` +
      `${logLabel(actor)} ${summarizeEvent(ev)}</button>`;
    if (sel) html += `<ul class="log-effects">${describeEffects(i).map((f) => `<li>${f}</li>`).join("")}</ul>`;
  }
  logEntriesEl.innerHTML = html;
  if (!viewingHistory()) logEntriesEl.scrollTop = logEntriesEl.scrollHeight;
}

/** Render one historical frame through the live pipeline. */
function renderHistoryFrame(i: number) {
  const ev = activityLog[i];
  if (ev.kind !== "state") return;
  refreshMarkers(ev.state, ev.lastExhume != null);
  currentPower = ev.power ?? null;
  updateTokenTints(ev.state);
  updatePlates(ev.state);
  historyBannerText.textContent = `Viewing history — event #${ev.seq}`;
}

function enterHistory(i: number) {
  if (activityLog[i]?.kind !== "state") return;
  stopPlayOut();
  disarm();
  hideAbilityTip();
  clearProcQueue();
  hideWinScreen(); // a finished game's celebration would sit over the rewind
  shownWinner = null; // …and must re-fire when we return to live
  logSelected = i;
  logPanel.classList.add("viewing");
  historyBanner.classList.add("show");
  renderMoves(null, false);
  renderHistoryFrame(i);
  renderLogList();
  logEntriesEl.querySelector(".log-entry.sel")?.scrollIntoView({ block: "center" });
}

function stopPlayOut() {
  if (logPlayTimer !== null) {
    clearInterval(logPlayTimer);
    logPlayTimer = null;
  }
}

function exitHistory() {
  stopPlayOut();
  logSelected = -1;
  logPanel.classList.remove("viewing");
  historyBanner.classList.remove("show");
  // Snap to the newest recorded frame, then re-arm overlays (win screen,
  // move rings, dock, pending flip) from the cached last poll response.
  for (let k = activityLog.length - 1; k >= 0; k--) {
    const e = activityLog[k];
    if (e.kind === "state") {
      refreshMarkers(e.state, false);
      currentPower = e.power ?? null;
      updateTokenTints(e.state);
      updatePlates(e.state);
      break;
    }
  }
  if (lastResponse) applyOverlay(lastResponse);
  renderLogList();
}

function stepHistory(dir: 1 | -1) {
  let n = logSelected + dir;
  while (n >= 0 && n < activityLog.length && activityLog[n].kind !== "state") n += dir;
  if (n < 0 || n >= activityLog.length) return;
  enterHistoryQuiet(n);
}

/** enterHistory without the one-time teardown (already in history mode). */
function enterHistoryQuiet(i: number) {
  logSelected = i;
  renderHistoryFrame(i);
  renderLogList();
  logEntriesEl.querySelector(".log-entry.sel")?.scrollIntoView({ block: "nearest" });
}

function playOutHistory() {
  stopPlayOut();
  logPlayTimer = window.setInterval(() => {
    let n = logSelected + 1;
    while (n < activityLog.length && activityLog[n].kind !== "state") n++;
    if (n >= activityLog.length) {
      exitHistory();
      return;
    }
    enterHistoryQuiet(n);
  }, 650);
}

logToggle.addEventListener("click", () => {
  const open = logPanel.classList.toggle("open");
  if (open) renderLogList();
});
document.getElementById("log-close")!.addEventListener("click", () => {
  logPanel.classList.remove("open");
});
logEntriesEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".log-entry");
  if (!btn) return;
  const i = Number(btn.dataset.i);
  if (i === logSelected) exitHistory();
  else if (viewingHistory()) enterHistoryQuiet(i);
  else enterHistory(i);
});
document.getElementById("log-prev")!.addEventListener("click", () => stepHistory(-1));
document.getElementById("log-next")!.addEventListener("click", () => stepHistory(1));
document.getElementById("log-play")!.addEventListener("click", () => playOutHistory());
document.getElementById("log-live")!.addEventListener("click", () => exitHistory());
document.getElementById("history-live")!.addEventListener("click", () => exitHistory());

/** Process a poll response: resync-snap or replay, then apply the overlay. */
function processResponse(v: RoomResponse) {
  if (v.opponentLeft) {
    resetToMenu("Opponent left the game");
    return;
  }
  // Action replies and poll replies both land here and can cross on the
  // wire — never let an older snapshot regress an overlay we've already
  // rendered past. (Events are separately seq-gated below regardless.)
  if (v.latestSeq < lastSeq) return;
  lastResponse = v; // exitHistory re-arms overlays from the newest response
  if (v.resync) {
    // Too far behind for replay: snap silently (no banners, no tumbles).
    seenOpeningFlips = { ...v.openingFlips };
    if (!viewingHistory()) {
      currentPower = v.power ?? null;
      refreshMarkers(v.state);
      updateTokenTints(v.state);
      updatePlates(v.state);
    }
    if (v.flip !== null && v.yourTurn) pendingFlipSeq = v.latestSeq;
  } else {
    for (const ev of v.events) {
      if (ev.seq > lastSeq) {
        captureLogEvent(ev); // the log records even what the board won't show yet
        replayEvent(ev);
      }
    }
  }
  lastSeq = Math.max(lastSeq, v.latestSeq);
  if (!viewingHistory()) applyOverlay(v);
  setStatus(v.opponentAway ? "Opponent reconnecting…" : "Connected", v.opponentAway ? "err" : "ok");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollLoop() {
  const gen = ++pollGen;
  let backoff = 1000;
  while (session && gen === pollGen) {
    // Trust flowing frames over the visibility API: iOS can leave
    // visibilityState stuck on "hidden" after an app switch while the
    // player is right there playing (see the render-loop watchdog). If
    // frames are rendering, poll like a foreground player regardless.
    const hidden = document.hidden && performance.now() - lastFrameAt > 3000;
    try {
      // Backgrounded tabs drop to a slow, non-holding heartbeat: the room
      // keeps advancing and the opponent never sees a false "away", but we
      // stop burning long-poll holds. Foreground resumes long-polling.
      const v = (await post({ ...session, op: "poll", since: lastSeq, wait: !hidden })) as RoomResponse;
      if (gen !== pollGen) return;
      backoff = 1000;
      processResponse(v);
      if (hidden) {
        // Heartbeat cadence while hidden; wake instantly on refocus.
        await Promise.race([
          sleep(10_000),
          new Promise<void>((r) => {
            const onVis = () => {
              if (!document.hidden) {
                document.removeEventListener("visibilitychange", onVis);
                r();
              }
            };
            document.addEventListener("visibilitychange", onVis);
          }),
        ]);
      }
    } catch (err) {
      if (gen !== pollGen) return;
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        clearSession();
        resetToMenu("That game has ended");
        return;
      }
      setStatus("Reconnecting…", "err");
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 8000);
    }
  }
}

/** Reset all per-match client state and seat us in a (re)joined room. */
function seatSelf(
  seat: PlayerId,
  room: string,
  vsCpu: boolean,
  variant: "classic" | "masterKiller",
  difficulty: BotDifficulty | null = null,
) {
  myRole = seat;
  myRoom = room;
  myVariant = variant;
  if (variant === "masterKiller") ensureMkPieces(); // decode during class pick
  inCpuGame = vsCpu;
  cpuDifficulty = vsCpu ? (difficulty ?? "standard") : null;
  rollPending = null;
  openingTapArmed = false;
  seenOpeningFlips = { p1: null, p2: null };
  currentPower = null;
  currentPowerMoves = null;
  disarm();
  chargeMoveIndexByToken.clear();
  dockKey = "";
  dockActive = false;
  pickedClasses = { p1: null, p2: null };
  lastSeq = 0;
  pendingFlipSeq = 0;
  armedFlipSeq = 0;
  shownWinner = null;
  lastChatLen = 0;
  updatePlates(null);
  classpickEl.classList.remove("show");
  setChatAvailable(!vsCpu);
  hideMenu();
  hud.textContent = vsCpu
    ? `You are Red — vs ${DIFF_NAMES[cpuDifficulty ?? "standard"]}`
    : "You are Red. Waiting for opponent…";
}

function doJoin(
  mode: "cpu" | "create" | "join",
  room?: string,
  variant?: "classic" | "masterKiller",
  unlisted = false,
  difficulty?: BotDifficulty,
) {
  menuError.textContent = "";
  setStatus("Joining…");
  post({ op: "join", mode, room, variant, unlisted, difficulty })
    .then((raw) => {
      const j = raw as RoomJoinResponse;
      session = { room: j.room, seat: j.player, seatToken: j.seatToken };
      saveSession(session);
      exitToggle.classList.add("show");
      closeLobby();
      seatSelf(j.player, j.room, j.vsCpu, j.variant, j.view.difficulty ?? null);
      processResponse(j.view as RoomResponse);
      void pollLoop();
    })
    .catch((err) => {
      // Surface the reason wherever the player is looking (lobby or menu).
      const msg = err instanceof Error ? err.message : "Could not join";
      if (lobbyEl.classList.contains("show")) {
        lobbyList.innerHTML = "";
        const div = document.createElement("div");
        div.className = "lobby-empty";
        div.textContent = msg;
        lobbyList.appendChild(div);
        void refreshLobby();
      } else {
        menuEl.classList.add("show");
        menuError.textContent = msg;
      }
    });
}

/** Resume a live seat after a reload: poll with the saved token; the first
 *  response resyncs the board and the loop takes over. A dead room 404s and
 *  drops us back at the menu. */
function resumeSession(s: SeatSession) {
  session = s;
  myRole = s.seat;
  myRoom = s.room;
  lastSeq = 0;
  pendingFlipSeq = 0;
  armedFlipSeq = 0;
  exitToggle.classList.add("show");
  hud.textContent = "Reconnecting to your game…";
  void pollLoop();
}

// ---------------------------------------------------------------------------
// Mode menu — vs CPU / create room / join room
// ---------------------------------------------------------------------------

const menuEl = document.getElementById("menu") as HTMLDivElement;
const menuError = document.getElementById("menu-error") as HTMLDivElement;
const menuCodeInput = document.getElementById("menu-code") as HTMLInputElement;
const roomInfoEl = document.getElementById("room-info") as HTMLDivElement;
const roomCodeEl = document.getElementById("room-code") as HTMLDivElement;
const roomLinkEl = document.getElementById("room-link") as HTMLDivElement;

let myRoom: string | null = null;
let inCpuGame = false;

// --- CPU difficulty: tavern-named tiers over the wire's easy/standard/hard ---
/** Display names for the wire tiers — presentation only, renameable without
 *  protocol churn (see bot-difficulty.ts). */
const DIFF_NAMES: Record<BotDifficulty, string> = {
  easy: "the Tipsy Patron",
  standard: "the Barkeep",
  hard: "the Tavern Champion",
};
/** The LIVE game's tier, straight from the server's view (v.difficulty) —
 *  covers join, resume, and reload. Null in PvP and back at the menu. Feeds
 *  the HUD flavor, the win-screen beat, and Restart's re-join. */
let cpuDifficulty: BotDifficulty | null = null;

// --- Master Killer mode: menu toggle + class-pick overlay ---
/** Ruleset picked in the menu, sent along with cpu/create joins. Ignored
 *  by the server for mode "join" — you play whatever room you're joining. */
/** The menu is a two-step flow: WHO first (computer / friend / tutorial),
 *  then only the setup questions that fit — CPU games ask game + foe,
 *  friend games ask game + room, the tutorial asks nothing and just sails.
 *  Mode persists like the volume so returning players land on their game. */
let menuIntent: "cpu" | "friend" = "cpu";
let menuPick: "classic" | "masterKiller" =
  localStorage.getItem("regatta-mode") === "masterKiller" ? "masterKiller" : "classic";
function selectedVariant(): "classic" | "masterKiller" {
  return menuPick;
}
/** CPU tier picked in the menu, persisted like regatta-volume so the choice
 *  survives reloads. Sent with mode "cpu" joins only. */
let menuDiff: BotDifficulty = normalizeDifficulty(localStorage.getItem("regatta-cpu-difficulty"));
function selectedDifficulty(): BotDifficulty {
  return menuDiff;
}
const menuCpuBtn = document.getElementById("menu-cpu") as HTMLButtonElement;
const menuCreateBtn = document.getElementById("menu-create") as HTMLButtonElement;
const menuBrowseBtn = document.getElementById("menu-browse") as HTMLButtonElement;
const menuModeSeg = document.getElementById("menu-mode-seg") as HTMLDivElement;
const menuDiffWrap = document.getElementById("menu-diff") as HTMLDivElement;
const menuDiffSeg = document.getElementById("menu-diff-seg") as HTMLDivElement;
const menuTitle = document.getElementById("menu-title") as HTMLHeadingElement;
const menuTagline = document.getElementById("menu-tagline") as HTMLDivElement;
const menuStepIntent = document.getElementById("menu-step-intent") as HTMLDivElement;
const menuStepSetup = document.getElementById("menu-step-setup") as HTMLDivElement;
function applyMenuPick() {
  const mk = menuPick === "masterKiller";
  for (const b of menuModeSeg.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.pick === menuPick);
  }
  // The marquee follows the pick — the menu IS the game you're about to play.
  menuTitle.textContent = mk ? "MASTER KILLER" : "REGATTA";
  menuTagline.textContent = mk ? "a darker table · class powers" : "a race across the board";
}
/** Only the questions that fit the intent: foe pick + Begin for CPU games,
 *  room buttons for friends. Everything else never renders. */
function applyMenuIntent() {
  const cpu = menuIntent === "cpu";
  menuDiffWrap.style.display = cpu ? "" : "none";
  menuCpuBtn.style.display = cpu ? "" : "none";
  menuCreateBtn.style.display = cpu ? "none" : "";
  menuBrowseBtn.style.display = cpu ? "none" : "";
}
function showMenuStep(step: "intent" | "setup") {
  menuStepIntent.classList.toggle("show", step === "intent");
  menuStepSetup.classList.toggle("show", step === "setup");
  if (step === "setup") {
    applyMenuPick();
    applyMenuIntent();
  }
}
menuModeSeg.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button[data-pick]") as HTMLButtonElement | null;
  if (!b) return;
  menuPick = b.dataset.pick as typeof menuPick;
  localStorage.setItem("regatta-mode", menuPick);
  applyMenuPick();
});
(document.getElementById("menu-go-cpu") as HTMLButtonElement).addEventListener("click", () => {
  menuIntent = "cpu";
  showMenuStep("setup");
});
(document.getElementById("menu-go-friend") as HTMLButtonElement).addEventListener("click", () => {
  menuIntent = "friend";
  showMenuStep("setup");
});
// The tutorial is one tap — classic rules, the gentle bot, zero setup.
(document.getElementById("menu-go-tutorial") as HTMLButtonElement).addEventListener("click", () => {
  menuError.textContent = "";
  tutorialMode = true;
  coachShown.clear();
  sendToServer({ type: "join", mode: "cpu", variant: "classic", difficulty: "easy" });
});
(document.getElementById("menu-back") as HTMLButtonElement).addEventListener("click", () => {
  showMenuStep("intent");
});
applyMenuPick();

/** Reflect menuDiff in the seg — same instant class toggle as the mode seg
 *  (also runs once at load, since localStorage may disagree with the
 *  markup's default Barkeep). */
function applyMenuDiff() {
  for (const b of menuDiffSeg.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.diff === menuDiff);
  }
}
menuDiffSeg.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button[data-diff]") as HTMLButtonElement | null;
  if (!b) return;
  menuDiff = normalizeDifficulty(b.dataset.diff);
  localStorage.setItem("regatta-cpu-difficulty", menuDiff);
  applyMenuDiff();
});
applyMenuDiff();

const classpickEl = document.getElementById("classpick") as HTMLDivElement;
const classpickStatus = document.getElementById("classpick-status") as HTMLDivElement;
const classButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("#classpick button.class"),
);
function renderClassPick(msg: { classes: Record<PlayerId, PlayerClass | null>; ready: boolean }) {
  const mySide: PlayerId = myRole ?? "p1";
  const mine = msg.classes[mySide];
  for (const btn of classButtons) {
    const cls = btn.dataset.class as PlayerClass;
    btn.classList.toggle("picked", cls === mine);
    btn.disabled = mine !== null;
  }
  classpickStatus.textContent =
    mine === null ? "Pick your class" : msg.ready ? "Both crews ready…" : "Waiting for opponent to pick…";
}
for (const btn of classButtons) {
  btn.addEventListener("click", () => {
    sendToServer({ type: "pickClass", class: btn.dataset.class as PlayerClass });
  });
}

function hideMenu() {
  menuEl.classList.remove("show");
  menuError.textContent = "";
}

function showRoomInfo(code: string) {
  roomCodeEl.textContent = code;
  roomLinkEl.textContent = `${location.origin}/?room=${code}`;
  roomInfoEl.classList.add("show");
}

function hideRoomInfo() {
  roomInfoEl.classList.remove("show");
}

/** Send a game action. Kept as the old ClientMessage shape so every call
 *  site is untouched: type names map 1:1 onto /api/room ops. Joins route to
 *  doJoin (they mint the session); everything else POSTs against it. Action
 *  replies carry no replay — the poll loop delivers the resulting events —
 *  so only rejections need handling here. */
function sendToServer(msg: ClientMessage) {
  if (msg.type === "join") {
    doJoin(msg.mode, msg.room, msg.variant, false, msg.difficulty);
    return;
  }
  if (!session) return;
  const { type, ...rest } = msg as { type: string } & Record<string, unknown>;
  // `since` lets the reply carry this action's own events — the move renders
  // the moment the POST returns instead of waiting out the poll loop's next
  // re-check (that gap was a visible tap-to-response lag).
  post({ ...session, op: type, ...rest, since: lastSeq })
    .then((raw) => {
      const v = raw as RoomResponse;
      processResponse(v);
      if (v.error) setStatus(`Server: ${v.error}`, "err");
    })
    .catch((err) => {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        clearSession();
        resetToMenu("That game has ended");
        return;
      }
      setStatus(`Server: ${err instanceof Error ? err.message : "error"}`, "err");
    });
}

/** Back to the lobby: clear all match-local state and reopen the menu. */
function resetToMenu(message: string) {
  pollGen++; // retire any in-flight poll loop
  session = null;
  lastSeq = 0;
  resetActivityLog();
  lastResponse = null;
  logPanel.classList.remove("open");
  pendingFlipSeq = 0;
  armedFlipSeq = 0;
  shownWinner = null;
  lastChatLen = 0;
  rollPending = null;
  openingTapArmed = false;
  seenOpeningFlips = { p1: null, p2: null };
  escapedByOwner = { p1: 0, p2: 0 };
  resetMug(myMug);
  resetMug(theirMug);
  hideWinScreen();
  hideRoomInfo();
  clearProcQueue();
  classpickEl.classList.remove("show");
  movesEl.innerHTML = "";
  currentMoves = null;
  eligibleTokenIds.clear();
  capturableIds.clear();
  hideHoverGlow();
  confirmRing.visible = false;
  confirmStart = 0;
  currentPower = null;
  currentPowerMoves = null;
  disarm();
  hideAbilityTip();
  chargeMoveIndexByToken.clear();
  dockEl.classList.remove("show", "off");
  dockClass = null;
  dockKey = "";
  dockActive = false;
  pickedClasses = { p1: null, p2: null };
  myVariant = "classic";
  setChatAvailable(false); // hide + clear chat back at the menu
  updatePlates(null);
  for (const marker of markers) {
    marker.mesh.visible = false;
    marker.flying = false;
    marker.lastPosition = -1;
    (marker.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
  }
  myRole = null;
  myRoom = null;
  inCpuGame = false;
  cpuDifficulty = null;
  clearSession();
  exitToggle.classList.remove("show");
  exitConfirm.classList.remove("show");
  tutorialMode = false;
  coachShown.clear();
  hideCoach();
  hud.textContent = message;
  showMenuStep("intent"); // fresh visit, fresh question: who are you playing?
  menuEl.classList.add("show");
}

menuCpuBtn.addEventListener("click", () => {
  menuError.textContent = "";
  tutorialMode = false; // the tutorial has its own one-tap path on step 1
  coachShown.clear();
  sendToServer({ type: "join", mode: "cpu", variant: selectedVariant(), difficulty: selectedDifficulty() });
});
(document.getElementById("menu-create") as HTMLButtonElement).addEventListener("click", () => {
  menuError.textContent = "";
  sendToServer({ type: "join", mode: "create", variant: selectedVariant() });
});
function submitJoinCode() {
  const code = menuCodeInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    menuError.textContent = "Room codes are 4 letters";
    return;
  }
  menuError.textContent = "";
  sendToServer({ type: "join", mode: "join", room: code });
}
(document.getElementById("menu-join") as HTMLButtonElement).addEventListener("click", submitJoinCode);
menuCodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitJoinCode();
});

// ---------------------------------------------------------------------------
// Room browser — "Join Room" opens a live list of open public tables. Tap a
// row to sit down; the code entry (for private rooms) lives in here too.
// ---------------------------------------------------------------------------

const lobbyEl = document.getElementById("lobby") as HTMLDivElement;
const lobbyList = document.getElementById("lobby-list") as HTMLDivElement;
let lobbyTimer: ReturnType<typeof setInterval> | null = null;

function renderLobby(rooms: { code: string; variant: string; ageSeconds: number }[]) {
  lobbyList.innerHTML = "";
  if (rooms.length === 0) {
    const div = document.createElement("div");
    div.className = "lobby-empty";
    div.textContent = "No open tables right now — create a room and a rival will find you.";
    lobbyList.appendChild(div);
    return;
  }
  for (const r of rooms) {
    const row = document.createElement("button");
    row.className = "room-row";
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = r.code;
    const meta = document.createElement("span");
    meta.className = "meta";
    const age = r.ageSeconds < 60 ? `${r.ageSeconds}s` : `${Math.round(r.ageSeconds / 60)}m`;
    meta.innerHTML =
      r.variant === "masterKiller"
        ? `<span class="mk">⚔ Master Killer</span> · waiting ${age}`
        : `Classic · waiting ${age}`;
    const go = document.createElement("span");
    go.className = "go";
    go.textContent = "Join";
    row.append(code, meta, go);
    row.addEventListener("click", () => doJoin("join", r.code));
    lobbyList.appendChild(row);
  }
}

async function refreshLobby() {
  try {
    const v = (await post({ op: "listRooms" })) as { rooms: { code: string; variant: string; ageSeconds: number }[] };
    if (lobbyEl.classList.contains("show")) renderLobby(v.rooms);
  } catch {
    /* transient — next refresh retries */
  }
}

function openLobby() {
  menuError.textContent = "";
  lobbyEl.classList.add("show");
  void refreshLobby();
  if (lobbyTimer) clearInterval(lobbyTimer);
  lobbyTimer = setInterval(() => void refreshLobby(), 2500);
}

function closeLobby() {
  lobbyEl.classList.remove("show");
  if (lobbyTimer) {
    clearInterval(lobbyTimer);
    lobbyTimer = null;
  }
}

(document.getElementById("menu-browse") as HTMLButtonElement).addEventListener("click", openLobby);
(document.getElementById("lobby-close") as HTMLButtonElement).addEventListener("click", closeLobby);
lobbyEl.addEventListener("click", (e) => {
  if (e.target === lobbyEl) closeLobby();
});
(document.getElementById("lobby-private") as HTMLButtonElement).addEventListener("click", () => {
  doJoin("create", undefined, selectedVariant(), true);
});


// ---------------------------------------------------------------------------
// Game guide booklet — a parchment book of chapters.
//
// The book opens on its CONTENTS page; every entry is tappable and jumps
// straight to its chapter. One chapter = exactly one spread (two facing
// pages), each class gets its own, and nothing ever scrolls — a chapter is
// written to fit, and the leftover blank space is the end-of-chapter signal,
// like real paper. On narrow screens the book shows one page at a time
// (compact mode) so the pages stay readable instead of clipping.
// ---------------------------------------------------------------------------

const GUIDE_SPREADS: [string, string][] = [
  [
    `<h2>Contents</h2>
     <ol class="toc">
       <li data-goto="1"><span>The Game &amp; the Table</span><i></i><b>I</b></li>
       <li data-goto="2"><span>Taking a Turn</span><i></i><b>II</b></li>
       <li data-goto="3"><span>Master Killer</span><i></i><b>III</b></li>
       <li data-goto="4"><span>The Archer</span><i></i><b>IV</b></li>
       <li data-goto="5"><span>The Mage</span><i></i><b>V</b></li>
       <li data-goto="6"><span>The Warrior</span><i></i><b>VI</b></li>
       <li data-goto="7"><span>The Necromancer</span><i></i><b>VII</b></li>
       <li data-goto="8"><span>The Cleric</span><i></i><b>VIII</b></li>
       <li data-goto="9"><span>The Rogue</span><i></i><b>IX</b></li>
     </ol>`,
    `<h2>How to Read This Book</h2>
     <p>Tap any entry in the contents to open its chapter directly.</p>
     <p>Each chapter fills exactly one spread. When the words run out, the
     chapter is done — nothing hides below the fold, and nothing scrolls.</p>
     <p>Turn pages with the arrows below, tap a page, or tap a dot to jump
     between chapters.</p>`,
  ],
  [
    `<h2>The Game</h2>
     <p>A race across the water, played on one carved ship. Regatta is a
     rendition of the <em>Royal Game of Ur</em> — a four-thousand-year-old
     race game — as it appears on the tavern tables of Soulframe.</p>
     <p>Two crews race to sail all <span class="gold">four stones</span> down
     their own shore, across the contested midline, and home to the far dock.
     First crew to walk all four off the board wins.</p>`,
    `<div class="runner">The Game &middot; the table</div>
     <ul>
       <li><b>Your stones</b> bear the <span class="gold">red blossom</span>,
       matching your shore's stamps, and wait in a pile by your coins. The
       enemy's carry the blue star.</li>
       <li><b>Your coins</b> are the four metal pieces stacked in front of
       you. They are your dice.</li>
       <li><b>Your shore</b> is the red row nearest you. The middle row is
       shared water — that is where captures happen.</li>
       <li><b>Score pads</b> are the two stone medallions set into the notch;
       escaped stones gather past the ship's prow.</li>
     </ul>`,
  ],
  [
    `<h2>Taking a Turn</h2>
     <ul>
       <li>Every match opens with a <span class="gold">flip-off</span>: both
       crews tap their coins, and the higher roll takes first move. A tie
       means both flip again.</li>
       <li>When your coin pile <span class="gold">glows</span>, tap it to
       roll. Coins landing <b>design-up</b> count one pace each — zero to
       four.</li>
       <li>Stones you may move light up. Tap one to sail it that many paces.</li>
       <li>Rolled a zero, or no stone can move? The turn passes.</li>
       <li>Your route: down your shore toward the prow, up the shared middle,
       then back along your shore to the dock.</li>
     </ul>`,
    `<div class="runner">Taking a Turn &middot; shields, swords &amp; home</div>
     <ul>
       <li><b>Shield tiles</b> (the crest glyph) grant an
       <span class="gold">extra turn</span> and protect the stone standing
       there from capture.</li>
       <li>Land on an enemy stone in shared water and it is
       <span class="gold">captured</span> — sent back to their hand to start
       over.</li>
       <li>Two of your own stones cannot share a tile.</li>
       <li>The final dock demands an <b>exact roll</b> — overshoot and the
       stone must wait.</li>
       <li>Every stone brought home earns a <span class="gold">swig of
       ale</span> — your mug glows; tap it and drink to the crossing.</li>
       <li>First to bring <b>all four stones home</b> wins the race — and
       drains the mug.</li>
     </ul>`,
  ],
  [
    `<h2>Master Killer</h2>
     <p>A darker table, offered from the menu before you sit down: each crew
     picks a <span class="gold">class</span> before the flip-off and plays
     the whole match armed with its powers.</p>
     <p>Every capture, every zero you roll, and every shield tile you land on
     fills your <span class="gold">mana</span> — up to two banked at once.
     Spend mana to fire your class's active power, offered as a button
     beside your coins whenever you can afford it.</p>`,
    `<div class="runner">Master Killer &middot; the six classes</div>
     <ul>
       <li><b>The Archer</b> strikes from range — free Snipes on the water,
       Pushes and the heavy Charged Shot to knock enemies home.</li>
       <li><b>The Mage</b> bends fate — Wards its lead stone against capture
       and Re-flips a bad roll, twice a turn with a full bank.</li>
       <li><b>The Warrior</b> walks through wards — breaks them on contact,
       sweeps the lane with Charge, shelters behind Bulwark.</li>
       <li><b>The Necromancer</b> profits from every loss — banks a soul for
       each stone sent home and raises the dead back onto the board.</li>
       <li><b>The Cleric</b> refuses the trade — blesses stones with a
       second life, so the first killing blow only wounds them.</li>
       <li><b>The Rogue</b> robs the table — every kill drains the enemy's
       mana too, and Pickpocket lifts it clean with no fight at all.</li>
     </ul>
     <p>Each class keeps its own chapter in this book — and each hides an
     <span class="gold">ultimate</span>, earned by landing on shield tiles
     three times in a row without your turn ever passing.</p>`,
  ],
  [
    `<h2>The Archer</h2>
     <ul>
       <li><b>Snipe</b> (passive, free): move onto shared water, and if an
       unprotected enemy stone sits exactly one pace further along, it is
       captured too — no charge spent.</li>
       <li><b>Push</b> (active, 1 charge): shove an enemy stone in shared
       water back one pace. Land it on your own stone, or off the front of
       the board, and it is sent all the way home to their hand — and your
       charge comes right back, since that's really a capture.</li>
       <li>A <span class="gold">Warded</span> Mage stone shrugs off a plain
       Push entirely — the charge is spent, but the stone doesn't move. A
       <span class="gold">Reinforced Bulwark</span> can't be Pushed at all —
       only a Charged Shot still moves it.</li>
     </ul>`,
    `<div class="runner">The Archer &middot; continued</div>
     <ul>
       <li><b>Charged Shot</b> (active, spends both charges): a heavier shot
       at an enemy stone in shared water, knocking it back
       ${CHARGED_SHOT_DISTANCE} paces — or ${CHARGED_SHOT_WARD_DISTANCE}
       against a <span class="gold">Warded</span> stone, the one shot that
       can still reach it at all. Send the target all the way home and one
       charge comes right back. A Warrior can never be Warded, so it always
       takes the full hit.</li>
       <li><b>Rain of Arrows</b> (the ultimate, free): chain three shield
       landings in a row, your turn never passing between them, and the
       third strikes down a random enemy stone in shared water — through
       shields, Wards, and Bulwarks alike. Rare by design: the board holds
       only three shield tiles.</li>
     </ul>`,
  ],
  [
    `<h2>The Mage</h2>
     <ul>
       <li><b>Ward</b> (passive, free): the moment your bank holds a full
       two charges, your furthest-along stone still on the water cannot be
       captured — by anyone but a Warrior's Ward Breaker, and a Charged
       Shot can still knock it home. A plain Push can't budge it at all.</li>
       <li>Ward always follows whichever of your stones is furthest along —
       send that one all the way home and it passes to whichever stone
       takes the lead.</li>
     </ul>`,
    `<div class="runner">The Mage &middot; continued</div>
     <ul>
       <li><b>Re-flip</b> (active, 1 charge each): dislike your roll? Spend
       a charge to flip again instead of moving — it does not end your turn,
       and with both charges banked you may re-flip TWICE in the same turn.
       Mind the price: Ward only holds at a full bank, so the moment you
       spend below it your lead stone stands unwarded.</li>
       <li><b>Blink Strike</b> (active, spends your ultimate): land on a
       shield tile three times in a row, turn never once passing to the
       opponent, and you may teleport your furthest-along stone straight
       onto any enemy in shared water — capturing it even through a shield,
       a Ward, or a Bulwark.</li>
     </ul>`,
  ],
  [
    `<h2>The Warrior</h2>
     <ul>
       <li><b>Ward Breaker</b> (passive, free): walk onto a Warded enemy
       stone and the Ward breaks — captured all the same.</li>
       <li><b>Charge</b> (active, 1 mana): make your move a sweep — one
       enemy stone in shared water between where you started and where you
       land is captured too, Warded or not.</li>
       <li>The Warrior is the one class no Ward can stop cold — everyone
       else needs a Push or a lucky Re-flip instead.</li>
     </ul>`,
    `<div class="runner">The Warrior &middot; continued</div>
     <ul>
       <li><b>Bulwark</b> (active, 1 mana): raise a shield over one of
       YOUR OWN stones — it cannot be captured or swept by Charge, and a
       Push can only shove it, never send it home. An enemy ultimate still
       punches through. It fades after a few of your turns unused, or the
       instant it saves the stone.</li>
       <li><b>Reinforced Bulwark</b> (active, spends both mana): the
       same shield with everything doubled — it lasts twice as many turns,
       and it shrugs off the first save instead of fading. A plain Push
       can't budge it at all; only a Charged Shot still moves it. Only the
       second save, or time, brings it down.</li>
       <li><b>Warpath</b> (active, spends your ultimate): land on a shield
       tile three times running, then teleport your least-advanced stone
       onto any enemy in shared water — capturing it plus every
       enemy stone caught between where it started and where it lands,
       through shields, Wards, and Bulwarks alike.</li>
     </ul>`,
  ],
  [
    `<h2>The Necromancer</h2>
     <ul>
       <li><b>Soul Harvest</b> (passive, free): your kills feed you. Every
       enemy stone you send home pays ${REVIVE_COST} mana — filling even
       your third gem, the SOUL GEM, which no other income can touch — and
       leaves its corpse marked on the tile where it fell. Only the
       freshest corpse keeps its soul.</li>
       <li><b>Soul Claim</b>: while your mana is full, the marked
       body cannot re-enter from the enemy's hand — the soul is yours
       until you spend it. Spend below full and they may reclaim it.</li>
       <li><b>Corpse Explosion</b> (active, ${CORPSE_EXPLOSION_COST} mana):
       detonate the marked corpse instead of raising it — every unprotected
       enemy stone beside the grave is blasted a tile back, all the way
       home if nothing's free behind it. The blast desecrates the corpse:
       no thrall, and its casualties yield no mana.</li>
     </ul>`,
    `<div class="runner">The Necromancer &middot; continued</div>
     <ul>
       <li><b>Revive</b> (active, spends all ${REVIVE_COST} mana): raise
       the marked corpse as your THRALL, on the very tile it died. For
       ${THRALL_TURNS} of your turns it fights for you — it moves on your
       flips, kills like any stone (its kills pay full mana and mark new
       corpses), and its blade ignores the Mage's Ward — but it can never
       leave shared water, and then it crumbles home. Your flip stands:
       the risen dead may be the one that moves.</li>
       <li><b>Exhume</b> (active, spends your ultimate): land on a shield
       tile three times running and death honors no finish line — drag one
       of the opponent's ESCAPED stones back aboard at tile
       ${EXHUME_RETURN_POSITION + 1}, or the nearest free tile behind it,
       to sail the home stretch all over again. The one power in the game
       that can undo an escape.</li>
     </ul>`,
  ],
  [
    `<h2>The Cleric</h2>
     <ul>
       <li><b>Bless</b> (active, ${BLESS_COST} mana, keeps your turn): a
       quick prayer grants one of your stones a SECOND LIFE. The first
       blow that would kill it only <span class="gold">wounds</span> it —
       the stone survives, staggering back only if the attacker needs its
       tile, and the attacker earns just one mana for breaking the light.
       Bless, then still make your move.</li>
       <li>The light shelters <span class="gold">${BLESSING_CAP} at a
       time</span> — one stone always stands outside it. Ultimates kill
       straight through a blessing, and a blessed stone's own strikes
       carry the light through the Mage's Ward.</li>
       <li><b>Heal</b> (active, ${HEAL_COST} mana): lay hands on a wounded
       stone and its blessing burns again. Mending takes your whole turn —
       a broken blessing is a real setback, not a free bounce-back.</li>
     </ul>`,
    `<div class="runner">The Cleric &middot; continued</div>
     <ul>
       <li><b>Sanctified Ground</b> (passive, free): the shield tiles are
       holy ground to you. Land on one and ALL your wounded stones are
       mended back to blessed — on top of the extra turn and mana every
       shield landing already grants.</li>
       <li><b>Benediction</b> (active, spends your ultimate): land on a
       shield tile three times running, then bless your ENTIRE on-board
       army at once — every unblessed and wounded stone rises under the
       light together, beyond the usual shelter of ${BLESSING_CAP}.</li>
     </ul>
     <p>The Cleric wins by refusing to lose stones: each blessing costs the
     enemy a full extra blow, and the army that keeps its crew keeps the
     race.</p>`,
  ],
  [
    `<h2>The Rogue</h2>
     <ul>
       <li><b>Larceny</b> (passive, free): every stone you send home for
       good pays twice — your own mana climbs as usual, and
       ${PICKPOCKET_STEAL} mana drains straight out of the enemy's pocket
       too. A wound doesn't count; only a real kill pays.</li>
       <li><b>Pickpocket</b> (active, ${PICKPOCKET_COST} mana, keeps your
       turn): reach into an enemy stone's pocket in shared water and lift
       ${PICKPOCKET_STEAL} mana — no fight, and no protection stops you,
       since nothing is actually striking the stone. Pick the pocket, then
       still make your move.</li>
       <li><b>Vanish</b> (active, ${VANISH_COST} mana): slip one of your
       own stones into the shadows — it can't be captured, swept, or
       targeted by any ability (an ultimate still finds it). Fades after
       a few turns, or the moment it saves the stone. The Rogue's own
       answer to the Mage's Ward and the Warrior's Bulwark.</li>
     </ul>`,
    `<div class="runner">The Rogue &middot; continued</div>
     <ul>
       <li><b>Grand Heist</b> (active, spends your ultimate): land on a
       shield tile three times running, then teleport your furthest-along
       stone onto any enemy in shared water and take it — straight through
       shields, Wards, and Bulwarks — then empty their ENTIRE bank on the
       spot. A capture and a robbery in the same breath.</li>
     </ul>
     <p>The Rogue wins by making the enemy poor: every kill drains their
     purse as well as their stone, and a well-timed Pickpocket can drop a
     Mage's Ward or starve a Cleric's next prayer without a fight at
     all.</p>`,
  ],
];

const guideOverlay = document.getElementById("guide-overlay") as HTMLDivElement;
const guideBook = document.getElementById("guide-book") as HTMLDivElement;
const guideLeft = document.getElementById("guide-left") as HTMLDivElement;
const guideRight = document.getElementById("guide-right") as HTMLDivElement;
const guideDots = document.getElementById("guide-dots") as HTMLDivElement;
/** Compact = one page per view (narrow screens). */
const guideCompact = window.matchMedia("(max-width: 740px)");
/** Spread index in full mode; PAGE index (spread*2 or +1) in compact mode. */
let guidePos = 0;

function renderGuide() {
  const compact = guideCompact.matches;
  guideBook.classList.toggle("compact", compact);
  if (compact) {
    guideLeft.innerHTML = GUIDE_SPREADS.flat()[guidePos];
  } else {
    const [l, r] = GUIDE_SPREADS[guidePos];
    guideLeft.innerHTML = l;
    guideRight.innerHTML = r;
  }
  const spreadOn = compact ? Math.floor(guidePos / 2) : guidePos;
  guideDots.innerHTML = GUIDE_SPREADS.map(
    (_, i) => `<span data-goto="${i}"${i === spreadOn ? ' class="on"' : ""}></span>`,
  ).join("");
  // retrigger the page-flip animation
  guideBook.classList.remove("flip");
  void guideBook.offsetWidth;
  guideBook.classList.add("flip");
}

function turnGuide(dir: number) {
  const count = guideCompact.matches ? GUIDE_SPREADS.length * 2 : GUIDE_SPREADS.length;
  const next = guidePos + dir;
  if (next < 0 || next >= count) return;
  guidePos = next;
  renderGuide();
}

function jumpToSpread(spread: number) {
  guidePos = guideCompact.matches ? spread * 2 : spread;
  renderGuide();
}

// Rotating/resizing while the book is open: keep the same spread in view.
guideCompact.addEventListener("change", () => {
  guidePos = guideCompact.matches ? guidePos * 2 : Math.floor(guidePos / 2);
  if (guideOverlay.classList.contains("show")) renderGuide();
});

(document.getElementById("guide-toggle") as HTMLButtonElement).addEventListener("click", () => {
  guidePos = 0; // the book always opens on its contents page
  renderGuide();
  guideOverlay.classList.add("show");
});
(document.getElementById("guide-close") as HTMLButtonElement).addEventListener("click", () => {
  guideOverlay.classList.remove("show");
});
(document.getElementById("guide-prev") as HTMLButtonElement).addEventListener("click", () => turnGuide(-1));
(document.getElementById("guide-next") as HTMLButtonElement).addEventListener("click", () => turnGuide(1));
guideOverlay.addEventListener("click", (e) => {
  if (e.target === guideOverlay) guideOverlay.classList.remove("show");
});
// One delegated handler: TOC entries + dots jump, otherwise tapping a page
// turns it (right/forward, left/back — in compact mode any tap reads on).
guideBook.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const link = t.closest("[data-goto]") as HTMLElement | null;
  if (link) {
    jumpToSpread(Number(link.dataset.goto));
    return;
  }
  if (t.closest("#guide-right") || (guideCompact.matches && t.closest("#guide-left"))) turnGuide(1);
  else if (t.closest("#guide-left")) turnGuide(-1);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") guideOverlay.classList.remove("show");
});

// PWA: register the service worker (no-op on unsupported browsers/dev).
if ("serviceWorker" in navigator && location.hostname !== "localhost") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Install as an app — a real "download & install" flow, no store.
//   - Chrome/Edge/Android fire beforeinstallprompt: we stash it and show the
//     menu's "Install Regatta" button, which opens the native install dialog.
//   - iOS Safari has no prompt API: if we're on iOS and not already installed,
//     show the button anyway and explain Add-to-Home-Screen.
//   - Already installed (standalone) or unsupported: button stays hidden.
// ---------------------------------------------------------------------------
{
  const menuInstallBtn = document.getElementById("menu-install") as HTMLButtonElement;
  const cornerInstallBtn = document.getElementById("install-toggle") as HTMLButtonElement;
  const installButtons = [menuInstallBtn, cornerInstallBtn];
  const iosModal = document.getElementById("ios-install") as HTMLDivElement;
  const iosClose = document.getElementById("ios-install-close") as HTMLButtonElement;

  interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  }
  let deferredPrompt: BeforeInstallPromptEvent | null = null;

  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  // iPadOS ships a "Macintosh" user agent (desktop-class Safari), so the
  // classic regex misses iPads — but no real Mac has a touchscreen, so a
  // "Mac" with any touch points is an iPad.
  const isIOS =
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 0);

  const showInstall = () => installButtons.forEach((b) => b.classList.add("show"));
  const hideInstall = () => installButtons.forEach((b) => b.classList.remove("show"));

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    showInstall();
  });

  // iOS never fires the event, so surface the button for the manual path.
  if (isIOS && !isStandalone) showInstall();

  const doInstall = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      hideInstall();
    } else if (isIOS) {
      iosModal.classList.add("show");
    }
  };
  menuInstallBtn.addEventListener("click", doInstall);
  cornerInstallBtn.addEventListener("click", doInstall);

  iosClose.addEventListener("click", () => iosModal.classList.remove("show"));
  iosModal.addEventListener("click", (e) => {
    if (e.target === iosModal) iosModal.classList.remove("show");
  });
  window.addEventListener("appinstalled", hideInstall);
}

// ---------------------------------------------------------------------------
// Captain's Notices — the update log. Studio-style version notes, shown ONCE
// per release when a player opens the game to the menu (remembered in
// localStorage by the newest entry's id), and reopenable any time from the
// menu's "What's new" line. Entries are newest-first; the copy is
// player-facing tavern voice, telling people what to LOOK FOR, not a diff.
// ---------------------------------------------------------------------------
const UPDATE_LOG: { id: string; date: string; title: string; items: string[] }[] = [
  {
    id: "2026-07-22-the-vanishing",
    date: "July 22, 2026",
    title: "The Vanishing",
    items: [
      "<b>Backstab is retired — Vanish takes its place.</b> Every other class had a defensive trick (the Mage's Ward, the Warrior's Bulwark, the Cleric's Blessing); the Rogue had none. Now it does.",
      "<b>Vanish</b> (1 mana): slip one of your own stones into the shadows — it can't be captured, swept, or targeted by any ability. Fades after a couple of turns, or the moment it actually saves the stone. Ultimates still find it.",
      "<b>Larceny hits harder</b> — the mana every real kill drains from the enemy's pocket is doubled, so the class's own steal-and-run identity carries more of the weight now that Backstab isn't around to do it alone.",
    ],
  },
  {
    id: "2026-07-21-the-take",
    date: "July 21, 2026",
    title: "The Take",
    items: [
      "<b>A sixth captain takes the table: the ROGUE.</b> Pick the moonlit seal at the class table — a thief plays for the enemy's purse, not just their stones.",
      "<b>Larceny</b> (passive): every stone you send home for good drains a mana straight out of the enemy's pocket too, on top of your own income. A wound doesn't count — only a real kill pays.",
      "<b>Pickpocket</b> (1 mana, and it KEEPS your turn): reach into an enemy stone's pocket in shared water and lift a mana — no fight, and no Ward, Bulwark, or shield tile stops you, since nothing is actually striking the stone.",
      "<b>Backstab</b> (2 mana): a guaranteed strike at an enemy in shared water. Wards mean nothing to it — a Bulwark still turns it away, and a Blessed stone survives as a wound instead of a kill, same as any other blow.",
      "<b>Grand Heist</b> (ultimate): three shield landings in a row, then teleport your furthest-along stone onto any enemy in shared water and take it — straight through shields, Wards, and Bulwarks — then empty their entire bank on the spot.",
      "<b>A Mage caught below full bank loses the Ward instantly</b> — Pickpocket is the one tool in the game that can force that without a single capture.",
    ],
  },
  {
    id: "2026-07-21-the-light-arrives",
    date: "July 21, 2026",
    title: "The Light Arrives",
    items: [
      "<b>A fifth captain takes the table: the CLERIC.</b> Pick the gold seal at the class table and refuse to trade stones at all.",
      "<b>Bless</b> (2 mana, and it KEEPS your turn): a quick prayer gives one of your stones a <b>second life</b>. The first blow that would kill it only <b>wounds</b> it — the stone survives and the attacker walks away with one mana for their trouble. Speak the prayer, then still make your move.",
      "<b>The light shelters three at a time.</b> One stone always stands outside it — choose well. Ultimates kill straight through a blessing, so mind the shield-streak chasers.",
      "<b>Heal</b> (2 mana): lay hands on a wounded stone and its blessing burns again. Mending takes the whole turn — a broken blessing is a real setback.",
      "<b>Sanctified Ground</b> (passive): shield tiles are holy ground — land on one and ALL your wounded stones mend at once.",
      "<b>Benediction</b> (ultimate): three shield landings in a row, then bless your entire on-board army in one breath.",
      "<b>The blessed blade:</b> a blessed stone's own strikes carry the light straight through the Mage's Ward.",
      "<b>Gold rings on the water:</b> a blessed stone wears a slow gold halo; a wounded one wears it ashen and dim. Tap either for the full story, as always.",
    ],
  },
  {
    id: "2026-07-20-dead-fight-back",
    date: "July 20, 2026",
    title: "The Dead Fight Back",
    items: [
      "<b>Charges are MANA now.</b> One word, one meaning: abilities cost mana, and the Warrior's Charge is just the Charge again.",
      "<b>The Necromancer, reforged.</b> His kills now pay <b>3 mana</b> and mark the fallen enemy's corpse on the tile where it died. Fill all three crystals — the round third one is the <b>Soul Gem</b>, and only a kill can light it — then cast <b>Revive</b>: the corpse rises as your <b>thrall</b> and fights for YOU for three of your turns.",
      "<b>Chain necromancy.</b> A thrall's kills pay full mana and mark fresh corpses. Keep killing and the graveyard keeps giving.",
      "<b>Corpse Explosion.</b> The grave's second rite: spend 2 mana to detonate the marked corpse instead — every unprotected enemy beside it is blasted back, all the way home if nothing's free behind. Burn it now, or raise it at a full bank.",
      "<b>Soul Claim.</b> While your mana is full, the marked body cannot re-enter play — the soul is yours until you spend it.",
      "<b>Tap anything glowing.</b> Every mark on the board now explains itself — tap a thrall, a Ward, a Bulwark, a shield tile, or the grave itself for a card telling you exactly what it does and how long it lasts.",
      "<b>A claimed stone tells you so.</b> When the enemy Necromancer holds your fallen stone's soul, the piece waiting in your hand wears their cold shackle-ring — tap it to see why it can't be played and what breaks the claim.",
      "<b>The graveyard reads at a glance.</b> Corpses are little gravestones now (no more X), and possession runs on temperature: YOUR thrall wears a warm red shackle-ring with a floating turns-left counter, the enemy's glows cold blue — even in a Necromancer mirror you always know whose dead are whose.",
      "<b>Your whole kit, always in view.</b> Passives now sit around your avatar with the rest of your abilities — tap any gem to read it. The Mage's Ward gem glows only while the Ward is truly up; the Archer's Rain of Arrows lights when it's one shield landing from firing.",
      "<b>The dead feel no magic.</b> A thrall's blade ignores the Mage's Ward. Shields and Bulwarks still stop it.",
      "<b>Reinforced Bulwark holds the line.</b> Fixed: it no longer wears down from an archer merely LOOKING at it — only true blocks spend its saves.",
      "<b>Mirror duels read clean.</b> When both captains bring the same class, your rival's stones wear a cold slate sheen.",
      "<b>Smoother sailing.</b> Token animations no longer stutter in busy games (archers, that was you).",
      "<b>A sharper ship's log.</b> The Activity Log now counts stones 1–4 the way you do.",
    ],
  },
  {
    id: "2026-07-19-graveyard-opens",
    date: "July 19, 2026",
    title: "The Graveyard Opens",
    items: [
      "<b>A fourth captain takes the table:</b> the Necromancer arrives, skull sigil and all.",
      "<b>The ship's log:</b> tap the scroll on the rail for a full game log — rewind any moment and watch it replay.",
      "<b>The tavern sips less oil:</b> big battery and performance work for long sessions on iPad.",
    ],
  },
];
const UPDATE_SEEN_KEY = "regattaUpdateSeen";
const updateOverlay = document.getElementById("update-overlay") as HTMLDivElement;
const updateEntries = document.getElementById("update-entries") as HTMLDivElement;

function showUpdateLog() {
  updateEntries.innerHTML = UPDATE_LOG.map(
    (e) =>
      `<div class="update-entry"><div class="update-date">${e.date}</div>` +
      `<div class="update-name">${e.title}</div>` +
      `<ul>${e.items.map((i) => `<li>${i}</li>`).join("")}</ul></div>`,
  ).join("");
  updateEntries.scrollTop = 0;
  updateOverlay.classList.add("show");
}
function closeUpdateLog() {
  updateOverlay.classList.remove("show");
  // Dismissal = read: this release stops prompting on future opens.
  try {
    localStorage.setItem(UPDATE_SEEN_KEY, UPDATE_LOG[0].id);
  } catch {
    /* private mode etc. — they'll just see it again */
  }
}
(document.getElementById("update-close") as HTMLButtonElement).addEventListener("click", closeUpdateLog);
updateOverlay.addEventListener("click", (e) => {
  if (e.target === updateOverlay) closeUpdateLog();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && updateOverlay.classList.contains("show")) closeUpdateLog();
});
(document.getElementById("menu-whatsnew") as HTMLButtonElement).addEventListener("click", showUpdateLog);

/** Prompt exactly once per release, and only over the menu — a player
 *  deep-linking into a live room is never interrupted mid-join. */
function promptUpdateLogIfNew() {
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(UPDATE_SEEN_KEY);
  } catch {
    /* fall through to showing */
  }
  if (seen !== UPDATE_LOG[0].id) showUpdateLog();
}

// Startup routing: resume a live seat if we have one (page reload), else
// follow a ?room=CODE deep link, else show the mode menu.
{
  const linkedRoom = new URLSearchParams(location.search).get("room");
  const saved = loadSession();
  if (saved) {
    resumeSession(saved); // first poll resyncs the board; 404 → menu
  } else if (linkedRoom) {
    doJoin("join", linkedRoom.toUpperCase());
    hud.textContent = "Joining room…";
  } else {
    menuEl.classList.add("show");
    hud.textContent = "Pick a game mode";
    promptUpdateLogIfNew();
  }
}

// ---------------------------------------------------------------------------
// Render loop (with per-frame lerp toward marker targets for smooth motion)
// ---------------------------------------------------------------------------

let rafId = 0;
/** Stamped every frame — the watchdog below and the poll loop's hidden
 *  check both trust flowing frames over what the visibility API claims. */
let lastFrameAt = 0;
/** Last moment we KNOW the player was here (input, focus, visibility). */
let lastPresenceAt = 0;

/** Last frame we actually rendered (the governor may skip rAF callbacks). */
let lastRenderAt = 0;

/** Full-rate GRACE WINDOW — the governor's fail-safe. Enumerating kinetic
 *  states (sceneKinetic below) proved fragile: the archer's animation
 *  traffic (knockback lerps, double-capture flights, batched push/shot
 *  commits) surfaced paths the list missed, rendering flights at the calm
 *  30 fps pace — Kasen's "token moves glitch / go slow frames, archer
 *  games specifically" reports (2026-07-19/20). Any game event now BUYS a
 *  short window of full rate outright; the enumeration only decides how
 *  long full rate persists BEYOND the window (long flights, mug drinks).
 *  Battery cost is negligible — turns are seconds apart and idle time
 *  still dominates. */
let kineticUntil = 0;
function bumpKinetic(ms = 1500) {
  const until = performance.now() + ms;
  if (until > kineticUntil) kineticUntil = until;
}

/** Anything kinetic on the table RIGHT NOW — the states that deserve full
 *  frame rate. Ambient motion (fire flicker, breathing rings, motes, rune
 *  spin) is deliberately not on this list: it paces fine at 30. */
function sceneKinetic(): boolean {
  if (performance.now() < kineticUntil) return true;
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    if (m.mesh.visible && (m.flying || m.mesh.position.distanceToSquared(m.target) > 1e-6)) return true;
  }
  if (confirmStart > 0) return true;
  if (myMug?.anim != null || theirMug?.anim != null) return true;
  return allCoins.some((c) => c.isFlipping);
}

function tick() {
  rafId = requestAnimationFrame(tick);
  lastFrameAt = performance.now();
  const now = lastFrameAt;
  // ---- Frame governor — the iPad battery fix, round two. A turn-based
  // game spends most of its life with a still board; rendering the tavern
  // at 60 fps anyway was the drain. Full rate only while something kinetic
  // is happening (flights, lerps, coin tumbles, mug drinks); calm ambience
  // paces at ~30; behind a full-screen overlay (menu, win screen, class
  // pick, guide — where the scene is dimmed and blurred) ~15 is plenty,
  // which also slashes iOS's per-canvas-frame backdrop-blur repaints. All
  // scene animation is clock-driven, so a skipped callback costs nothing
  // visually — the next rendered frame lands on the same timeline.
  const overlayUp =
    menuEl.classList.contains("show") ||
    winScreen.classList.contains("show") ||
    classpickEl.classList.contains("show") ||
    guideOverlay.classList.contains("show") ||
    updateOverlay.classList.contains("show");
  const budgetMs = sceneKinetic() ? 0 : overlayUp ? 62 : 30;
  if (budgetMs > 0 && now - lastRenderAt < budgetMs) return;
  lastRenderAt = now;
  const lerp = 0.18;

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (!marker.mesh.visible) continue;

    // Position: either flying (capture/escape arc) or lerping to target.
    if (marker.flying) {
      const t = (now - marker.flightStart) / marker.flightDuration;
      if (t >= 1) {
        marker.mesh.position.copy(marker.flightTo);
        marker.mesh.quaternion.identity();
        marker.flying = false;
      } else {
        marker.mesh.position.lerpVectors(marker.flightFrom, marker.flightTo, t);
        marker.mesh.position.y += Math.sin(t * Math.PI) * marker.flightArcHeight;
        marker.mesh.setRotationFromAxisAngle(
          marker.flightSpinAxis,
          t * marker.flightSpinSpeed * Math.PI * 2,
        );
      }
    } else {
      marker.mesh.position.lerp(marker.target, lerp);
    }
  }
  // Movable stones wear a breathing gold ring on the ground — "stones you
  // may move light up", as the guide and tutorial promise. The affordance
  // lives entirely OFF the stone material, so the ward/bulwark status
  // tints stay visible on a movable stone. Ring visibility is recomputed
  // from eligibleTokenIds every frame — no restore bookkeeping to go stale.
  const breath = 0.5 + 0.5 * Math.sin(now * 0.0035); // ~1.8 s calm period
  const eased = breath * breath * (3 - 2 * breath); // smoothstep: linger, glide
  eligibleRingMat.opacity = 0.5 + 0.38 * eased;
  const ringScale = 0.97 + 0.06 * eased; // ring Ø 0.466–0.494, < tile pitch
  // Targeting mode composes with the SAME decals instead of stacking a
  // second affordance: while an ability is armed the gold "movable" rings
  // stand down and the rings re-point at the armed target set, tinted the
  // caster's class color (the ring texture is drawn white for exactly this).
  const ringIds = armed ? armed.targetIds : eligibleTokenIds;
  eligibleRingMat.color.setHex(armed ? DOCK_RING_TINTS[dockClass ?? "archer"] : 0xffc36a);
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const ring = ringMeshes[i];
    ring.visible =
      marker.mesh.visible && !marker.flying && ringIds.has(i);
    if (!ring.visible) continue;
    ring.position.set(
      marker.mesh.position.x,
      marker.target.y + ELIGIBLE_RING_Y_OFFSET,
      marker.mesh.position.z,
    );
    ring.scale.setScalar(ringScale);
  }
  // Tap-confirm pulse: the committed stone's ring pops out and fades.
  if (confirmStart > 0) {
    const t = (now - confirmStart) / CONFIRM_PULSE_MS;
    if (t >= 1) {
      confirmStart = 0;
      confirmRing.visible = false;
    } else {
      const out = 1 - Math.pow(1 - t, 3); // ease-out cubic
      confirmRing.scale.setScalar(1 + 0.32 * out);
      (confirmRing.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - out);
    }
  }
  // Protection rigs ride their stones: class-colored rune-ring decal on the
  // ground, translucent dome (Bulwark) over the stone itself. Hidden while
  // the stone is mid-flight, same as the movable rings.
  for (let i = 0; i < statusRigs.length; i++) {
    const rig = statusRigs[i];
    const mark = statusMarks[i];
    const marker = mark ? markers[mark.idx] : null;
    if (!mark || !marker || !marker.mesh.visible || marker.flying) {
      rig.ring.visible = rig.dome.visible = false;
      continue;
    }
    // Possession swaps in the chain ring, tinted by the POSSESSOR's side
    // temperature (warm = the viewer's own thrall, cold slate = the
    // enemy's) — the mirror-match read Kasen asked for. Everything else
    // keeps the class-colored rune ring.
    if (mark.kind === "thrall" || mark.kind === "soulClaim") {
      const id = mark.idx;
      const owner = (["p1", "p2"] as PlayerId[]).find((pl) =>
        mark.kind === "thrall"
          ? currentPower?.thrall?.[pl]?.tokenId === id
          : currentPower?.corpse?.[pl]?.tokenId === id,
      );
      if (rig.ringMat.map !== chainRingTex) {
        rig.ringMat.map = chainRingTex;
        rig.ringMat.needsUpdate = true;
      }
      rig.ringMat.color.setHex(owner && viewSide(owner) === "p1" ? 0xd94a45 : 0x7e9bd6);
    } else {
      if (rig.ringMat.map !== statusRingTex) {
        rig.ringMat.map = statusRingTex;
        rig.ringMat.needsUpdate = true;
      }
      rig.ringMat.color.setHex(STATUS_TINTS[mark.kind]);
    }
    rig.ring.visible = true;
    rig.ring.position.set(
      marker.mesh.position.x,
      marker.target.y + ELIGIBLE_RING_Y_OFFSET + 0.004,
      marker.mesh.position.z,
    );
    if (mark.kind === "shieldTile") {
      // Quiet shelter: smaller, faint, still — information, not spectacle.
      rig.ring.rotation.z = 0;
      rig.ringMat.opacity = 0.2 + 0.06 * Math.sin(now * 0.0011 + i);
      rig.ring.scale.setScalar(0.88);
    } else if (mark.kind === "thrall" || mark.kind === "soulClaim") {
      // The shackle doesn't spin — it sits heavy, breathing slow. On a
      // reserve stone it's smaller (the hand slots sit tighter).
      rig.ring.rotation.z = 0;
      rig.ringMat.opacity = 0.62 + 0.16 * Math.sin(now * 0.0016 + i);
      rig.ring.scale.setScalar(mark.kind === "soulClaim" ? 0.8 : 1.02);
    } else if (mark.kind === "blessed" || mark.kind === "wounded") {
      // The blessing is a steady halo: a slow, calm turn while whole;
      // ashen, near-still and smaller once broken — the pair reads as one
      // story dimming.
      const whole = mark.kind === "blessed";
      rig.ring.rotation.z = now * (whole ? 0.00025 : 0.0001) + i * 1.3;
      rig.ringMat.opacity = whole
        ? 0.5 + 0.18 * Math.sin(now * 0.0018 + i)
        : 0.26 + 0.08 * Math.sin(now * 0.0012 + i);
      rig.ring.scale.setScalar(whole ? 1 : 0.92);
    } else {
      // Ward spins with intent; Bulwark/Vanish turn slow and heavy — same
      // underlying protection, so the same weight.
      const shielded = mark.kind === "bulwark" || mark.kind === "vanish";
      rig.ring.rotation.z = now * (shielded ? 0.00035 : 0.0009) + i * 1.3;
      rig.ringMat.opacity = 0.5 + 0.22 * Math.sin(now * 0.0026 + i * 2.1);
      rig.ring.scale.setScalar(1);
    }
    const domed = mark.kind === "bulwark" || mark.kind === "vanish";
    rig.dome.visible = domed;
    if (domed) {
      rig.domeMat.color.setHex(STATUS_TINTS[mark.kind as "bulwark" | "vanish"]);
      rig.dome.position.set(
        marker.mesh.position.x,
        marker.mesh.position.y - 0.08, // token base — hemisphere wraps the coin
        marker.mesh.position.z,
      );
      const swell = 1 + 0.035 * Math.sin(now * 0.0032 + i);
      rig.dome.scale.set(swell, swell * 0.85, swell);
      rig.domeMat.opacity = 0.11 + 0.05 * Math.sin(now * 0.004 + i * 1.7);
    }
  }
  // Thrall countdown badges ride their stones (screen-projected DOM) —
  // hidden behind overlays, during history scrubs, and mid-flight.
  (["p1", "p2"] as PlayerId[]).forEach((side, bi) => {
    const el = thrallBadges[bi];
    const th = currentPower?.thrall?.[side] ?? null;
    const marker = th ? markers[th.tokenId] : null;
    if (!th || !marker || !marker.mesh.visible || marker.flying || overlayUp || viewingHistory()) {
      el.classList.remove("show");
      return;
    }
    const v = marker.mesh.position.clone();
    v.y += 0.62;
    v.project(camera);
    el.style.left = `${((v.x * 0.5 + 0.5) * window.innerWidth).toFixed(1)}px`;
    el.style.top = `${((-v.y * 0.5 + 0.5) * window.innerHeight).toFixed(1)}px`;
    el.textContent = String(th.turnsLeft);
    el.classList.toggle("theirs", viewSide(side) !== "p1");
    el.classList.add("show");
  });
  // Gentle breathing on the capture-hover glow.
  if (hoverGlow.visible) {
    (hoverGlow.material as THREE.MeshBasicMaterial).opacity =
      0.8 + 0.2 * Math.abs(Math.sin(now * 0.0035));
  }
  // Roll cue: steady halo around my coins only while they wait to be tapped.
  myCoinGlow.visible = rollPending !== null || openingTapArmed;
  // Fire flicker: stacked sines read surprisingly flame-like.
  const flick =
    4.5 * Math.sin(now * 0.011) + 3.2 * Math.sin(now * 0.023 + 1.7) + 2.4 * Math.sin(now * 0.047 + 0.6);
  fireLight.intensity = Math.max(fireCfg.intensity * 0.4, fireCfg.intensity + fireCfg.flicker * flick);
  const fs = 1 + fireCfg.flicker * (0.06 * Math.sin(now * 0.017 + 0.3) + 0.05 * Math.sin(now * 0.041));
  fireSprite.scale.set(fireCfg.size * fs, fireCfg.size * 0.73 * fs, 1);
  (fireSprite.material as THREE.SpriteMaterial).opacity =
    fireCfg.opacity + 0.2 * fireCfg.flicker * Math.abs(Math.sin(now * 0.013));
  updateMotes(now);
  updateCoins(now);
  updateMugs(now);
  myMugGlow.visible = myAvailableSips() > 0;
  if (myMugGlow.visible)
    coach(
      "swig",
      "Your mug glows — every stone brought home earns a swig. Tap the mug and drink to the crossing.",
    );
  // Shadow pass only while a caster is moving (stones in flight or still
  // lerping home, coins tumbling, a mug mid-drink) or a load marked it.
  let casterMoving = shadowsDirty;
  if (!casterMoving) {
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      if (m.mesh.visible && (m.flying || m.mesh.position.distanceToSquared(m.target) > 1e-6)) {
        casterMoving = true;
        break;
      }
    }
  }
  if (!casterMoving)
    casterMoving =
      allCoins.some((c) => c.isFlipping) || myMug?.anim != null || theirMug?.anim != null;
  renderer.shadowMap.needsUpdate = casterMoving;
  shadowsDirty = false;
  renderer.render(scene, camera);
}
tick();

// ---------------------------------------------------------------------------
// Render-loop watchdog — THE fix for "the board freezes after an app switch".
//
// iOS Safari (worst as an installed PWA) sometimes returns from an app
// switch with requestAnimationFrame still suspended — and occasionally with
// visibilityState stuck on "hidden" — so no visibility event ever fires and
// the canvas freezes on its last frame while the DOM, timers, and polling
// all run on: dead game showing behind the menu, mug stuck mid-pose, but
// taps still land. (The WebGL context itself stays alive, which is why the
// context-loss recovery above never triggers for this.)
//
// Interval timers demonstrably DO keep firing in that state, so: watch for
// stalled frames and re-kick the loop by hand. Each kick re-frames (resize
// also rebuilds the drawing buffer, which un-ghosts the compositor layer)
// and renders immediately — so even if rAF stays wedged the game runs at
// watchdog cadence instead of freezing, and the instant iOS unwedges rAF,
// full frame rate resumes and the watchdog goes quiet. Presence-gated so a
// genuinely backgrounded tab stays as cheap as before.
// ---------------------------------------------------------------------------
window.addEventListener("pointerdown", () => (lastPresenceAt = performance.now()), {
  capture: true,
  passive: true,
});
window.addEventListener("focus", () => (lastPresenceAt = performance.now()));
window.addEventListener("pageshow", () => (lastPresenceAt = performance.now()));
document.addEventListener("visibilitychange", () => (lastPresenceAt = performance.now()));
let wedgeKicks = 0;
let wedgeFallback: number | null = null;
setInterval(() => {
  if (performance.now() - lastFrameAt < 2000) {
    wedgeKicks = 0; // frames are flowing — all good
    return;
  }
  const userPresent = performance.now() - lastPresenceAt < 30_000;
  if (document.hidden && !userPresent) return; // truly backgrounded: stay quiet
  cancelAnimationFrame(rafId); // no double chains when rAF wakes back up
  // Rebuild the drawing buffer ONCE per wedge episode — the old
  // resize()-every-second turned a wedged-rAF session into a 1 fps
  // buffer-reallocation grind (heat + "runs slow as if on low battery").
  if (wedgeKicks === 0) resize();
  wedgeKicks++;
  // Still wedged after two kicks: iOS isn't giving rAF back. Drive frames
  // from a ~30 fps timer instead (timers demonstrably fire in this state);
  // it retires itself the moment real rAF frames resume.
  if (wedgeKicks >= 2 && wedgeFallback === null) {
    wedgeFallback = window.setInterval(() => {
      if (performance.now() - lastFrameAt < 25) {
        clearInterval(wedgeFallback!);
        wedgeFallback = null;
        return; // rAF is healthy again — hand the loop back
      }
      cancelAnimationFrame(rafId);
      tick();
    }, 33);
  }
  tick();
}, 1000);

// ---------------------------------------------------------------------------
// Dev-only Ability Dock harness (localhost, ?dockdemo[=class] — mirrors the
// ?sips gate above): parks the menu and cycles the dock through every visual
// state on a timer, since the ultimate states are painful to reach by hand
// (3 shield landings in a row). Display-only — no session exists, so
// nothing the dock arms or "fires" can ever reach the wire.
// ---------------------------------------------------------------------------
const dockDemoParam =
  location.hostname === "localhost" ? new URLSearchParams(location.search).get("dockdemo") : null;
if (dockDemoParam !== null) {
  const cls: PlayerClass = ["archer", "mage", "warrior", "necromancer", "cleric", "rogue"].includes(dockDemoParam)
    ? (dockDemoParam as PlayerClass)
    : "warrior";
  menuEl.classList.remove("show");
  myVariant = "masterKiller";
  hud.textContent = `dockdemo: ${cls}`;
  const demoStates: { label: string; charges: number; ult: boolean; active: boolean; reflips: number }[] = [
    { label: "off-turn", charges: 1, ult: false, active: false, reflips: 0 },
    { label: "broke", charges: 0, ult: false, active: true, reflips: 0 },
    { label: "one charge", charges: 1, ult: false, active: true, reflips: 0 },
    { label: "full bank", charges: 2, ult: false, active: true, reflips: 0 },
    { label: "ultimate up", charges: 2, ult: true, active: true, reflips: 1 },
    { label: "spent", charges: 1, ult: true, active: true, reflips: 2 },
  ];
  let demoStep = 0;
  const applyDemo = () => {
    const d = demoStates[demoStep % demoStates.length];
    currentPower = {
      classes: { p1: cls, p2: "archer" },
      charges: { p1: d.charges, p2: 1 },
      pushTargets: [4, 5],
      chargedShotTargets: [4],
      ultimateReady: { p1: d.ult, p2: false },
      blinkStrikeTargets: d.ult ? [4, 5] : [],
      warpathTargets: d.ult ? [4] : [],
      bulwarkTargets: [0, 1, 2],
      bulwarkedTokenIds: [],
      reflipsUsedThisTurn: d.reflips,
      // Necromancer demo pools mirror the server's gating: Revive needs a
      // full soul bank + a marked corpse, exhume the ultimate.
      corpse: { p1: cls === "necromancer" && d.charges > 0 ? { tokenId: 4, tile: 8 } : null, p2: null },
      thrall: { p1: null, p2: null },
      reviveSpawnTile: cls === "necromancer" && d.charges >= REVIVE_COST ? 8 : null,
      exhumeTargets: cls === "necromancer" && d.ult ? [4] : [],
      pickpocketTargets: cls === "rogue" && d.charges >= PICKPOCKET_COST ? [4] : [],
      vanishTargets: cls === "rogue" && d.charges >= VANISH_COST ? [0, 1, 2] : [],
      grandHeistTargets: cls === "rogue" && d.ult ? [4] : [],
    };
    currentPowerMoves =
      cls === "warrior"
        ? [
            {
              tokenId: 1,
              from: 2,
              to: 5,
              captures: [],
              bonusCaptures: [],
              landsOnShield: false,
              causesWin: false,
              breaksWard: false,
              chargeAvailable: true,
              chargeSweepCaptures: [],
            },
          ]
        : null;
    setStatus(`dockdemo: ${d.label}`, "ok");
    updatePlates(null); // the plate the dock anchors to — true composition
    updateDock(d.active);
    demoStep++;
  };
  applyDemo();
  // Pause the carousel while something is armed — aiming freezes the state
  // so targeting mode can actually be inspected.
  setInterval(() => {
    if (!armed) applyDemo();
  }, 3000);
}

// ---------------------------------------------------------------------------
// Dev-only protection-VFX harness (localhost, ?vfx — same gate family as
// ?sips / ?dockdemo): parks the menu and poses one deterministic mid-game
// tableau exercising every protection rig — Mage warded on a sword tile,
// stones sheltering on shield tiles, a Bulwarked Warrior stone, a Ward
// Breaker-safe stone — through the REAL refreshMarkers/updateTokenTints
// path, so what it shows is exactly what a live game shows. Display-only;
// no session exists.
// ---------------------------------------------------------------------------
if (location.hostname === "localhost" && new URLSearchParams(location.search).has("vfx")) {
  menuEl.classList.remove("show");
  myVariant = "masterKiller";
  hud.textContent = "vfx demo";
  ensureMkPieces();
  const demoState: GameState = {
    tokens: [
      { id: 0, owner: "p1", position: 5 }, // most advanced mage stone → Warded
      { id: 1, owner: "p1", position: 3 }, // own-row shield tile → sheltering
      { id: 2, owner: "p1", position: 0 },
      { id: 3, owner: "p1", position: -1 },
      { id: 4, owner: "p2", position: 7 }, // middle shield tile → sheltering
      { id: 5, owner: "p2", position: 9 }, // Bulwarked
      { id: 6, owner: "p2", position: 4 }, // plain contested-row stone
      { id: 7, owner: "p2", position: -1 },
    ],
    currentPlayer: "p1",
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  currentPower = {
    classes: { p1: "mage", p2: "warrior" },
    charges: { p1: CHARGE_CAP, p2: 1 }, // full bank → the Mage ward is up
    pushTargets: [],
    chargedShotTargets: [],
    ultimateReady: { p1: false, p2: false },
    blinkStrikeTargets: [],
    warpathTargets: [],
    bulwarkTargets: [],
    bulwarkedTokenIds: [5],
    reflipsUsedThisTurn: 0,
  };
  refreshMarkers(demoState);
  updateTokenTints(demoState);
}

// ---------------------------------------------------------------------------
// Dev-only Activity Log harness (localhost, ?logdemo[=select] — same gate
// family as ?vfx / ?dockdemo): drives a SEEDED CPU-vs-CPU Master Killer game
// through the REAL client pipeline — every commit lands via viewFor →
// processResponse, so the activity log, board, plates and scrubber behave
// exactly as a live game's would, deterministically. `?logdemo=select`
// additionally rewinds to the most diagnostic frame (a Bulwark block or a
// Dark Resurrection if the seed produced one, else the last capture) so a
// single screenshot verifies list + rewind + effects. Engine modules load
// via dynamic import so this whole harness code-splits out of the
// production path.
// ---------------------------------------------------------------------------
if (location.hostname === "localhost" && new URLSearchParams(location.search).has("logdemo")) {
  void (async () => {
    const eng = await import("../../room-engine.ts");
    const { pickBotPowerAction } = await import("../../master-killer-bot.ts");
    const mulberry32 = (seed: number) => () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const rand = mulberry32(20260719);
    let now = 1_000_000;
    let doc = eng.createRoomDoc("LOGDEMO", true, "masterKiller", "p1tok", now, false, "standard");
    myRole = "p1";
    menuEl.classList.remove("show");
    hud.textContent = "logdemo: playing…";
    let seq = 0;
    for (let steps = 0; steps < 900 && !doc.state.winner; steps++) {
      now += 5000;
      doc = eng.tick(doc, now, rand);
      if (doc.phase === "classPick" && !doc.classesPicked.p1) {
        doc = eng.applyAction(doc, "p1", { op: "pickClass", class: "necromancer" }, now).doc;
      } else if (doc.phase === "opening" && doc.openingFlips.p1 === null) {
        doc = eng.applyAction(doc, "p1", { op: "openingFlip" }, now).doc;
      } else if (
        doc.phase === "play" &&
        !doc.state.winner &&
        doc.state.currentPlayer === "p1" &&
        doc.currentFlip !== null &&
        doc.mk
      ) {
        const moves = doc.currentPowerMoves ?? [];
        const action = pickBotPowerAction(doc.state, eng.fromWirePower(doc.mk), moves, doc.currentFlip, rand, "standard");
        if (action) {
          const input =
            action.kind === "move"
              ? { op: "chooseMove", moveIndex: moves.indexOf(action.move) }
              : action.kind === "charge"
                ? { op: "usePower", action: { kind: "charge", moveIndex: moves.indexOf(action.move) } }
                : { op: "usePower", action };
          const r = eng.applyAction(doc, "p1", input as Parameters<typeof eng.applyAction>[2], now);
          if (!r.error) doc = r.doc;
        }
      }
      const v = eng.viewFor(doc, "p1", seq, now);
      if (v.latestSeq > seq) {
        processResponse(v as unknown as RoomResponse);
        seq = v.latestSeq;
      }
    }
    clearProcQueue(); // the burst queued a game's worth of banners — drop them
    logPanel.classList.add("open");
    renderLogList();
    if (new URLSearchParams(location.search).get("logdemo") === "select") {
      let pick = -1;
      for (let i = activityLog.length - 1; i >= 0 && pick < 0; i--) {
        const e = activityLog[i];
        if (e.kind === "state" && (e.lastBulwarkBlock || e.lastRevive)) pick = i;
      }
      for (let i = activityLog.length - 1; i >= 0 && pick < 0; i--) {
        const e = activityLog[i];
        if (e.kind === "state" && e.lastMove && e.lastMove.captures.length > 0) pick = i;
      }
      if (pick >= 0) enterHistory(pick);
    }
    hud.textContent = `logdemo: ${activityLog.length} events · winner ${doc.state.winner ?? "none"}`;
  })();
}

