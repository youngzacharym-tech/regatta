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

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111116);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
// Shared perspective: both players see the board from the same angle.
// Aimed at the board mesh's visual center (x -0.5) — the tile grid is at the
// origin but the ship's decorative prow extends further to -X (mirrored).
camera.position.set(-0.5, 4.8, 4.8);
camera.lookAt(-0.5, 0.15, 0);

// Environment lighting — without it, metallic materials (the gold middle-row
// stamps, bronze coins) reflect nothing and render black.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

scene.add(new THREE.AmbientLight(0xffffff, 0.25));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(4, 8, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xa0b8ff, 0.35);
fill.position.set(-4, 3, -2);
scene.add(fill);

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
// Mirror across the long axis so the ship faces the way Regatta's board
// normally does. layout.ts x coordinates are negated to match (three.js
// corrects triangle winding for negative scales automatically).
boardGroup.scale.x = -1;
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
    boardGroup.add(gltf.scene);
  },
  undefined,
  (err) => console.error("Failed to load", GLB_URL, err),
);

// ---------------------------------------------------------------------------
// Token markers (8 cylinders — 4 per player)
// ---------------------------------------------------------------------------

const tokenGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.16, 24);
// Prototypes only — each marker clones one of these so its emissive/color
// can be toggled per-token (needed for the shield glow, which lights up only
// the specific tokens sitting on shield tiles).
const p1Mat = new THREE.MeshStandardMaterial({ color: 0xc02020, roughness: 0.5 });
const p2Mat = new THREE.MeshStandardMaterial({ color: 0x2040c0, roughness: 0.5 });

const P1_COLOR = 0xc02020;
const P2_COLOR = 0x2040c0;
const SHIELD_EMISSIVE = 0xffcc44; // warm gold — reads as "protected"
const SHIELD_INTENSITY = 0.65;

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
// Each player has their OWN set of 4 coins: the viewer's near the bottom
// edge, the opponent's past the board's far edge — so it's always obvious
// whose flip a number belongs to. The referee is authoritative on the flip
// count; the client just decides randomly WHICH coins land marked-side up.
// ---------------------------------------------------------------------------

const coinGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.03, 32);
coinGeo.rotateX(Math.PI / 2); // lay flat by default; +Z becomes the "up" face

// Multi-material cylinder: index 0 = side (edge), 1 = top face, 2 = bottom face.
// With the rotateX above, "top face" (index 1) is the +Z face, "bottom" is -Z.
const coinSideMat = new THREE.MeshStandardMaterial({ color: 0xa87c3d, roughness: 0.5, metalness: 0.75 });
const coinMarkedMat = new THREE.MeshStandardMaterial({ color: 0xf4d073, roughness: 0.35, metalness: 0.9, emissive: 0x110800, emissiveIntensity: 0.3 });
const coinBlankMat = new THREE.MeshStandardMaterial({ color: 0x5c3f1c, roughness: 0.65, metalness: 0.5 });
const coinMats = [coinSideMat, coinMarkedMat, coinBlankMat];

interface CoinAnim {
  mesh: THREE.Mesh;
  restPos: THREE.Vector3;
  isFlipping: boolean;
  startTime: number;
  duration: number;
  willShowMarked: boolean;
  spinTurns: number;
  /** Last tint applied (sculpted mode) — re-applied when emphasis changes. */
  lastTint: number;
  /** Dimmed = not the set whose flip is currently displayed. */
  dimmed: boolean;
}

const COIN_REST_Y = 0.05;
const COIN_Z = 2.3;        // viewer's coin row, front of the camera view
const THEIR_COIN_Z = -2.1; // opponent's row, past the board's far edge
const COIN_SPACING = 0.5;

// Once the sculpted pieces load, coins switch from the multi-material
// cylinder (bright top face / dark bottom face) to a single-material sculpted
// mesh — the marked/blank result is then shown by tinting the whole coin.
let coinsAreSculpted = false;
const COIN_MARKED_TINT = 0xf4d073;
const COIN_BLANK_TINT = 0x5c3f1c;
const COIN_SPIN_TINT = 0xa87c3d; // neutral bronze while tumbling

