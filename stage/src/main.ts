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

// Each captain gets a beer — one mug per side of the table.
gltfLoader.load(
  "/mug.glb",
  (gltf) => {
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    const place = (x: number, z: number, rotY: number) => {
      const mug = gltf.scene.clone(true);
      mug.scale.setScalar(1.15);
      mug.position.set(x, TABLE_Y + 0.575, z);
      mug.rotation.y = rotY;
      scene.add(mug);
    };
    place(0.5, 2.12, -2.44); // beside my coins, handle turned out
    place(0.5, -2.0, 2.4);   // the opponent's, across the table
  },
  undefined,
  (err) => console.error("Failed to load /mug.glb", err),
);

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
// goes to the viewer's own tokens, the blue-design sculpt to the opponent's.
// Applied on load AND again when the seat arrives, since either can be first.
let sculptedTokenGeos: { red: THREE.BufferGeometry; blue: THREE.BufferGeometry } | null = null;

function applyTokenGeometries() {
  if (!sculptedTokenGeos) return;
  markers.forEach((marker, i) => {
    const owner: PlayerId = i < 4 ? "p1" : "p2";
    const mine = owner === (myRole ?? "p1");
    marker.mesh.geometry = mine ? sculptedTokenGeos!.red : sculptedTokenGeos!.blue;
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
}

// ---------------------------------------------------------------------------
// HUD + move buttons
// ---------------------------------------------------------------------------

const hud = document.getElementById("hud") as HTMLDivElement;
const status = document.getElementById("status") as HTMLDivElement;
const movesEl = document.getElementById("moves") as HTMLDivElement;

let myRole: PlayerId | null = null;
let currentMoves: Move[] | null = null;
/** Every roll of the player's coins waits for a tap on their pile. */
let rollPending: { flip: number; legalMoves: Move[] | null; state: GameState } | null = null;

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

function renderHud(state: GameState, flip: number | null) {
  const yours = state.currentPlayer === myRole;
  const myColor = "Red"; // seat-relative: every player sees themselves as Red
  const turnLabel = yours
    ? `<b style="color:#ffd370">Your turn</b>`
    : `<b>Opponent's turn</b>`;
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

canvas.addEventListener("pointerdown", (e) => {
  // Roll gate: your flip happens when you tap your coin pile.
  if (rollPending) {
    if (isMyCoinUnderPointer(e.clientX, e.clientY)) {
      const pending = rollPending;
      rollPending = null;
      triggerCoinFlip(pending.flip, myCoins);
      renderHud(pending.state, pending.flip);
      renderMoves(pending.legalMoves, true);
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
function findCapturableUnderPointer(clientX: number, clientY: number): number | null {
  if (capturableIds.size === 0) return null;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const ids = [...capturableIds].filter((i) => markers[i].mesh.visible);
  const meshes = ids.map((i) => markers[i].mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? ids[meshes.indexOf(hits[0].object as THREE.Mesh)] : null;
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
  const rollable = rollPending !== null && isMyCoinUnderPointer(e.clientX, e.clientY);
  canvas.style.cursor = hit !== null || capturable !== null || rollable ? "pointer" : "default";
  if (capturable !== null) {
    const m = markers[capturable];
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

muteToggle.addEventListener("click", () => {
  const nowMuted = !audio.isMuted();
  audio.setMuted(nowMuted);
  muteToggle.textContent = nowMuted ? "🔇" : "🔊";
});

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

function announceFromState(msg: {
  lastMove: Move | null;
  lastMovePlayer: PlayerId | null;
  wasSkipped: boolean;
  skippedPlayer: PlayerId | null;
  skipReason: "flip-zero" | "no-legal-move" | null;
}) {
  if (msg.wasSkipped && msg.skippedPlayer) {
    const who = playerLabel(msg.skippedPlayer);
    const isMe = msg.skippedPlayer === myRole;
    const label = isMe ? "Your" : `${who}'s`;
    const reason =
      msg.skipReason === "flip-zero"
        ? "flipped 0 — skip"
        : "no legal move — skip";
    showAnnouncement(`${label} turn: ${reason}`, "skip");
    return;
  }
  const m = msg.lastMove;
  if (!m || !msg.lastMovePlayer) return;
  const who = playerLabel(msg.lastMovePlayer);
  const isMe = msg.lastMovePlayer === myRole;
  const subject = isMe ? "You" : who;

  if (m.causesWin) {
    // Win screen will handle the celebration; don't double-announce.
    return;
  }
  if (m.landsOnShield) {
    showAnnouncement(
      `${subject} landed on shield (${tileDisplay(m.to)}) — extra turn`,
      "shield",
    );
    return;
  }
  if (m.captures.length > 0) {
    const target = isMe ? "opponent's" : `your` + (m.captures.length > 1 ? "" : "");
    showAnnouncement(
      `${subject} captured ${target} token${m.captures.length > 1 ? "s" : ""} on ${tileDisplay(m.to)}`,
      "capture",
    );
    return;
  }
  if (m.to >= PATH_LENGTH) {
    showAnnouncement(`${subject} escaped a token`, "escape");
    return;
  }
  // Normal quiet move — no announcement.
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
        rollPending = null;
        inCpuGame = msg.vsCpu;
        awaitingRejoin = false;
        saveSession({ room: msg.room, seat: msg.player, seatToken: msg.seatToken });
        applyTokenGeometries(); // seat known — re-deal red/blue sculpts
        hideMenu();
        hud.textContent = inCpuGame
          ? "You are Red — vs Computer"
          : "You are Red. Waiting for opponent…";
        break;
      case "waiting":
        hud.textContent = msg.reason;
        // PvP room with an empty seat: surface the invite code + link.
        if (myRoom && !inCpuGame) showRoomInfo(myRoom);
        break;
      case "opponentLeft":
        resetToMenu("Opponent left the game");
        break;
      case "state":
        hideRoomInfo(); // both seats filled — invite banner is done
        // If a new match started while this client had the win modal open
        // (opponent clicked Play Again first), dismiss it.
        if (msg.state.winner === null) hideWinScreen();
        // Show the "how did we get here" announcement BEFORE refreshing
        // markers, so the banner appears at the same time as the animation.
        announceFromState(msg);
        refreshMarkers(msg.state);
        {
          const mine = msg.state.currentPlayer === (myRole ?? "p1");
          // The player rolls their own hand: every flip of mine waits for a
          // tap on my coin pile (the pile glows while it waits). The CPU's
          // rolls animate on their own.
          if (msg.flip !== null && mine) {
            rollPending = { flip: msg.flip, legalMoves: msg.legalMoves, state: msg.state };
            renderHud(msg.state, null);
            hud.innerHTML += `<div style="color:#ffd370">Tap your coins to roll</div>`;
            renderMoves(null, false);
          } else {
            renderHud(msg.state, msg.flip);
            renderMoves(msg.legalMoves, mine);
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
        }, WIN_SCREEN_DELAY_MS);
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
const roomInfoEl = document.getElementById("room-info") as HTMLDivElement;
const roomCodeEl = document.getElementById("room-code") as HTMLDivElement;
const roomLinkEl = document.getElementById("room-link") as HTMLDivElement;

let myRoom: string | null = null;
let inCpuGame = false;

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
  hideWinScreen();
  hideRoomInfo();
  movesEl.innerHTML = "";
  currentMoves = null;
  eligibleTokenIds.clear();
  capturableIds.clear();
  hideHoverGlow();
  for (const marker of markers) {
    marker.mesh.visible = false;
    marker.flying = false;
    marker.lastPosition = -1;
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
  sendToServer({ type: "join", mode: "cpu" });
});
(document.getElementById("menu-create") as HTMLButtonElement).addEventListener("click", () => {
  menuError.textContent = "";
  sendToServer({ type: "join", mode: "create" });
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
       <li><b>Your stones</b> bear the <span class="gold">red star</span> and
       wait in a pile by your coins. The enemy's carry the blue blossom.</li>
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
       <li>First to bring <b>all four stones home</b> wins the race.</li>
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
  myCoinGlow.visible = rollPending !== null;
  // Fire flicker: stacked sines read surprisingly flame-like.
  const flick =
    4.5 * Math.sin(now * 0.011) + 3.2 * Math.sin(now * 0.023 + 1.7) + 2.4 * Math.sin(now * 0.047 + 0.6);
  fireLight.intensity = Math.max(fireCfg.intensity * 0.4, fireCfg.intensity + fireCfg.flicker * flick);
  const fs = 1 + fireCfg.flicker * (0.06 * Math.sin(now * 0.017 + 0.3) + 0.05 * Math.sin(now * 0.041));
  fireSprite.scale.set(fireCfg.size * fs, fireCfg.size * 0.73 * fs, 1);
  (fireSprite.material as THREE.SpriteMaterial).opacity =
    fireCfg.opacity + 0.2 * fireCfg.flicker * Math.abs(Math.sin(now * 0.013));
  updateCoins(now);
  renderer.render(scene, camera);
}
tick();
