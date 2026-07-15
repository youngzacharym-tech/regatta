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
import type { ServerMessage, ClientMessage } from "../../protocol.ts";
import type {
  GameState,
  Move,
  PlayerId,
} from "../../rulebook.ts";
import { BOARD_LAYOUT } from "../../rulebook.ts";
import { tileWorldPos, reservePos, escapedPos } from "./layout.ts";
import { audio } from "./audio.ts";
// Master Killer mode — additive only. Everything below is inert in classic
// rooms (myVariant stays "classic", currentPower stays null, and every
// branch that reads them is gated accordingly).
import {
  CHARGE_CAP,
  CHARGED_SHOT_DISTANCE,
  CHARGED_SHOT_WARD_DISTANCE,
  isWarded,
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
//   3. In production (served from the referee itself), use same-origin ws(s)://
//      with no port so it works behind Render's HTTPS proxy.
function resolveRefereeURL(): string {
  const override = new URLSearchParams(location.search).get("referee");
  if (override) return override;
  const isDev = location.port === "5173" || location.hostname === "";
  // /api/ws works against both referees: the local Node server accepts any
  // upgrade path, and the Vercel deployment routes it to the WS function.
  if (isDev) return `ws://${location.hostname || "localhost"}:8080/api/ws`;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/ws`;
}
const REFEREE_URL = resolveRefereeURL();
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

// The tabletop the board rests on — a dark wood-toned plane that catches the
// lamp pool and the pieces' shadows.
const TABLE_Y = -0.42; // just under the board hull's lowest point
const table = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x2b1c11, roughness: 0.95 }),
);
table.rotation.x = -Math.PI / 2;
table.position.y = TABLE_Y;
table.receiveShadow = true;
scene.add(table);

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
window.addEventListener("resize", resize);
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
  }),
);
fireSprite.position.set(fireCfg.x, fireCfg.y - 0.35, fireCfg.z);
fireSprite.scale.set(fireCfg.size, fireCfg.size * 0.73, 1);
scene.add(fireSprite);

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
    // (Emissive is applied per-frame in the render loop — see tick().)

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
        reflipUsedThisTurn: false,
        shieldStreak: { p1: 0, p2: 0 },
        ultimateReady: { p1: false, p2: false },
        bulwarked: {},
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
  pushArmed = false;
  pushTargetIds.clear();
  chargedShotArmed = false;
  chargedShotTargetIds.clear();
  blinkStrikeArmed = false;
  blinkStrikeTargetIds.clear();
  warpathArmed = false;
  warpathTargetIds.clear();
  bulwarkArmed = false;
  bulwarkTargetIds.clear();
  if (!isMyTurn || myVariant !== "masterKiller" || !currentPower) return;
  const mySide: PlayerId = myRole ?? "p1";
  const cls = currentPower.classes[mySide];
  const charges = currentPower.charges[mySide];

  // Ultimates spend a banked ultimateReady flag, not a charge — so they're
  // offered independent of the charges<1 gate below.
  if (cls === "mage" && currentPower.ultimateReady[mySide] && currentPower.blinkStrikeTargets.length > 0) {
    const btn = document.createElement("button");
    const setLabel = () => {
      btn.textContent = blinkStrikeArmed ? "Blink Strike: tap a target…" : "Blink Strike ✦";
      btn.style.background = blinkStrikeArmed ? "#a06010" : "#c04fd0";
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
    const setLabel = () => {
      btn.textContent = warpathArmed ? "Warpath: tap a target…" : "Warpath ✦";
      btn.style.background = warpathArmed ? "#a06010" : "#c04fd0";
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
    const btn = document.createElement("button");
    btn.textContent = `Re-flip (1⚡)`;
    btn.style.background = "#6a4fb0";
    btn.addEventListener("click", () => {
      sendToServer({ type: "usePower", action: { kind: "reflip" } });
    });
    movesEl.appendChild(btn);
  } else if (cls === "archer") {
    if (currentPower.pushTargets.length > 0) {
      const btn = document.createElement("button");
      const setLabel = () => {
        btn.textContent = pushArmed ? "Push: tap a target…" : `Push (1⚡)`;
        btn.style.background = pushArmed ? "#a06010" : "#6a4fb0";
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
      const setLabel = () => {
        btn.textContent = chargedShotArmed ? "Charged Shot: tap a target…" : `Charged Shot (${CHARGE_CAP}⚡)`;
        btn.style.background = chargedShotArmed ? "#a06010" : "#c04fd0";
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
    // a Warrior with a spare charge can pick either each turn.
    if (currentPower.bulwarkTargets.length > 0) {
      const btn = document.createElement("button");
      const setLabel = () => {
        btn.textContent = bulwarkArmed ? "Bulwark: tap your token…" : `Bulwark (1⚡)`;
        btn.style.background = bulwarkArmed ? "#a06010" : "#6a4fb0";
      };
      setLabel();
      btn.addEventListener("click", () => {
        bulwarkArmed = !bulwarkArmed;
        bulwarkTargetIds.clear();
        if (bulwarkArmed) for (const id of currentPower!.bulwarkTargets) bulwarkTargetIds.add(id);
        else hideHoverGlow();
        setLabel();
      });
      movesEl.appendChild(btn);
    }
    if (currentPowerMoves) {
      for (let i = 0; i < currentPowerMoves.length; i++) {
        const m = currentPowerMoves[i];
        if (!m.chargeAvailable) continue;
        const btn = document.createElement("button");
        btn.textContent = `Charge: ${tokenLabel(m.tokenId)} ${tileLabel(m.from)}→${tileLabel(m.to)}`;
        btn.style.background = "#6a4fb0";
        const moveIndex = i;
        btn.addEventListener("click", () => {
          sendToServer({ type: "usePower", action: { kind: "charge", moveIndex } });
        });
        movesEl.appendChild(btn);
      }
    }
  }
}

movesEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  // "Play Again" branch. No more per-move buttons live here.
  if (btn.dataset.newmatch) {
    ws.send(JSON.stringify({ type: "newMatch" } satisfies ClientMessage));
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
      sendToServer({ type: "usePower", action: { kind: "bulwark", tokenId: target } });
      bulwarkArmed = false;
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
    }
    return;
  }
  const tokenId = findEligibleMeshUnderPointer(e.clientX, e.clientY);
  if (tokenId === null) return;
  const moveIdx = moveIndexByToken.get(tokenId);
  if (moveIdx === undefined) return;
  ws.send(
    JSON.stringify({ type: "chooseMove", moveIndex: moveIdx } satisfies ClientMessage),
  );
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
  movesEl.innerHTML =
    `<button data-newmatch="1" style="background:#c73;">Play Again</button>`;
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
  ws.send(JSON.stringify({ type: "newMatch" } satisfies ClientMessage));
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
// Tapping the board puts the popout away.
canvas.addEventListener("pointerdown", () => railEl.classList.remove("audio-open"));

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
  lastBulwark?: { tokenId: number } | null;
  lastBulwarkBlock?: { tokenIds: number[] } | null;
  lastChargeEvent?: { player: PlayerId; delta: number } | null;
  lastRainOfArrows?: { targetTokenId: number | null } | null;
  lastUltimate?: { kind: "blinkStrike" | "warpath"; targetTokenId: number; sweptTokenIds: number[] } | null;
  wasSkipped: boolean;
  skippedPlayer: PlayerId | null;
  skipReason: "flip-zero" | "no-legal-move" | null;
}) {
  const chargeFor = (player: PlayerId): string =>
    msg.lastChargeEvent && msg.lastChargeEvent.player === player ? chargeSuffix(msg.lastChargeEvent.delta) : "";

  if (msg.wasSkipped && msg.skippedPlayer) {
    const who = playerLabel(msg.skippedPlayer);
    const isMe = msg.skippedPlayer === myRole;
    const label = isMe ? "Your" : `${who}'s`;
    const reason =
      msg.skipReason === "flip-zero"
        ? "flipped 0 — skip"
        : "no legal move — skip";
    showAnnouncement(`${label} turn: ${reason}${chargeFor(msg.skippedPlayer)}`, "skip");
    return;
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
    showAnnouncement(`${subject} Bulwark${plural} blocked a capture!`, "shield");
    return;
  }

  if (msg.lastBulwark && msg.lastMovePlayer) {
    const who = playerLabel(msg.lastMovePlayer);
    const isMe = msg.lastMovePlayer === myRole;
    const subject = isMe ? "You" : who;
    const target = isMe ? "your" : "their";
    showAnnouncement(`${subject} raised Bulwark on ${target} token${chargeFor(msg.lastMovePlayer)}`, "shield");
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
      showAnnouncement(`${subject} landed on shield (${tileDisplay(m.to)}) — extra turn${suffix}`, "shield");
      return;
    }
    // Master Killer moves may carry Snipe/Charge-sweep bonus captures on
    // top of captures — PowerMove is a structural superset of Move, so
    // these fields are simply absent (undefined) on a classic Move.
    const bonusCaptures = "bonusCaptures" in m ? m.bonusCaptures.length : 0;
    const sweepCaptures = "chargeSweepCaptures" in m ? m.chargeSweepCaptures.length : 0;
    const totalCaptures = m.captures.length + bonusCaptures + sweepCaptures;
    if (totalCaptures > 0) {
      const target = isMe ? "opponent's" : "your";
      showAnnouncement(
        `${subject} captured ${target} token${totalCaptures > 1 ? "s" : ""} on ${tileDisplay(m.to)}${suffix}`,
        "capture",
      );
      return;
    }
    if (m.to >= PATH_LENGTH) {
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

  // No move, no push, no skip — the only thing left that can still change
  // a charge count is a Re-flip (which doesn't end the turn, so none of
  // the above fire). Give it its own small confirmation.
  if (msg.lastChargeEvent) {
    const who = playerLabel(msg.lastChargeEvent.player);
    const isMe = msg.lastChargeEvent.player === myRole;
    const subject = isMe ? "You" : who;
    showAnnouncement(`${subject} re-flipped${chargeSuffix(msg.lastChargeEvent.delta)}`, "shield");
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

let ws: WebSocket;
let reconnectDelay = 500;
/** Queued messages to flush once the socket (re)opens. */
const pendingSends: string[] = [];
/** True while a rejoin is in flight — an error then means our seat is gone. */
let awaitingRejoin = false;

// Seat session — survives page reloads (mobile browsers kill tabs freely)
// and the connection recycling of hosted WebSockets.
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

function connect() {
  setStatus(`Connecting…`);
  ws = new WebSocket(REFEREE_URL);
  ws.addEventListener("open", () => {
    reconnectDelay = 500;
    setStatus("Connected", "ok");
    // Mid-game? Resume the seat before anything else.
    const session = loadSession();
    if (session) {
      awaitingRejoin = true;
      ws.send(JSON.stringify({ type: "rejoin", ...session } satisfies ClientMessage));
    }
    for (const payload of pendingSends.splice(0)) ws.send(payload);
  });
  // Hosted WebSocket connections have a maximum lifetime — dropping and
  // reconnecting (with the seat session above) is NORMAL, not an error.
  ws.addEventListener("close", () => {
    setStatus("Reconnecting…", "err");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  });
  ws.addEventListener("error", () => setStatus("Connection error", "err"));
  ws.addEventListener("message", (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "role":
        myRole = msg.player;
        myRoom = msg.room;
        myVariant = msg.variant;
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
        bulwarkTargetIds.clear();
        pickedClasses = { p1: null, p2: null };
        updatePlates(null); // plates reappear at class pick / first state
        classpickEl.classList.remove("show");
        inCpuGame = msg.vsCpu;
        awaitingRejoin = false;
        saveSession({ room: msg.room, seat: msg.player, seatToken: msg.seatToken });
        hideMenu();
        hud.textContent = inCpuGame
          ? "You are Red — vs Computer"
          : "You are Red. Waiting for opponent…";
        break;
      case "classPick":
        // A class-pick phase means a fresh match — any lingering power info
        // (rematch after a game over) is stale, so pickedClasses drives the
        // plates until the first state broadcast takes over.
        currentPower = null;
        currentPowerMoves = null;
        pickedClasses = { ...msg.classes };
        classpickEl.classList.add("show");
        renderClassPick(msg);
        updatePlates(null);
        break;
      case "waiting":
        hud.textContent = msg.reason;
        // PvP room with an empty seat: surface the invite code + link.
        if (myRoom && !inCpuGame) showRoomInfo(myRoom);
        break;
      case "opponentLeft":
        resetToMenu("Opponent left the game");
        break;
      case "opening": {
        hideRoomInfo();
        hideWinScreen(); // a rematch re-enters the flip-off
        classpickEl.classList.remove("show"); // class pick (if any) is done
        rollPending = null;
        const mySide: PlayerId = myRole ?? "p1";
        // Tumble any flips we haven't shown yet this round.
        for (const seat of ["p1", "p2"] as PlayerId[]) {
          const count = msg.flips[seat];
          if (count !== null && seenOpeningFlips[seat] === null) {
            triggerCoinFlip(count, seat === mySide ? myCoins : theirCoins);
          }
        }
        seenOpeningFlips = { ...msg.flips };

        if (msg.first !== null) {
          // Resolved — normal turns take over from here.
          openingTapArmed = false;
          seenOpeningFlips = { p1: null, p2: null };
          const isMe = msg.first === myRole;
          showAnnouncement(isMe ? "You take first move!" : "Opponent takes first move", isMe ? "escape" : "skip");
          break;
        }
        if (msg.tie) {
          openingTapArmed = false;
          setTimeout(() => showAnnouncement("Tie — flip again!", "shield"), 900);
          break;
        }
        const iFlipped = msg.flips[mySide] !== null;
        openingTapArmed = !iFlipped;
        if (!iFlipped) {
          hud.innerHTML = `<div>Flip for first move</div><div style="color:#ffd370">Tap your coins</div>`;
          showAnnouncement("Flip for first move — tap your coins", "shield");
        } else {
          hud.innerHTML = `<div>Flip for first move</div><div>Waiting for opponent…</div>`;
        }
        break;
      }
      case "state":
        hideRoomInfo(); // both seats filled — invite banner is done
        // If a new match started while this client had the win modal open
        // (opponent clicked Play Again first), dismiss it.
        if (msg.state.winner === null) hideWinScreen();
        // Show the "how did we get here" announcement BEFORE refreshing
        // markers, so the banner appears at the same time as the animation.
        announceFromState(msg);
        refreshMarkers(msg.state);
        // Master Killer: public class/charge/ward info, then re-derive the
        // token tints. No-op (clears to no tint) in classic rooms.
        currentPower = msg.power ?? null;
        currentPowerMoves = msg.powerMoves ?? null;
        updateTokenTints(msg.state);
        pushArmed = false;
        pushTargetIds.clear();
        chargedShotArmed = false;
        chargedShotTargetIds.clear();
        blinkStrikeArmed = false;
        blinkStrikeTargetIds.clear();
        warpathArmed = false;
        warpathTargetIds.clear();
        bulwarkArmed = false;
        bulwarkTargetIds.clear();
        // Avatar plates: portraits, gems, turn glow. The gem flash rides the
        // server's authoritative charge diff so it can't drift from the rules.
        updatePlates(msg.state);
        if (msg.lastChargeEvent) {
          const container = viewSide(msg.lastChargeEvent.player) === "p1" ? gemsMe : gemsThem;
          flashGems(container, msg.lastChargeEvent.delta > 0 ? "flare" : "spend");
        }
        {
          const mine = msg.state.currentPlayer === (myRole ?? "p1");
          // PowerMove is a structural superset of Move, so it drops straight
          // into the existing tap-to-move plumbing unchanged.
          const movesForTap: Move[] | null =
            myVariant === "masterKiller" ? currentPowerMoves : msg.legalMoves;
          // The player rolls their own hand: every flip of mine waits for a
          // tap on my coin pile (the pile glows while it waits). The CPU's
          // rolls animate on their own.
          if (msg.flip !== null && mine) {
            rollPending = { flip: msg.flip, legalMoves: movesForTap, state: msg.state };
            renderHud(msg.state, null);
            hud.innerHTML += `<div style="color:#ffd370">Tap your coins to roll</div>`;
            renderMoves(null, false);
          } else {
            renderHud(msg.state, msg.flip);
            renderMoves(movesForTap, mine);
            renderPowerActions(mine);
            // Each broadcast with flip !== null is a fresh flip; the flip
            // belongs to the player about to move, so their coin set tumbles.
            if (msg.flip !== null) {
              triggerCoinFlip(msg.flip, mine ? myCoins : theirCoins);
            }
          }
        }
        break;
      case "gameOver": {
        setStatus(`Game over — ${playerLabel(msg.winner)} wins`, "ok");
        // Delay the modal so the winning token's escape flourish finishes
        // before the board dims. Also delay the bottom Play Again button so
        // it doesn't compete with the flight visually.
        const stats = msg.stats;
        const winner = msg.winner;
        setTimeout(() => {
          showWinScreen(winner, stats);
          showPlayAgainButton();
        }, WIN_SCREEN_DELAY_MS + 1500); // extra beat: the winner's mug slams before the modal
        break;
      }
      case "error":
        setStatus(`Server: ${msg.message}`, "err");
        // A failed rejoin means our old seat/room is gone — back to the menu.
        if (awaitingRejoin) {
          awaitingRejoin = false;
          clearSession();
          resetToMenu("That game has ended");
          break;
        }
        // Not seated yet (bad/full room code, including via a dead ?room=
        // link): make sure the menu is up and surface the reason there.
        if (!myRoom) {
          menuEl.classList.add("show");
          menuError.textContent = msg.message;
        }
        break;
    }
  });
}
connect();

// ---------------------------------------------------------------------------
// Mode menu — vs CPU / create room / join room
// ---------------------------------------------------------------------------

const menuEl = document.getElementById("menu") as HTMLDivElement;
const menuError = document.getElementById("menu-error") as HTMLDivElement;
const menuCodeInput = document.getElementById("menu-code") as HTMLInputElement;
const menuVariantToggle = document.getElementById("menu-variant-toggle") as HTMLButtonElement;
const roomInfoEl = document.getElementById("room-info") as HTMLDivElement;
const roomCodeEl = document.getElementById("room-code") as HTMLDivElement;
const roomLinkEl = document.getElementById("room-link") as HTMLDivElement;

let myRoom: string | null = null;
let inCpuGame = false;

// --- Master Killer mode: menu toggle + class-pick overlay ---
/** Ruleset picked in the menu, sent along with cpu/create joins. Ignored
 *  by the server for mode "join" — you play whatever room you're joining. */
let selectedVariant: "classic" | "masterKiller" = "classic";
function updateVariantToggleLabel() {
  const mk = selectedVariant === "masterKiller";
  menuVariantToggle.textContent = mk ? "⚔ Mode: Master Killer" : "Mode: Classic";
  menuVariantToggle.classList.toggle("variant-mk", mk);
}
menuVariantToggle.addEventListener("click", () => {
  selectedVariant = selectedVariant === "masterKiller" ? "classic" : "masterKiller";
  updateVariantToggleLabel();
});
updateVariantToggleLabel();

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

/** Send now, or as soon as the socket (re)opens. */
function sendToServer(msg: ClientMessage) {
  const payload = JSON.stringify(msg);
  if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  else pendingSends.push(payload); // flushed by connect()'s open handler
}

/** Back to the lobby: clear all match-local state and reopen the menu. */
function resetToMenu(message: string) {
  rollPending = null;
  openingTapArmed = false;
  seenOpeningFlips = { p1: null, p2: null };
  escapedByOwner = { p1: 0, p2: 0 };
  resetMug(myMug);
  resetMug(theirMug);
  hideWinScreen();
  hideRoomInfo();
  classpickEl.classList.remove("show");
  movesEl.innerHTML = "";
  currentMoves = null;
  eligibleTokenIds.clear();
  capturableIds.clear();
  hideHoverGlow();
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
  bulwarkTargetIds.clear();
  pickedClasses = { p1: null, p2: null };
  myVariant = "classic";
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
  hud.textContent = message;
  menuEl.classList.add("show");
}

(document.getElementById("menu-cpu") as HTMLButtonElement).addEventListener("click", () => {
  menuError.textContent = "";
  sendToServer({ type: "join", mode: "cpu", variant: selectedVariant });
});
(document.getElementById("menu-create") as HTMLButtonElement).addEventListener("click", () => {
  menuError.textContent = "";
  sendToServer({ type: "join", mode: "create", variant: selectedVariant });
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
// Game guide booklet — a little parchment book with flippable spreads.
// ---------------------------------------------------------------------------

const GUIDE_SPREADS: [string, string][] = [
  [
    `<h2>Regatta</h2>
     <p>A race across the water, played on one carved ship. Regatta is a
     rendition of the <em>Royal Game of Ur</em> — a four-thousand-year-old
     race game — as it appears on the tavern tables of Soulframe.</p>
     <p>Two crews race to sail all <span class="gold">four stones</span> down
     their own shore, across the contested midline, and home to the far dock.
     First crew to walk all four off the board wins.</p>
     <p style="margin-top:14px; font-style:italic;">Turn the page to learn the
     table &rsaquo;</p>`,
    `<h2>The Table</h2>
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
    `<h2>A Turn</h2>
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
    `<h2>Shields, Swords &amp; Home</h2>
     <ul>
       <li><b>Shield tiles</b> (the crest glyph) grant an
       <span class="gold">extra turn</span> and protect the stone standing
       there from capture.</li>
       <li>Land on an enemy stone in shared water and it is
       <span class="gold">captured</span> — sent back to their hand to start
       over. Hover an enemy stone to see if you can take it.</li>
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
     the whole match armed with its powers. It does not mix with the classic
     rules mid-match — pick it fresh from the menu.</p>
     <p>Every capture, every zero you roll, and every shield tile you land on
     fills your <span class="gold">charge</span> — up to two banked at once.
     Spend a charge to fire your class's active power, offered as a button
     beside your coins whenever you can afford it.</p>
     <p style="margin-top:14px; font-style:italic;">Turn the page to meet the
     three classes &rsaquo;</p>`,
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
       Push entirely — the charge is spent, but the stone doesn't move.
       Reach for Charged Shot if you want to touch a Warded stone.</li>
       <li><b>Charged Shot</b> (active, both charges at once): loose a
       heavier shot at an enemy stone in shared water, knocking it back a
       full ${CHARGED_SHOT_DISTANCE} paces — or ${CHARGED_SHOT_WARD_DISTANCE}
       paces against a <span class="gold">Warded</span> stone, the one shot
       that can still reach it at all. Send a target all the way home and
       one charge comes right back; otherwise it's a costly shove. The
       Archer's answer to a Warrior, who can never be Warded and so always
       takes the full hit.</li>
       <li><b>Rain of Arrows</b> (passive, free — the Archer's ultimate):
       land on a shield tile three times in a row, with your turn never
       once passing to the opponent in between, and that third landing
       strikes down a random enemy stone anywhere in shared water — even
       one standing on a shield, warded by a Mage, or sheltered by a
       Warrior's Bulwark. Rare by design: only three shield tiles exist on
       the whole board.</li>
     </ul>`,
  ],
  [
    `<h2>The Mage</h2>
     <ul>
       <li><b>Ward</b> (passive, free): the moment your bank holds a full
       two charges, your furthest-along stone still on the water cannot be
       captured — by anyone but a Warrior's Ward Breaker, and a Charged
       Shot can still knock it home. A plain Push can't budge it at all.</li>
       <li><b>Re-flip</b> (active, 1 charge): dislike your roll? Spend a
       charge to flip again instead of moving — once per turn, and it does
       not end your turn.</li>
       <li>Ward always follows whichever of your stones is furthest along —
       send that one all the way home and it passes to whichever stone
       takes the lead.</li>
       <li><b>Blink Strike</b> (active, spends your ultimate): land on a
       shield tile three times in a row, turn never once passing to the
       opponent, and you may teleport your furthest-along stone straight
       onto any enemy in shared water — capturing it even through a shield
       or a Ward.</li>
     </ul>`,
    `<h2>The Warrior</h2>
     <ul>
       <li><b>Ward Breaker</b> (passive, free): walk onto a Warded enemy
       stone and the Ward breaks — captured all the same, and your stone
       stands safe from capture until it next moves.</li>
       <li><b>Charge</b> (active, 1 charge): make your move a sweep — one
       enemy stone in shared water between where you started and where you
       land is captured too, Warded or not. Ward Breaker means Warriors
       cut through a Ward wherever they meet one, mid-sweep included.</li>
       <li>The Warrior is the one class no Ward can stop cold — everyone
       else needs a Push or a lucky Re-flip instead.</li>
       <li><b>Warpath</b> (active, spends your ultimate): land on a shield
       tile three times running, then teleport your least-advanced stone
       onto any enemy in shared water — capturing it plus every unprotected
       enemy stone caught between where it started and where it lands, no
       cap, Warded or not. Break a Ward along the way and the landing stone
       stands safe from capture until it next moves.</li>
       <li><b>Bulwark</b> (active, 1 charge): raise a shield over one of
       YOUR OWN stones — it cannot be captured, swept by Charge, or taken by
       an enemy ultimate, and a Push can only shove it, never send it home.
       It fades after a few of your turns unused, or the instant it actually
       saves the stone, whichever comes first.</li>
     </ul>`,
  ],
];

const guideOverlay = document.getElementById("guide-overlay") as HTMLDivElement;
const guideBook = document.getElementById("guide-book") as HTMLDivElement;
const guideLeft = document.getElementById("guide-left") as HTMLDivElement;
const guideRight = document.getElementById("guide-right") as HTMLDivElement;
const guideDots = document.getElementById("guide-dots") as HTMLDivElement;
let guideSpread = 0;

function renderGuide() {
  const [l, r] = GUIDE_SPREADS[guideSpread];
  guideLeft.innerHTML = l;
  guideRight.innerHTML = r;
  guideDots.innerHTML = GUIDE_SPREADS.map(
    (_, i) => `<span${i === guideSpread ? ' class="on"' : ""}></span>`,
  ).join("");
  // retrigger the page-flip animation
  guideBook.classList.remove("flip");
  void guideBook.offsetWidth;
  guideBook.classList.add("flip");
}

function turnGuide(dir: number) {
  const next = guideSpread + dir;
  if (next < 0 || next >= GUIDE_SPREADS.length) return;
  guideSpread = next;
  renderGuide();
}

(document.getElementById("guide-toggle") as HTMLButtonElement).addEventListener("click", () => {
  guideSpread = 0;
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
guideRight.addEventListener("click", () => turnGuide(1));
guideLeft.addEventListener("click", () => turnGuide(-1));
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
  if (loadSession()) {
    hud.textContent = "Reconnecting to your game…"; // rejoin sent on socket open
  } else if (linkedRoom) {
    sendToServer({ type: "join", mode: "join", room: linkedRoom.toUpperCase() });
    hud.textContent = "Joining room…";
  } else {
    menuEl.classList.add("show");
    hud.textContent = "Pick a game mode";
  }
}

// ---------------------------------------------------------------------------
// Render loop (with per-frame lerp toward marker targets for smooth motion)
// ---------------------------------------------------------------------------

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
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
  updateCoins(now);
  updateMugs(now);
  myMugGlow.visible = myAvailableSips() > 0;
  renderer.render(scene, camera);
}
tick();