function tintCoin(coin: CoinAnim, hex: number) {
  coin.lastTint = hex;
  if (!coinsAreSculpted) return;
  const mat = coin.mesh.material as THREE.MeshStandardMaterial;
  mat.color.setHex(hex);
  if (coin.dimmed) mat.color.multiplyScalar(0.45);
}

function makeCoinSet(z: number): CoinAnim[] {
  const set: CoinAnim[] = [];
  for (let i = 0; i < 4; i++) {
    const mesh = new THREE.Mesh(coinGeo, coinMats);
    const restPos = new THREE.Vector3(i * COIN_SPACING - 0.75, COIN_REST_Y, z);
    mesh.position.copy(restPos);
    // Start at rest showing marked side up (rotation.x = 0).
    scene.add(mesh);
    set.push({
      mesh,
      restPos,
      isFlipping: false,
      startTime: 0,
      duration: 700,
      willShowMarked: true,
      spinTurns: 6,
      lastTint: COIN_MARKED_TINT,
      dimmed: false,
    });
  }
  return set;
}

const myCoins = makeCoinSet(COIN_Z);
const theirCoins = makeCoinSet(THEIR_COIN_Z);
const allCoins = [...myCoins, ...theirCoins];

/** Emphasis: the set whose flip is on display renders full-size and bright;
 *  the other set shrinks and darkens (but keeps showing its last result). */
function setCoinSetActive(set: CoinAnim[], active: boolean) {
  for (const coin of set) {
    coin.dimmed = !active;
    coin.mesh.scale.setScalar(active ? 1 : 0.82);
    tintCoin(coin, coin.lastTint);
  }
}

/** Undo the tap-me pulse's scale wobble (see tick()). */
function resetCoinPulse() {
  for (const coin of myCoins) {
    coin.mesh.scale.setScalar(coin.dimmed ? 0.82 : 1);
  }
}

