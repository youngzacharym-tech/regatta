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
  CHARGED_SHOT_DISTANCE,
  CHARGED_SHOT_WARD_DISTANCE,
  isWarded,
  REFLIPS_PER_TURN,
  type PlayerClass,
  type PowerMove,
  type PowerState,
} from "../../master-killer.ts";

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
// shrinks a quarter. mug.glb ships as mug_body + mug_foam (foam pivoted at
// the rim so scaling its Y squashes the head down into the tankard).
interface MugRig {
  root: THREE.Group;
  foam: THREE.Object3D | null;
  basePos: THREE.Vector3;
  baseRotY: number;
  /** Sips taken (0..4). 4 = slammed empty. */
  sips: number;
  anim: { start: number; kind: "sip" | "slam" } | null;
}
let myMug: MugRig | null = null;
let theirMug: MugRig | null = null;
const FOAM_SCALES = [1, 0.68, 0.42, 0.2, 0.0001];

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
      return {
        root: mug,
        foam: mug.getObjectByName("mug_foam") ?? null,
        basePos: mug.position.clone(),
        baseRotY: rotY,
        sips: 0,
        anim: null,
      };
    };
    myMug = place(0.5, 2.12, -2.44); // beside my coins, handle turned out
    theirMug = place(0.5, -2.0, 2.4); // the opponent's, across the table
  },
  undefined,
  (err) => console.error("Failed to load /mug.glb", err),
);