// Swap the placeholder cylinders for the sculpted piece meshes once they
// load. Colors stay owned by the game (red/blue markers, coin result tints);
// only geometry comes from the GLB. If the load fails, cylinders remain.
gltfLoader.load(
  PIECES_URL,
  (gltf) => {
    const geoOf = (name: string) =>
      (gltf.scene.getObjectByName(name) as THREE.Mesh | undefined)?.geometry;
    const tokenP1 = geoOf("token_p1");
    const tokenP2 = geoOf("token_p2");
    const coinSculpt = geoOf("coin");
    if (!tokenP1 || !tokenP2 || !coinSculpt) {
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
    applyTokenGeometries();
    // Same lay-flat convention the procedural coin used: bake the design face
    // to point +Z, so the existing rotation.x flip logic works unchanged.
    coinSculpt.rotateX(Math.PI / 2);
    for (const coin of allCoins) {
      coin.mesh.geometry = coinSculpt;
      coin.mesh.material = new THREE.MeshStandardMaterial({
        color: COIN_MARKED_TINT,
        roughness: 0.35,
        metalness: 0.9,
      });
    }
    coinsAreSculpted = true;
    for (const coin of allCoins) {
      tintCoin(coin, coin.willShowMarked ? COIN_MARKED_TINT : COIN_BLANK_TINT);
    }
  },
  undefined,
  (err) => console.error("Failed to load", PIECES_URL, err),
);

function triggerCoinFlip(markedCount: number, owner: PlayerId) {
  const now = performance.now();
  // The owner's set animates; whose set that is on-screen is seat-relative.
  const set = viewSide(owner) === "p1" ? myCoins : theirCoins;
  // During the opening flip-off both sets stay full brightness (both are
  // "on display"); in normal play the non-flipping set dims.
  if (!openingActive) {
    setCoinSetActive(set, true);
    setCoinSetActive(set === myCoins ? theirCoins : myCoins, false);
  } else {
    setCoinSetActive(set, true);
  }
  // Pick markedCount coin indices uniformly at random to show the marked face.
  const indices = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const markedSet = new Set(indices.slice(0, markedCount));

  for (let i = 0; i < 4; i++) {
    set[i].isFlipping = true;
    set[i].startTime = now + Math.random() * 80;
    set[i].duration = 550 + Math.random() * 250;
    set[i].willShowMarked = markedSet.has(i);
    set[i].spinTurns = 5 + Math.random() * 4;
    tintCoin(set[i], COIN_SPIN_TINT);
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
      tintCoin(coin, coin.willShowMarked ? COIN_MARKED_TINT : COIN_BLANK_TINT);
    } else {
      const t = elapsed / coin.duration;
      // Total rotation: spinTurns full spins over the duration, plus the
      // final half-turn if we're landing blank-side up.
      const finalRot = coin.willShowMarked ? 0 : Math.PI;
      coin.mesh.rotation.x = coin.spinTurns * Math.PI * 2 * t + finalRot * t;
      // Parabolic Y arc so coins arc up and back down.
      coin.mesh.position.y = coin.restPos.y + Math.sin(t * Math.PI) * 0.35;
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
    // Own-material approach: each marker has its own MeshStandardMaterial clone
    // so color + emissive can be set independently. Drive from owner every frame
    // so red/blue still tracks the player if the array is ever reordered.
    // (Emissive is applied per-frame in the render loop — see tick().)
    const mat = marker.mesh.material as THREE.MeshStandardMaterial;
    // Seat-relative colors: mine are always red, opponent's always blue.
    mat.color.setHex(token.owner === (myRole ?? "p1") ? P1_COLOR : P2_COLOR);

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
      audio.play("capture");
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
      audio.play("escape");
    } else if (!wasOnShield && nowOnShield) {
      // Landed on a shield — chime.
      audio.play("shield");
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

// --- Opening flip-off state -------------------------------------------------
/** True from the opening prompt until "who goes first" is resolved. */
let openingActive = false;
/** True while the game is waiting for THIS player to tap their coins. */
let openingTapArmed = false;
/** Flips already animated this opening round (to animate only new ones). */
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

/** During the opening flip-off, taps target the player's own coin row.
 *  Distance-to-ray instead of exact mesh intersection: the coins are ~0.2
 *  wide with gaps between them, and a fat target beats a fumbled tap —
 *  anywhere on or near the row counts. */
function myCoinUnderPointer(clientX: number, clientY: number): boolean {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return myCoins.some(
    (c) => raycaster.ray.distanceToPoint(c.mesh.position) < 0.4,
  );
}

canvas.addEventListener("pointerdown", (e) => {
  if (openingTapArmed) {
    if (myCoinUnderPointer(e.clientX, e.clientY)) {
      openingTapArmed = false;
      resetCoinPulse();
      sendToServer({ type: "openingFlip" });
      hud.innerHTML = `<div>Flip for first move</div><div>Flipping…</div>`;
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
  // Immediate feedback: clear eligibility so the pulse fades this frame.
  eligibleTokenIds.clear();
  moveIndexByToken.clear();
});

// Cursor + subtle hover feedback: pointer style when hovering a tappable thing.
canvas.addEventListener("pointermove", (e) => {
  const hit = openingTapArmed
    ? myCoinUnderPointer(e.clientX, e.clientY)
    : findEligibleMeshUnderPointer(e.clientX, e.clientY) !== null;
  canvas.style.cursor = hit ? "pointer" : "default";
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

const audioUnlock = document.getElementById("audio-unlock") as HTMLDivElement;
const muteToggle = document.getElementById("mute-toggle") as HTMLButtonElement;

audioUnlock.addEventListener("click", async () => {
  await audio.unlock();
  audioUnlock.classList.add("hidden");
});

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
      case "opening": {
        hideRoomInfo();
        hideWinScreen(); // rematch via Play Again re-enters the flip-off
        const mySide: PlayerId = myRole ?? "p1";
        // Animate flips we haven't shown yet this round.
        for (const seat of ["p1", "p2"] as PlayerId[]) {
          const count = msg.flips[seat];
          if (count !== null && seenOpeningFlips[seat] === null) {
            triggerCoinFlip(count, seat);
            audio.play("coin");
          }
        }
        seenOpeningFlips = { ...msg.flips };

        if (msg.first !== null) {
          // Resolved — normal state flow takes over from here.
          openingActive = false;
          openingTapArmed = false;
          seenOpeningFlips = { p1: null, p2: null };
          resetCoinPulse();
          const isMe = msg.first === myRole;
          showAnnouncement(isMe ? "You go first!" : "Opponent goes first", isMe ? "escape" : "skip");
          break;
        }

        openingActive = true;
        if (msg.tie) {
          openingTapArmed = false;
          resetCoinPulse();
          // Re-arm happens when the cleared prompt (both null) arrives.
          setTimeout(() => showAnnouncement("Tie — flip again!", "shield"), 900);
          break;
        }
        const iFlipped = msg.flips[mySide] !== null;
        openingTapArmed = !iFlipped;
        if (!iFlipped) {
          hud.innerHTML = `<div>Flip for first move</div><div><b style="color:#ffd370">Tap your coins</b></div>`;
          showAnnouncement("Flip for first move — tap your coins", "shield");
        } else {
          resetCoinPulse();
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
        renderHud(msg.state, msg.flip);
        renderMoves(msg.legalMoves, msg.state.currentPlayer === myRole);
        // Each state broadcast with flip !== null corresponds to a new flip;
        // the referee only broadcasts once per fresh flip.
        if (msg.flip !== null) {
          triggerCoinFlip(msg.flip, msg.state.currentPlayer);
          audio.play("coin");
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
          audio.play("win");
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

// Any interaction with the menu is a user gesture — use it to unlock audio
// so the player never sees the separate "tap to enable sound" screen.
menuEl.addEventListener(
  "click",
  async () => {
    await audio.unlock();
    document.getElementById("audio-unlock")!.classList.add("hidden");
  },
  { once: true },
);

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
  hideWinScreen();
  hideRoomInfo();
  movesEl.innerHTML = "";
  currentMoves = null;
  eligibleTokenIds.clear();
  for (const marker of markers) {
    marker.mesh.visible = false;
    marker.flying = false;
    marker.lastPosition = -1;
  }
  myRole = null;
  myRoom = null;
  inCpuGame = false;
  openingActive = false;
  openingTapArmed = false;
  seenOpeningFlips = { p1: null, p2: null };
  setCoinSetActive(myCoins, true);
  setCoinSetActive(theirCoins, true);
  clearSession();
  hud.textContent = message;
  menuEl.classList.add("show");
}

// How to Play overlay — open from the menu, close via × or "Got it".
const howtoEl = document.getElementById("howto") as HTMLDivElement;
(document.getElementById("menu-howto") as HTMLButtonElement).addEventListener("click", () => {
  howtoEl.classList.add("show");
});
for (const id of ["howto-close", "howto-gotit"]) {
  (document.getElementById(id) as HTMLButtonElement).addEventListener("click", () => {
    howtoEl.classList.remove("show");
  });
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
  // Golden pulse for eligible-to-move tokens (0.35 → 0.9 sine sweep).
  const pulse = 0.35 + Math.abs(Math.sin(now * 0.005)) * 0.55;

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

    // Emissive: eligible tokens pulse gold, else shield glow if on a shield.
    const mat = marker.mesh.material as THREE.MeshStandardMaterial;
    const isEligible = eligibleTokenIds.has(i);
    const onShield =
      marker.lastPosition >= 0 &&
      marker.lastPosition < PATH_LENGTH &&
      BOARD_LAYOUT[marker.lastPosition].type === "shield";
    if (isEligible) {
      mat.emissive.setHex(SHIELD_EMISSIVE);
      mat.emissiveIntensity = pulse;
    } else if (onShield) {
      mat.emissive.setHex(SHIELD_EMISSIVE);
      mat.emissiveIntensity = SHIELD_INTENSITY;
    } else {
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
    }
  }
  updateCoins(now);
  // Opening flip-off: my coins bob for attention until I tap them.
  if (openingTapArmed) {
    const bob = 1 + Math.abs(Math.sin(now * 0.004)) * 0.16;
    for (const coin of myCoins) coin.mesh.scale.setScalar(bob);
  }
  renderer.render(scene, camera);
}
tick();