function applyFoam(rig: MugRig): void {
  if (!rig.foam) return;
  const s = FOAM_SCALES[Math.min(rig.sips, 4)];
  rig.foam.visible = rig.sips < 4;
  rig.foam.scale.set(0.45 + 0.55 * s, s, 0.45 + 0.55 * s);
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
    // foam shrinks at the drink's peak, once
    if (t > 0.5 && rig.sips < (kind === "slam" ? 4 : rig.sips + 1)) {
      const target = kind === "slam" ? 4 : rig.sips + 1;
      if (rig.foam) {
        const s = FOAM_SCALES[Math.min(target, 4)];
        rig.foam.visible = target < 4;
        rig.foam.scale.set(0.45 + 0.55 * s, s, 0.45 + 0.55 * s);
      }
    }
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

function applyTokenGeometries() {
  if (!sculptedTokenGeos) return;
  markers.forEach((marker, i) => {
    const owner: PlayerId = i < 4 ? "p1" : "p2";
    marker.mesh.geometry = owner === "p1" ? sculptedTokenGeos!.red : sculptedTokenGeos!.blue;
  });
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

function handleEscapeChanges(now: { p1: number; p2: number }): void {
  const mySide: PlayerId = myRole ?? "p1";
  const otherSide: PlayerId = mySide === "p1" ? "p2" : "p1";
  if (now.p1 < escapedByOwner.p1 || now.p2 < escapedByOwner.p2) {
    // Rematch: the tallies went backwards — refill both mugs.
    resetMug(myMug);
    resetMug(theirMug);
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
// for the ward/bulwark/safe status tints.
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
  },
  undefined,
  (err) => console.error("Failed to load", PIECES_URL, err),
);

function triggerCoinFlip(markedCount: number, set: CoinAnim[]) {
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

function refreshMarkers(state: GameState) {
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
  handleEscapeChanges(nowEscaped);
}

/** Master Killer only: tint warded / Ward Breaker-safe / Bulwarked tokens.
 *  Reuses the real isWarded() from master-killer.ts against a minimal
 *  PowerState built from the public `power` field, so the client can never
 *  drift from the server's own definition of "warded". Bulwark's own
 *  protected-ness is simpler — the server already hands over the exact
 *  token id list (bulwarkedTokenIds), no derivation needed. Classic rooms
 *  (currentPower === null) always take the clear-everything branch — a
 *  no-op against the materials' own black-emissive default, so classic
 *  visuals are untouched. */
function updateTokenTints(state: GameState) {
  const safe = currentPower ? new Set(currentPower.safeTokens) : null;
  const bulwarked = currentPower ? new Set(currentPower.bulwarkedTokenIds) : null;
  const fakePower: PowerState | null = currentPower
    ? {
        classes: currentPower.classes,
        charges: currentPower.charges,
        safeTokens: new Set(),
        reflipsUsedThisTurn: 0,
        shieldStreak: { p1: 0, p2: 0 },
        ultimateReady: { p1: false, p2: false },
        bulwarked: {},
        bulwarkSaves: {},
      }
    : null;
  state.tokens.forEach((token, idx) => {
    const mat = markers[idx].mesh.material as THREE.MeshStandardMaterial;
    if (fakePower && isWarded(state, fakePower, token)) {
      mat.emissive.setHex(0x8040ff); // violet — Mage ward
      mat.emissiveIntensity = 0.55;
    } else if (bulwarked && bulwarked.has(token.id)) {
      mat.emissive.setHex(0x2fd0c0); // cool teal — Warrior Bulwark
      mat.emissiveIntensity = 0.5;
    } else if (safe && safe.has(token.id)) {
      mat.emissive.setHex(0xffa332); // warm gold — Ward Breaker-safe
      mat.emissiveIntensity = 0.45;
    } else {
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
    }
  });
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
// triggering lives in the #moves button rail (renderPowerActions), which is
// the only surface rich enough for two actives + an ultimate per class.
const plateMe = document.getElementById("plate-me") as HTMLDivElement;
const plateThem = document.getElementById("plate-them") as HTMLDivElement;
const portraitMe = document.getElementById("portrait-me") as HTMLImageElement;
const portraitThem = document.getElementById("portrait-them") as HTMLImageElement;
const gemsMe = document.getElementById("gems-me") as HTMLDivElement;
const gemsThem = document.getElementById("gems-them") as HTMLDivElement;
const plateNameMe = document.getElementById("plate-name-me") as HTMLDivElement;
const plateNameThem = document.getElementById("plate-name-them") as HTMLDivElement;

// One gem socket per bankable charge, built from the real tunable so a
// CHARGE_CAP change reshapes the frames automatically.
for (const container of [gemsMe, gemsThem]) {
  for (let i = 0; i < CHARGE_CAP; i++) {
    container.appendChild(Object.assign(document.createElement("span"), { className: "gem" }));
  }
}

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
  safeTokens: number[];
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
} | null = null;
/** The current player's power-boosted move list (only populated on my own
 *  turn — same security rule as legalMoves). Kept alongside currentMoves
 *  (which gets the same array structurally, via tap-to-move) so Warrior's
 *  Charge buttons can read chargeAvailable/from/to per move. */
let currentPowerMoves: PowerMove[] | null = null;
/** True while an Archer has tapped "Push" and is waiting to tap a target. */
let pushArmed = false;
/** Push's targetable enemy tokens while pushArmed — lit the same way as
 *  capturableIds, via the shared hover-glow helper below. */
const pushTargetIds = new Set<number>();
/** True while an Archer has tapped "Charged Shot" and is waiting to tap a
 *  target — same lifecycle as pushArmed, offered alongside Push (not
 *  instead of it) whenever charges === CHARGE_CAP. */
let chargedShotArmed = false;
const chargedShotTargetIds = new Set<number>();
/** True while a Mage has tapped "Blink Strike" and is waiting to tap a
 *  target — same lifecycle as pushArmed. */
let blinkStrikeArmed = false;
const blinkStrikeTargetIds = new Set<number>();
/** True while a Warrior has tapped "Warpath" and is waiting to tap a
 *  target — same lifecycle as pushArmed. */
let warpathArmed = false;
const warpathTargetIds = new Set<number>();
/** True while a Warrior has tapped "Bulwark" and is waiting to tap a
 *  target — unlike every other armed flow above, the tap target here is one
 *  of the MOVER'S OWN tokens, not an enemy's. Reuses the exact same
 *  raycast/hover helpers (findTargetUnderPointer works over any token id
 *  set regardless of owner), so no new targeting plumbing is needed. */
let bulwarkArmed = false;
const bulwarkTargetIds = new Set<number>();
/** True when the armed Bulwark tap is the REINFORCED (full-bank) cast —
 *  same targeting flow, the tap just sends `reinforced: true`. Only
 *  meaningful while bulwarkArmed. */
let bulwarkArmedReinforced = false;

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
// Every ability button carries a small "i" gem; hovering the button (desktop)
// or tapping the gem (touch) opens a card above the buttons that says what
// the ability actually does — cost, effect, edge cases — like any game's
// tooltip. Tapping the button proper still fires/arms the ability.
const ABILITY_INFO: Record<string, { name: string; cost: string; desc: string; klass: PlayerClass }> = {
  reflip: {
    name: "Re-flip",
    cost: "1 charge each · keeps your turn",
    klass: "mage",
    desc: `Don't like your roll? Flip all four coins again instead of moving — up to ${REFLIPS_PER_TURN} times a turn, one charge each. Mind your Ward: it only holds at a full bank, so the second re-flip drops it.`,
  },
  push: {
    name: "Push",
    cost: "1 charge",
    klass: "archer",
    desc: "Shove an enemy stone in shared water back one pace. Push it onto your own stone or off the board and it's sent home — and the charge comes right back.",
  },
  chargedShot: {
    name: "Charged Shot",
    cost: `${CHARGE_CAP} charges`,
    klass: "archer",
    desc: `A heavier shot: knock an enemy stone back ${CHARGED_SHOT_DISTANCE} paces — ${CHARGED_SHOT_WARD_DISTANCE} if Warded, the one shot that can reach a Warded stone. Send it home and one charge comes back.`,
  },
  charge: {
    name: "Charge",
    cost: "1 charge",
    klass: "warrior",
    desc: "Turn this move into a sweep: one enemy stone between your start and landing is captured too, Warded or not.",
  },
  bulwark: {
    name: "Bulwark",
    cost: "1 charge",
    klass: "warrior",
    desc: "Shield one of your own stones: it can't be captured, swept by a Charge, or taken by an ultimate. Fades after a few turns, or the moment it saves the stone.",
  },
  bulwarkReinforced: {
    name: "Reinforced Bulwark",
    cost: `${CHARGE_CAP} charges`,
    klass: "warrior",
    desc: "A Bulwark with everything doubled: it lasts twice as many turns AND shrugs off the first save instead of fading — only the second save (or time) brings it down.",
  },
  blinkStrike: {
    name: "Blink Strike",
    cost: "Ultimate · 3 shield landings in a row",
    klass: "mage",
    desc: "Teleport your furthest-along stone onto any enemy in shared water, capturing it — straight through shields and Wards.",
  },
  warpath: {
    name: "Warpath",
    cost: "Ultimate · 3 shield landings in a row",
    klass: "warrior",
    desc: "Teleport your least-advanced stone onto any enemy in shared water — capturing it and every unprotected enemy stone along the way.",
  },
};

const abilityTip = document.getElementById("ability-tip") as HTMLDivElement;
const abilityTipName = abilityTip.querySelector(".tip-name") as HTMLDivElement;
const abilityTipCost = abilityTip.querySelector(".tip-cost") as HTMLDivElement;
const abilityTipDesc = abilityTip.querySelector(".tip-desc") as HTMLDivElement;
let abilityTipFor: string | null = null;

function showAbilityTip(ability: string, anchor: HTMLElement) {
  const info = ABILITY_INFO[ability];
  if (!info) return;
  abilityTipName.textContent = info.name;
  abilityTipCost.textContent = info.cost;
  abilityTipDesc.textContent = info.desc;
  abilityTip.dataset.class = info.klass;
  const rect = anchor.getBoundingClientRect();
  // Centered over the button, clamped to the viewport edges.
  const half = 160;
  const x = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8);
  abilityTip.style.left = `${x}px`;
  abilityTip.style.bottom = `${window.innerHeight - rect.top + 10}px`;
  abilityTip.classList.add("show");
  abilityTipFor = ability;
}

function hideAbilityTip() {
  abilityTip.classList.remove("show");
  abilityTipFor = null;
}

/** Ability buttons hold a label span + the "i" gem — plain textContent
 *  assignment would wipe the gem, so armed-state relabels go through here. */
function setAbilityLabel(btn: HTMLButtonElement, text: string) {
  let label = btn.querySelector<HTMLSpanElement>(".ability-label");
  if (!label) {
    label = document.createElement("span");
    label.className = "ability-label";
    const gem = document.createElement("span");
    gem.className = "ability-info";
    gem.textContent = "i";
    gem.title = "What does this do?";
    btn.append(label, gem);
  }
  label.textContent = text;
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

/** Master Killer only: append active-ability buttons to #moves (which
 *  renderMoves() just cleared). Normal moves stay tap-to-move, unchanged —
 *  this only adds the extra Push/Re-flip/Charge affordances a class needs. */
function renderPowerActions(isMyTurn: boolean) {
  hideAbilityTip(); // buttons are about to be rebuilt under it
  pushArmed = false;
  pushTargetIds.clear();
  chargedShotArmed = false;
  chargedShotTargetIds.clear();
  blinkStrikeArmed = false;
  blinkStrikeTargetIds.clear();
  warpathArmed = false;
  warpathTargetIds.clear();
  bulwarkArmed = false;
  bulwarkArmedReinforced = false;
  bulwarkTargetIds.clear();
  if (!isMyTurn || myVariant !== "masterKiller" || !currentPower) return;
  const mySide: PlayerId = myRole ?? "p1";
  const cls = currentPower.classes[mySide];
  const charges = currentPower.charges[mySide];

  // Ultimates spend a banked ultimateReady flag, not a charge — so they're
  // offered independent of the charges<1 gate below.
  if (cls === "mage" && currentPower.ultimateReady[mySide] && currentPower.blinkStrikeTargets.length > 0) {
    const btn = document.createElement("button");
    btn.dataset.ability = "blinkStrike";
    const setLabel = () => {
      setAbilityLabel(btn, blinkStrikeArmed ? "Blink Strike: tap a target…" : "Blink Strike ✦");
      btn.className = blinkStrikeArmed ? "ability ultimate armed" : "ability ultimate";
    };
    setLabel();
    btn.addEventListener("click", () => {
      blinkStrikeArmed = !blinkStrikeArmed;
      blinkStrikeTargetIds.clear();
      if (blinkStrikeArmed) for (const id of currentPower!.blinkStrikeTargets) blinkStrikeTargetIds.add(id);
      else hideHoverGlow();
      setLabel();
    });
    movesEl.appendChild(btn);
  }
  if (cls === "warrior" && currentPower.ultimateReady[mySide] && currentPower.warpathTargets.length > 0) {
    const btn = document.createElement("button");
    btn.dataset.ability = "warpath";
    const setLabel = () => {
      setAbilityLabel(btn, warpathArmed ? "Warpath: tap a target…" : "Warpath ✦");
      btn.className = warpathArmed ? "ability ultimate armed" : "ability ultimate";
    };
    setLabel();
    btn.addEventListener("click", () => {
      warpathArmed = !warpathArmed;
      warpathTargetIds.clear();
      if (warpathArmed) for (const id of currentPower!.warpathTargets) warpathTargetIds.add(id);
      else hideHoverGlow();
      setLabel();
    });
    movesEl.appendChild(btn);
  }

  if (charges < 1) return;

  if (cls === "mage") {
    // Gated on the server-reported per-turn use count too, not just
    // charges: a Mage can hold a refunded charge (re-rolled zero) while
    // already at the REFLIPS_PER_TURN cap. Older servers omit the field —
    // fall back to 0, i.e. the pre-existing charges-only gate.
    if ((currentPower.reflipsUsedThisTurn ?? 0) < REFLIPS_PER_TURN) {
      const btn = document.createElement("button");
      btn.dataset.ability = "reflip";
      setAbilityLabel(btn, `Re-flip (1⚡)`);
      btn.className = "ability";
      btn.addEventListener("click", () => {
        sendToServer({ type: "usePower", action: { kind: "reflip" } });
      });
      movesEl.appendChild(btn);
    }
  } else if (cls === "archer") {
    if (currentPower.pushTargets.length > 0) {
      const btn = document.createElement("button");
      btn.dataset.ability = "push";
      const setLabel = () => {
        setAbilityLabel(btn, pushArmed ? "Push: tap a target…" : `Push (1⚡)`);
        btn.className = pushArmed ? "ability armed" : "ability";
      };
      setLabel();
      btn.addEventListener("click", () => {
        pushArmed = !pushArmed;
        pushTargetIds.clear();
        if (pushArmed) for (const id of currentPower!.pushTargets) pushTargetIds.add(id);
        else hideHoverGlow();
        setLabel();
      });
      movesEl.appendChild(btn);
    }
    // Charged Shot: spends BOTH banked charges at once, so it's only offered
    // at the full charge cap — distinct action/button from Push, offered
    // alongside it (not instead of it) when both are available.
    if (charges === CHARGE_CAP && currentPower.chargedShotTargets.length > 0) {
      const btn = document.createElement("button");
      btn.dataset.ability = "chargedShot";
      const setLabel = () => {
        setAbilityLabel(btn, chargedShotArmed ? "Charged Shot: tap a target…" : `Charged Shot (${CHARGE_CAP}⚡)`);
        btn.className = chargedShotArmed ? "ability ultimate armed" : "ability ultimate";
      };
      setLabel();
      btn.addEventListener("click", () => {
        chargedShotArmed = !chargedShotArmed;
        chargedShotTargetIds.clear();
        if (chargedShotArmed) for (const id of currentPower!.chargedShotTargets) chargedShotTargetIds.add(id);
        else hideHoverGlow();
        setLabel();
      });
      movesEl.appendChild(btn);
    }
  } else if (cls === "warrior") {
    // Bulwark: unlike every other armed flow, the tap target is one of the
    // MOVER'S OWN tokens — offered alongside Charge, not instead of it, so
    // a Warrior with a spare charge can pick either each turn. At the full
    // bank a second button offers the REINFORCED cast (2 charges, doubled
    // lifetime and saves) — same targets, same tap flow; the two buttons
    // share one armed state, so arming either disarms the other.
    if (currentPower.bulwarkTargets.length > 0) {
      const btn = document.createElement("button");
      btn.dataset.ability = "bulwark";
      const reinfBtn = charges === CHARGE_CAP ? document.createElement("button") : null;
      const setLabels = () => {
        const plainArmed = bulwarkArmed && !bulwarkArmedReinforced;
        setAbilityLabel(btn, plainArmed ? "Bulwark: tap your token…" : `Bulwark (1⚡)`);
        btn.className = plainArmed ? "ability armed" : "ability";
        if (reinfBtn) {
          const reinfArmed = bulwarkArmed && bulwarkArmedReinforced;
          setAbilityLabel(
            reinfBtn,
            reinfArmed ? "Reinforced Bulwark: tap your token…" : `Reinforced Bulwark (${CHARGE_CAP}⚡)`,
          );
          reinfBtn.className = reinfArmed ? "ability ultimate armed" : "ability ultimate";
        }
      };
      const toggle = (reinforced: boolean) => {
        const wasThisArmed = bulwarkArmed && bulwarkArmedReinforced === reinforced;
        bulwarkArmed = !wasThisArmed;
        bulwarkArmedReinforced = bulwarkArmed && reinforced;
        bulwarkTargetIds.clear();
        if (bulwarkArmed) for (const id of currentPower!.bulwarkTargets) bulwarkTargetIds.add(id);
        else hideHoverGlow();
        setLabels();
      };
      setLabels();
      btn.addEventListener("click", () => toggle(false));
      movesEl.appendChild(btn);
      if (reinfBtn) {
        reinfBtn.dataset.ability = "bulwarkReinforced";
        reinfBtn.addEventListener("click", () => toggle(true));
        movesEl.appendChild(reinfBtn);
      }
    }
    if (currentPowerMoves) {
      for (let i = 0; i < currentPowerMoves.length; i++) {
        const m = currentPowerMoves[i];
        if (!m.chargeAvailable) continue;
        const btn = document.createElement("button");
        btn.dataset.ability = "charge";
        setAbilityLabel(btn, `Charge: ${tokenLabel(m.tokenId)} ${tileLabel(m.from)}→${tileLabel(m.to)}`);
        btn.className = "ability";
        const moveIndex = i;
        btn.addEventListener("click", () => {
          sendToServer({ type: "usePower", action: { kind: "charge", moveIndex } });
        });
        movesEl.appendChild(btn);
      }
    }
  }
}

// The "i" gem opens the ability card INSTEAD of firing the ability — capture
// phase so it wins over the button's own activation listener.
movesEl.addEventListener(
  "click",
  (e) => {
    const gem = (e.target as HTMLElement).closest(".ability-info");
    if (!gem) return;
    e.stopPropagation();
    const btn = gem.closest("button") as HTMLButtonElement;
    if (abilityTipFor === btn.dataset.ability) hideAbilityTip();
    else showAbilityTip(btn.dataset.ability!, btn);
  },
  true,
);
// Desktop: hovering an ability button shows its card, like any game tooltip.
movesEl.addEventListener("pointerover", (e) => {
  if (!window.matchMedia("(hover: hover)").matches) return;
  const btn = (e.target as HTMLElement).closest("button[data-ability]") as HTMLButtonElement | null;
  if (btn) showAbilityTip(btn.dataset.ability!, btn);
});
movesEl.addEventListener("pointerout", (e) => {
  if (!window.matchMedia("(hover: hover)").matches) return;
  const to = (e as PointerEvent).relatedTarget as HTMLElement | null;
  if (!to || !to.closest("button[data-ability]")) hideAbilityTip();
});

movesEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  // Activating an ability puts the card away (arming flows take the screen).
  if (btn.dataset.ability) hideAbilityTip();
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

canvas.addEventListener("pointerdown", (e) => {
  // Opening flip-off: same tap target and glow as the roll gate.
  if (openingTapArmed) {
    if (isMyCoinUnderPointer(e.clientX, e.clientY)) {
      openingTapArmed = false;
      sendToServer({ type: "openingFlip" });
      hud.innerHTML = `<div>Flip for first move</div><div>Flipping…</div>`;
    }
    return;
  }
  // Master Killer: Push is armed and waiting for a target tap.
  if (pushArmed) {
    const target = findTargetUnderPointer(pushTargetIds, e.clientX, e.clientY);
    if (target !== null) {
      sendToServer({ type: "usePower", action: { kind: "push", targetTokenId: target } });
      pushArmed = false;
      pushTargetIds.clear();
      hideHoverGlow();
    }
    return;
  }
  // Master Killer: Charged Shot armed and waiting for a target tap — same
  // enemy-target-tap flow as Push, just a different action kind + target set.
  if (chargedShotArmed) {
    const target = findTargetUnderPointer(chargedShotTargetIds, e.clientX, e.clientY);
    if (target !== null) {
      sendToServer({ type: "usePower", action: { kind: "chargedShot", targetTokenId: target } });
      chargedShotArmed = false;
      chargedShotTargetIds.clear();
      hideHoverGlow();
    }
    return;
  }
  // Master Killer: Blink Strike / Warpath armed and waiting for a target tap.
  if (blinkStrikeArmed) {
    const target = findTargetUnderPointer(blinkStrikeTargetIds, e.clientX, e.clientY);
    if (target !== null) {
      sendToServer({ type: "usePower", action: { kind: "blinkStrike", targetTokenId: target } });
      blinkStrikeArmed = false;
      blinkStrikeTargetIds.clear();
      hideHoverGlow();
    }
    return;
  }
  if (warpathArmed) {
    const target = findTargetUnderPointer(warpathTargetIds, e.clientX, e.clientY);
    if (target !== null) {
      sendToServer({ type: "usePower", action: { kind: "warpath", targetTokenId: target } });
      warpathArmed = false;
      warpathTargetIds.clear();
      hideHoverGlow();
    }
    return;
  }
  // Master Killer: Bulwark armed and waiting for a tap on one of the
  // MOVER'S OWN tokens (bulwarkTargetIds already only lists those) — same
  // raycast helper as every enemy-targeted flow above, just a different set.
  if (bulwarkArmed) {
    const target = findTargetUnderPointer(bulwarkTargetIds, e.clientX, e.clientY);
    if (target !== null) {
      sendToServer({
        type: "usePower",
        action: { kind: "bulwark", tokenId: target, ...(bulwarkArmedReinforced ? { reinforced: true } : {}) },
      });
      bulwarkArmed = false;
      bulwarkArmedReinforced = false;
      bulwarkTargetIds.clear();
      hideHoverGlow();
    }
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
      renderPowerActions(true);
      if (pending.legalMoves && pending.legalMoves.length > 0)
        coach(
          "move",
          "Now tap a glowing stone to sail it that many paces. Your route: down your shore, up the shared middle, then back home to the dock.",
        );
    }
    return;
  }
  const tokenId = findEligibleMeshUnderPointer(e.clientX, e.clientY);
  if (tokenId === null) return;
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
  const pushable = pushArmed ? findTargetUnderPointer(pushTargetIds, e.clientX, e.clientY) : null;
  const chargedShotable = chargedShotArmed ? findTargetUnderPointer(chargedShotTargetIds, e.clientX, e.clientY) : null;
  const blinkStrikeable = blinkStrikeArmed ? findTargetUnderPointer(blinkStrikeTargetIds, e.clientX, e.clientY) : null;
  const warpathable = warpathArmed ? findTargetUnderPointer(warpathTargetIds, e.clientX, e.clientY) : null;
  const bulwarkable = bulwarkArmed ? findTargetUnderPointer(bulwarkTargetIds, e.clientX, e.clientY) : null;
  const rollable =
    ((rollPending !== null || openingTapArmed) && isMyCoinUnderPointer(e.clientX, e.clientY)) ||
    (myAvailableSips() > 0 && isMyMugUnderPointer(e.clientX, e.clientY));
  canvas.style.cursor =
    hit !== null ||
    capturable !== null ||
    pushable !== null ||
    chargedShotable !== null ||
    blinkStrikeable !== null ||
    warpathable !== null ||
    bulwarkable !== null ||
    rollable
      ? "pointer"
      : "default";
  const glowTarget = pushable ?? chargedShotable ?? blinkStrikeable ?? warpathable ?? bulwarkable ?? capturable;
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
  const variant = myVariant; // resetToMenu wipes both — capture first
  resetToMenu("");
  menuEl.classList.remove("show"); // straight into the fresh game, no menu flash
  tutorialMode = wasTutorial;
  coachShown.clear();
  sendToServer({ type: "join", mode: "cpu", variant });
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
  lastUltimate?: { kind: "blinkStrike" | "warpath"; targetTokenId: number; sweptTokenIds: number[] } | null;
  lastChargeSweep?: { sweptTokenIds: number[] } | null;
  lastReflip?: { player: PlayerId } | null;
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

  if (msg.lastUltimate && msg.lastMovePlayer) {
    const who = playerLabel(msg.lastMovePlayer);
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : who;
    const target = isMe ? "opponent's" : "your";
    const label = msg.lastUltimate.kind === "blinkStrike" ? "Blink Strike" : "Warpath";
    const sweptCount = msg.lastUltimate.sweptTokenIds.length;
    const sweepPhrase = sweptCount > 0 ? `, sweeping ${sweptCount} more` : "";
    const k = classOf(msg.lastMovePlayer);
    if (k) showProc(k, `${label}!`, msg.lastUltimate.kind);
    showAnnouncement(
      `${subject} unleashed ${label} — captured ${target} token${sweptCount > 0 ? "s" : ""}${sweepPhrase}!${chargeFor(msg.lastMovePlayer)}`,
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
      showAnnouncement(
        `${subject} captured ${target} token${totalCaptures > 1 ? "s" : ""} on ${tileDisplay(m.to)}${suffix}`,
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
  if (ev.kind === "chat" || ev.kind === "classPick") return; // overlay-rendered
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
  refreshMarkers(ev.state);
  currentPower = ev.power ?? null;
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

/** Apply the response's CURRENT overlay — idempotent, interactive state. */
function applyOverlay(v: RoomResponse) {
  const mySide: PlayerId = myRole ?? "p1";
  myVariant = v.variant;
  inCpuGame = v.vsCpu;

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
    updatePlates(null);
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
      renderPowerActions(false);
    } else if (!rollPending) {
      // Already revealed (tapped) — keep the interactive surfaces fresh.
      renderHud(v.state, v.flip);
      renderMoves(movesForTap, true);
      renderPowerActions(true);
    }
    // else: gate armed, waiting on the tap — leave it alone.
  } else {
    rollPending = null;
    renderHud(v.state, v.flip);
    renderMoves(v.flip !== null && mine ? movesForTap : null, mine && v.flip !== null);
    renderPowerActions(mine && v.flip !== null);
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
      showWinScreen(winner, stats);
      showPlayAgainButton();
    }, WIN_SCREEN_DELAY_MS + 1500); // extra beat: the winner's mug slams first
  }
  if (!v.gameOver) shownWinner = null;
}

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
  if (v.resync) {
    // Too far behind for replay: snap silently (no banners, no tumbles).
    seenOpeningFlips = { ...v.openingFlips };
    currentPower = v.power ?? null;
    refreshMarkers(v.state);
    updateTokenTints(v.state);
    updatePlates(v.state);
    if (v.flip !== null && v.yourTurn) pendingFlipSeq = v.latestSeq;
  } else {
    for (const ev of v.events) {
      if (ev.seq > lastSeq) replayEvent(ev);
    }
  }
  lastSeq = Math.max(lastSeq, v.latestSeq);
  applyOverlay(v);
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
function seatSelf(seat: PlayerId, room: string, vsCpu: boolean, variant: "classic" | "masterKiller") {
  myRole = seat;
  myRoom = room;
  myVariant = variant;
  inCpuGame = vsCpu;
  rollPending = null;
  openingTapArmed = false;
  seenOpeningFlips = { p1: null, p2: null };
  currentPower = null;
  currentPowerMoves = null;
  pushArmed = false;
  pushTargetIds.clear();
  chargedShotArmed = false;
  chargedShotTargetIds.clear();
  blinkStrikeArmed = false;
  blinkStrikeTargetIds.clear();
  warpathArmed = false;
  warpathTargetIds.clear();
  bulwarkArmed = false;
  bulwarkArmedReinforced = false;
  bulwarkTargetIds.clear();
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
  hud.textContent = vsCpu ? "You are Red — vs Computer" : "You are Red. Waiting for opponent…";
}

function doJoin(
  mode: "cpu" | "create" | "join",
  room?: string,
  variant?: "classic" | "masterKiller",
  unlisted = false,
) {
  menuError.textContent = "";
  setStatus("Joining…");
  post({ op: "join", mode, room, variant, unlisted })
    .then((raw) => {
      const j = raw as RoomJoinResponse;
      session = { room: j.room, seat: j.player, seatToken: j.seatToken };
      saveSession(session);
      exitToggle.classList.add("show");
      closeLobby();
      seatSelf(j.player, j.room, j.vsCpu, j.variant);
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

// --- Master Killer mode: menu toggle + class-pick overlay ---
/** Ruleset picked in the menu, sent along with cpu/create joins. Ignored
 *  by the server for mode "join" — you play whatever room you're joining. */
let menuPick: "classic" | "masterKiller" | "tutorial" = "classic";
/** What actually goes on the wire — the tutorial IS classic regatta; the
 *  coach layer is client-side only. */
function selectedVariant(): "classic" | "masterKiller" {
  return menuPick === "masterKiller" ? "masterKiller" : "classic";
}
const menuCpuBtn = document.getElementById("menu-cpu") as HTMLButtonElement;
const menuCreateBtn = document.getElementById("menu-create") as HTMLButtonElement;
const menuBrowseBtn = document.getElementById("menu-browse") as HTMLButtonElement;
const menuModeSeg = document.getElementById("menu-mode-seg") as HTMLDivElement;
const menuTitle = document.getElementById("menu-title") as HTMLHeadingElement;
const menuTagline = document.getElementById("menu-tagline") as HTMLDivElement;
function applyMenuPick() {
  const mk = menuPick === "masterKiller";
  const tut = menuPick === "tutorial";
  for (const b of menuModeSeg.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.pick === menuPick);
  }
  // The marquee follows the pick — the menu IS the game you're about to play.
  menuTitle.textContent = tut ? "REGATTA TUTORIAL" : mk ? "MASTER KILLER" : "REGATTA";
  menuTitle.classList.toggle("long", tut);
  menuTagline.textContent = tut
    ? "learn the ropes · a guided first sail"
    : mk
      ? "a darker table · class powers"
      : "a race across the board";
  // The tutorial is a guided solo sail — rooms make no sense there.
  menuCpuBtn.textContent = tut ? "Begin Tutorial" : "Play vs Computer";
  menuCreateBtn.style.display = tut ? "none" : "";
  menuBrowseBtn.style.display = tut ? "none" : "";
}
menuModeSeg.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button[data-pick]") as HTMLButtonElement | null;
  if (!b) return;
  menuPick = b.dataset.pick as typeof menuPick;
  applyMenuPick();
});
applyMenuPick();

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
    doJoin(msg.mode, msg.room, msg.variant);
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
  pushArmed = false;
  pushTargetIds.clear();
  chargedShotArmed = false;
  chargedShotTargetIds.clear();
  blinkStrikeArmed = false;
  blinkStrikeTargetIds.clear();
  warpathArmed = false;
  warpathTargetIds.clear();
  bulwarkArmed = false;
  bulwarkArmedReinforced = false;
  bulwarkTargetIds.clear();
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
  clearSession();
  exitToggle.classList.remove("show");
  exitConfirm.classList.remove("show");
  tutorialMode = false;
  coachShown.clear();
  hideCoach();
  hud.textContent = message;
  menuEl.classList.add("show");
}

menuCpuBtn.addEventListener("click", () => {
  menuError.textContent = "";
  tutorialMode = menuPick === "tutorial";
  coachShown.clear();
  sendToServer({ type: "join", mode: "cpu", variant: selectedVariant() });
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
     fills your <span class="gold">charge</span> — up to two banked at once.
     Spend a charge to fire your class's active power, offered as a button
     beside your coins whenever you can afford it.</p>`,
    `<div class="runner">Master Killer &middot; the three classes</div>
     <ul>
       <li><b>The Archer</b> strikes from range — free Snipes on the water,
       Pushes and the heavy Charged Shot to knock enemies home.</li>
       <li><b>The Mage</b> bends fate — Wards its lead stone against capture
       and Re-flips a bad roll, twice a turn with a full bank.</li>
       <li><b>The Warrior</b> walks through wards — breaks them on contact,
       sweeps the lane with Charge, shelters behind Bulwark.</li>
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
       Push entirely — the charge is spent, but the stone doesn't move.</li>
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
       onto any enemy in shared water — capturing it even through a shield
       or a Ward.</li>
     </ul>`,
  ],
  [
    `<h2>The Warrior</h2>
     <ul>
       <li><b>Ward Breaker</b> (passive, free): walk onto a Warded enemy
       stone and the Ward breaks — captured all the same, and your stone
       stands safe from capture until it next moves.</li>
       <li><b>Charge</b> (active, 1 charge): make your move a sweep — one
       enemy stone in shared water between where you started and where you
       land is captured too, Warded or not.</li>
       <li>The Warrior is the one class no Ward can stop cold — everyone
       else needs a Push or a lucky Re-flip instead.</li>
     </ul>`,
    `<div class="runner">The Warrior &middot; continued</div>
     <ul>
       <li><b>Bulwark</b> (active, 1 charge): raise a shield over one of
       YOUR OWN stones — it cannot be captured, swept by Charge, or taken by
       an enemy ultimate, and a Push can only shove it, never send it home.
       It fades after a few of your turns unused, or the instant it saves
       the stone.</li>
       <li><b>Reinforced Bulwark</b> (active, spends both charges): the
       same shield with everything doubled — it lasts twice as many turns,
       and it shrugs off the first save instead of fading. Only the second
       save, or time, brings it down.</li>
       <li><b>Warpath</b> (active, spends your ultimate): land on a shield
       tile three times running, then teleport your least-advanced stone
       onto any enemy in shared water — capturing it plus every unprotected
       enemy stone caught between where it started and where it lands,
       Warded or not. Break a Ward along the way and the landing stone
       stands safe from capture until it next moves.</li>
     </ul>`,
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

function tick() {
  rafId = requestAnimationFrame(tick);
  lastFrameAt = performance.now();
  const now = lastFrameAt;
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
  // lives entirely OFF the stone material, so the ward/bulwark/safe status
  // tints stay visible on a movable stone. Ring visibility is recomputed
  // from eligibleTokenIds every frame — no restore bookkeeping to go stale.
  const breath = 0.5 + 0.5 * Math.sin(now * 0.0035); // ~1.8 s calm period
  const eased = breath * breath * (3 - 2 * breath); // smoothstep: linger, glide
  eligibleRingMat.opacity = 0.5 + 0.38 * eased;
  const ringScale = 0.97 + 0.06 * eased; // ring Ø 0.466–0.494, < tile pitch
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const ring = ringMeshes[i];
    ring.visible =
      marker.mesh.visible && !marker.flying && eligibleTokenIds.has(i);
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
setInterval(() => {
  if (performance.now() - lastFrameAt < 2000) return; // frames are flowing — all good
  const userPresent = performance.now() - lastPresenceAt < 30_000;
  if (document.hidden && !userPresent) return; // truly backgrounded: stay quiet
  cancelAnimationFrame(rafId); // no double chains when rAF wakes back up
  resize();
  tick();
}, 1000);

