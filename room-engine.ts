// ============================================================================
// room-engine.ts — the ONE turn engine for Regatta, shared by every transport.
//
// Everything here is PURE: no I/O, no timers, no Redis, no sockets. A room is
// a RoomDoc value; the engine exposes exactly three ways to produce the next
// one, and transports (api/room.ts on Vercel, referee.ts locally) are thin
// load→call→store adapters around them:
//
//   createRoomDoc(...)                — a fresh room
//   applyAction(doc, seat, action)   — a player did something
//   tick(doc, now)                   — time passed; fire any DUE transition
//
// WHY deadline-on-tick instead of setTimeout: this engine's transports are
// HTTP polling handlers with no long-lived process to hold a timer. Every
// state-advancing commit stamps `waitingSince = now`; tick() re-derives which
// delay is pending from the doc shape and fires it when `now - waitingSince`
// crosses it. Deadlines are absolute, so a room nobody polls simply pauses
// and catches up on the next request — and a superseding commit (e.g. a
// Re-flip landing before the auto-skip) resets the clock by construction,
// with no version/stamp bookkeeping.
//
// WHY an event log: poll responses must replay everything that happened since
// the client's last poll (bot move, auto-skip, charge flare) with full
// animation fidelity — some transitions are two frames on purpose (a zero
// flip's charge is granted on the flip commit but announced on the skip
// commit). Each commit appends one Event with a monotonic seq; clients render
// events in order and interact via the seat-gated overlay in viewFor().
// Events carry NO seat-private data (legalMoves/powerMoves live only in the
// overlay), so replay can never leak the opponent's options.
//
// Game logic is untouched: rulebook.ts / master-killer.ts decide everything;
// this file only orchestrates WHEN their pure functions run.
// ============================================================================

import {
  initialState,
  flipCoins,
  getLegalMoves,
  applyMove,
  applyNoMove,
  type GameState,
  type Move,
  type PlayerId,
} from "./rulebook";
import { pickBotMove } from "./bot";
import type { ChatMsg } from "./protocol";
import {
  applyBlinkStrike,
  applyBulwark,
  applyCharge as mkApplyCharge,
  applyChargedShot as mkApplyChargedShot,
  applyExhume,
  applyPowerMove,
  applyPush as mkApplyPush,
  applyRaiseDead,
  applyReflip as mkApplyReflip,
  applyWarpath,
  breakShieldStreak,
  canReflipAgain,
  CHARGE_CAP,
  getBlinkStrikeTargets,
  getBulwarkTargets,
  getChargedShotTargets,
  getExhumeTargets,
  getLegalPowerMoves,
  getPushTargets,
  getRaiseTargets,
  getWarpathTargets,
  grantZeroFlipCharge,
  initialPowerState,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
  type PlayerClass,
  type PowerAction,
  type PowerMove,
  type PowerState,
} from "./master-killer";
import { pickBotPowerAction } from "./master-killer-bot";
import type { BotDifficulty } from "./bot-difficulty";

// ============================================================================
// TUNABLES — the same rhythm constants the WS servers used, now data.
// ============================================================================

export const BOT_THINK_MS = 900; // human-feeling pause before the CPU acts
/** MK CPU zero-move rescue check fires before the auto-skip so a Mage bot
 *  can Re-flip out of a dead flip. Must stay < AUTO_SKIP_DELAY_MS. */
export const BOT_RESCUE_THINK_MS = 300;
export const AUTO_SKIP_DELAY_MS = 500;
/** A HUMAN Mage with a rescue available gets a real window to Re-flip out of
 *  a dead flip — under polling they may not even see the flip for a poll
 *  interval, so 500ms would skip them unconditionally. Everyone else keeps
 *  the snappy 500. */
export const AUTO_SKIP_WITH_RESCUE_MS = 4000;
export const OPENING_TIE_RESET_MS = 1600; // let the tie animate before re-arming
export const FIRST_TURN_REVEAL_MS = 1400; // let "X goes first" land before the flip
/** How many events the doc retains. Longer than any realistic burst between
 *  polls (flip→skip is 2; a long extra-turn chain is a handful). A client
 *  further behind than this gets a resync snapshot instead of replay. */
export const EVENT_WINDOW = 16;
export const CHAT_MAX = 40;
export const CHAT_TEXT_MAX = 200;
/** Heartbeat thresholds (driven off seatLastSeen, which adapters refresh on
 *  every authenticated request). Soft "away" must tolerate mobile tab
 *  backgrounding; hard "left" is when the room is considered abandoned. */
export const OPPONENT_AWAY_MS = 20_000;
export const OPPONENT_LEFT_MS = 120_000;

export const MK_CLASSES: PlayerClass[] = ["archer", "mage", "warrior", "necromancer"];

// ============================================================================
// WIRE-SAFE POWER STATE — PowerState is plain JSON now (safeTokens, its one
// Set, was removed with the transient-safety mechanic on 2026-07-17), but
// the boundary conversions stay: docs store the wire shape, and
// fromWirePower is where live-room back-compat migrations live.
// ============================================================================

export interface WirePowerState {
  classes: Record<PlayerId, PlayerClass>;
  charges: Record<PlayerId, number>;
  reflipsUsedThisTurn: number;
  shieldStreak: Record<PlayerId, number>;
  ultimateReady: Record<PlayerId, boolean>;
  bulwarked: Record<number, number>;
  bulwarkSaves: Record<number, number>;
}

export function toWirePower(p: PowerState): WirePowerState {
  return { ...p };
}
export function fromWirePower(w: WirePowerState): PowerState {
  return {
    ...w,
    // Docs persisted before the once-per-turn boolean (reflipUsedThisTurn)
    // became a counter read as undefined here — treat the old true as "one
    // re-flip already used" so a mid-deploy live room can't double-dip.
    reflipsUsedThisTurn:
      typeof w.reflipsUsedThisTurn === "number"
        ? w.reflipsUsedThisTurn
        : (w as { reflipUsedThisTurn?: boolean }).reflipUsedThisTurn
          ? 1
          : 0,
    // Same live-room back-compat: docs persisted before reinforced Bulwark
    // existed have no bulwarkSaves — every live Bulwark in them is a plain
    // 1-block cast, which an empty map means exactly. (A doc persisted with
    // the retired safeTokens array just carries a harmless extra key.)
    bulwarkSaves: w.bulwarkSaves ?? {},
  };
}

// ============================================================================
// DOC + EVENT SHAPES
// ============================================================================

export type RoomPhase = "classPick" | "opening" | "play";
export type Variant = "classic" | "masterKiller";

/** The public (both-seats-visible) Master Killer table state — classes,
 *  charges, wards, and the current player's targetable token lists. Safe to
 *  embed in events: it's already broadcast to both seats today. */
export interface PublicPower {
  classes: Record<PlayerId, PlayerClass>;
  charges: Record<PlayerId, number>;
  pushTargets: number[];
  chargedShotTargets: number[];
  ultimateReady: Record<PlayerId, boolean>;
  blinkStrikeTargets: number[];
  warpathTargets: number[];
  bulwarkTargets: number[];
  bulwarkedTokenIds: number[];
  raiseTargets: number[];
  /** Dark Resurrection's own list — same reserve-token pool as raiseTargets
   *  but gated on ITS destination tile, which can be free when the plain
   *  cast's is blocked (and vice versa). Without it the client would gate
   *  the full-bank gem on the plain cast's list and a server-legal dark
   *  cast could become unsendable. ADDITIVE field, raiseTargets' twin. */
  darkRaiseTargets: number[];
  exhumeTargets: number[];
  /** How many Re-flips the CURRENT player has already fired this turn —
   *  drives the client's Re-flip button gate (charges alone can't: a Mage
   *  at the REFLIPS_PER_TURN cap may still hold a charge, e.g. after a
   *  re-rolled zero refunds one). ADDITIVE field: older clients ignore it
   *  and fall back to their charges>=1 gate, exactly the pre-existing
   *  behavior. */
  reflipsUsedThisTurn: number;
}

/** One replayable frame. `state` events carry the same announcement fields
 *  the old ServerMessage "state" broadcast did — minus legalMoves/powerMoves,
 *  which are seat-private and live only in the poll overlay. `chat` events
 *  are wake-up markers only (the poll response carries the full chat log). */
export type RoomEvent =
  | {
      seq: number;
      kind: "classPick";
      classes: { p1: PlayerClass | null; p2: PlayerClass | null };
      ready: boolean;
    }
  | {
      seq: number;
      kind: "opening";
      flips: { p1: number | null; p2: number | null };
      first: PlayerId | null;
      tie: boolean;
    }
  | {
      seq: number;
      kind: "state";
      state: GameState;
      flip: number | null;
      power?: PublicPower;
      lastMove: Move | PowerMove | null;
      lastMovePlayer: PlayerId | null;
      lastPush: { targetTokenId: number } | null;
      lastChargedShot: { targetTokenId: number } | null;
      /** `reinforced` is additive (older events lack it): true when the
       *  cast was the full-bank Reinforced Bulwark. */
      lastBulwark: { tokenId: number; reinforced?: boolean } | null;
      lastBulwarkBlock: { tokenIds: number[] } | null;
      lastChargeEvent: { player: PlayerId; delta: number } | null;
      lastRainOfArrows: { targetTokenId: number | null } | null;
      lastUltimate: { kind: "blinkStrike" | "warpath"; targetTokenId: number; sweptTokenIds: number[] } | null;
      /** Warrior's Charge was just EXECUTED this commit (vs the normal move
       *  it was offered on). lastMove's chargeSweepCaptures is only a
       *  PREVIEW list — this is the authoritative "it actually happened"
       *  signal, same lifecycle as lastPush. `sweptTokenIds` are the extra
       *  captures the sweep actually took (may be empty). */
      lastChargeSweep: { sweptTokenIds: number[] } | null;
      /** Mage's Re-flip just resolved on this commit. lastChargeEvent alone
       *  can't signal it: a re-rolled zero refunds the spent charge, the
       *  delta nets to 0 and the event goes null — but the re-flip still
       *  happened and the client still owes the proc. Events from before
       *  this field existed read as undefined ≙ null. */
      lastReflip?: { player: PlayerId } | null;
      /** Necromancer's Raise Dead just resolved on this commit. Same
       *  turn-continues lifecycle as lastReflip: the flip is unchanged and
       *  the move list was recomputed against the board the raised token
       *  now stands on. `dark` is additive: true when the cast was the
       *  full-bank Dark Resurrection. Events from before this field
       *  existed read as undefined ≙ null. */
      lastRaise?: { tokenId: number; dark?: boolean } | null;
      /** Necromancer's Exhume ultimate just resolved on this commit — same
       *  lifecycle as lastUltimate. `returnedTo` is the tile the occupancy
       *  walk actually landed the dragged token on (server-computed, never
       *  re-derived client-side). */
      lastExhume?: { targetTokenId: number; returnedTo: number } | null;
      /** Soul Harvest paid the VICTIM on this commit: the necromancer's
       *  charge gain from their own tokens being sent home. Deliberately
       *  separate from lastChargeEvent, which carries only ONE player's
       *  delta — a capture against a necromancer changes BOTH banks in a
       *  single commit (the actor's side stays in lastChargeEvent,
       *  unchanged). Computed server-side as a before/after diff of the
       *  victim's bank, same authority rule as lastChargeEvent. */
      lastSoulHarvest?: { player: PlayerId; delta: number } | null;
      wasSkipped: boolean;
      skippedPlayer: PlayerId | null;
      skipReason: "flip-zero" | "no-legal-move" | null;
    }
  | { seq: number; kind: "chat" };

export interface RoomDoc {
  code: string;
  vsCpu: boolean;
  /** CPU strength for vsCpu rooms, fixed at creation (never mid-game — the
   *  trust model forbids a client-steered bot). ADDITIVE: absent (PvP rooms,
   *  and docs persisted before the field existed) reads as "standard",
   *  exactly the pre-difficulty behavior. Not part of freshMatchFields, so
   *  rematches keep the tier by construction. */
  difficulty?: BotDifficulty;
  seats: { p1: string | null; p2: string | null }; // seat tokens ("BOT" for cpu p2)
  started: boolean;
  /** True = private room: joinable by code, never shown in the public
   *  lobby list. (Docs created before this field existed read as false.) */
  unlisted: boolean;
  phase: RoomPhase;
  openingFlips: { p1: number | null; p2: number | null };
  state: GameState;
  currentFlip: number | null;
  turns: number;
  captures: { p1: number; p2: number };
  lastMove: Move | PowerMove | null;
  lastMovePlayer: PlayerId | null;
  wasSkipped: boolean;
  skippedPlayer: PlayerId | null;
  skipReason: "flip-zero" | "no-legal-move" | null;
  /** Optimistic-lock counter for the transports' CAS. The engine never reads
   *  it; adapters bump it on store. */
  version: number;

  // ---- engine timing / event-log fields ---------------------------------
  /** Epoch ms of the last state-advancing commit — every tick() delay is
   *  measured from here. */
  waitingSince: number;
  /** Monotonic event counter; clients poll with `since` against it. */
  seq: number;
  events: RoomEvent[];
  /** Heartbeat: epoch ms of each seat's last authenticated request. */
  seatLastSeen: { p1: number; p2: number };
  chat: ChatMsg[];
  /** MK bot rescue is one-shot per flip (like the old single setTimeout):
   *  set after a null attempt so a later tick doesn't re-roll the decision. */
  rescueAttempted: boolean;

  // ---- Master Killer (null/unused in classic rooms) ---------------------
  variant: Variant;
  mk: WirePowerState | null;
  classesPicked: { p1: boolean; p2: boolean };
  currentPowerMoves: PowerMove[] | null;
  lastPush: { targetTokenId: number } | null;
  lastChargedShot: { targetTokenId: number } | null;
  lastChargeEvent: { player: PlayerId; delta: number } | null;
  /** See RoomEvent's doc: set only on the commit where a Charge executed.
   *  Docs persisted before this field existed read as undefined ≙ null. */
  lastChargeSweep?: { sweptTokenIds: number[] } | null;
  /** Bridges a zero-flip's charge grant (flip commit) to the auto-skip
   *  commit that announces it — two separate commits/events. */
  zeroFlipChargeBefore: number | null;
  lastRainOfArrows: { targetTokenId: number | null } | null;
  lastUltimate: { kind: "blinkStrike" | "warpath"; targetTokenId: number; sweptTokenIds: number[] } | null;
  lastBulwark: { tokenId: number; reinforced?: boolean } | null;
  lastBulwarkBlock: { tokenIds: number[] } | null;
  /** See RoomEvent's doc: set only on the commit where a Re-flip resolved.
   *  Docs persisted before this field existed read as undefined ≙ null. */
  lastReflip?: { player: PlayerId } | null;
  /** See RoomEvent's doc: set only on the commit where a Raise Dead
   *  resolved. Docs persisted before this field existed read as
   *  undefined ≙ null. */
  lastRaise?: { tokenId: number; dark?: boolean } | null;
  /** See RoomEvent's doc: set only on the commit where an Exhume resolved. */
  lastExhume?: { targetTokenId: number; returnedTo: number } | null;
  /** See RoomEvent's doc: set only on the commit where Soul Harvest paid
   *  the victim. */
  lastSoulHarvest?: { player: PlayerId; delta: number } | null;
}

// ============================================================================
// ACTIONS + VIEWS (what transports pass in / hand back)
// ============================================================================

export type RoomActionInput =
  | { op: "pickClass"; class: PlayerClass }
  | { op: "openingFlip" }
  | { op: "chooseMove"; moveIndex: number }
  | {
      op: "usePower";
      action:
        | { kind: "push"; targetTokenId: number }
        | { kind: "chargedShot"; targetTokenId: number }
        | { kind: "reflip" }
        | { kind: "charge"; moveIndex: number }
        | { kind: "blinkStrike"; targetTokenId: number }
        | { kind: "warpath"; targetTokenId: number }
        /** `reinforced` is ADDITIVE: absent/false is the plain 1-charge
         *  Bulwark, unchanged; true spends the full bank on the doubled
         *  cast (see master-killer.ts's BULWARK_REINFORCED_TURNS). */
        | { kind: "bulwark"; tokenId: number; reinforced?: boolean }
        /** `dark` is ADDITIVE, Reinforced Bulwark's shape: absent/false is
         *  the plain 1-charge Raise to RAISE_POSITION; true spends the
         *  full bank on Dark Resurrection (see master-killer.ts's
         *  DARK_RESURRECTION_POSITION). */
        | { kind: "raiseDead"; tokenId: number; dark?: boolean }
        | { kind: "exhume"; targetTokenId: number };
    }
  | { op: "newMatch" }
  | { op: "chat"; text: string };

export interface ApplyResult {
  doc: RoomDoc;
  /** Set when the action was rejected; doc is unchanged in that case. */
  error?: string;
}

/** The per-seat poll view. Events are the replayable history; everything
 *  else is the CURRENT overlay (interactive, seat-gated where noted). */
export interface RoomView {
  latestSeq: number;
  /** True when the client's `since` predates the retained event window —
   *  snap to the snapshot fields below instead of replaying `events`. */
  resync: boolean;
  events: RoomEvent[];
  // ---- current snapshot / overlay ----
  started: boolean;
  phase: RoomPhase;
  vsCpu: boolean;
  /** CPU strength for vsCpu rooms, null in PvP. ADDITIVE: rides the view on
   *  join AND on every poll (so a resumed/reloaded client recovers the tier
   *  without any separate handshake). */
  difficulty?: BotDifficulty | null;
  variant: Variant;
  state: GameState;
  flip: number | null;
  openingFlips: { p1: number | null; p2: number | null };
  classPick: { classes: { p1: PlayerClass | null; p2: PlayerClass | null }; ready: boolean } | null;
  power: PublicPower | null;
  yourTurn: boolean;
  /** Seat-gated: only the current player sees their options. */
  legalMoves: Move[] | null;
  powerMoves: PowerMove[] | null;
  gameOver: { winner: PlayerId; stats: { turns: number; captures: { p1: number; p2: number } } } | null;
  opponentAway: boolean;
  opponentLeft: boolean;
  chat: ChatMsg[];
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function sanitizeChat(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, CHAT_TEXT_MAX);
}

function otherSeat(seat: PlayerId): PlayerId {
  return seat === "p1" ? "p2" : "p1";
}

/** The public MK block both seats may see (target lists are computed for the
 *  CURRENT player only — they're empty/meaningless for the other seat). */
export function publicPower(doc: RoomDoc): PublicPower | null {
  if (!doc.mk) return null;
  const mover = doc.state.currentPlayer;
  const p = fromWirePower(doc.mk);
  return {
    classes: { ...doc.mk.classes },
    charges: { ...doc.mk.charges },
    pushTargets: doc.mk.classes[mover] === "archer" ? getPushTargets(doc.state, p, mover) : [],
    chargedShotTargets: doc.mk.classes[mover] === "archer" ? getChargedShotTargets(doc.state, p, mover) : [],
    ultimateReady: { ...doc.mk.ultimateReady },
    blinkStrikeTargets:
      doc.mk.classes[mover] === "mage" && doc.mk.ultimateReady[mover]
        ? getBlinkStrikeTargets(doc.state, p, mover)
        : [],
    warpathTargets:
      doc.mk.classes[mover] === "warrior" && doc.mk.ultimateReady[mover]
        ? getWarpathTargets(doc.state, p, mover)
        : [],
    bulwarkTargets:
      doc.mk.classes[mover] === "warrior" && doc.mk.charges[mover] >= 1
        ? getBulwarkTargets(doc.state, p, mover)
        : [],
    bulwarkedTokenIds: Object.keys(doc.mk.bulwarked).map(Number),
    raiseTargets:
      doc.mk.classes[mover] === "necromancer" && doc.mk.charges[mover] >= 1
        ? getRaiseTargets(doc.state, p, mover)
        : [],
    // Same >= 1 gate as raiseTargets (not the full-bank one) so the two
    // lists appear together and the client can tell "reserve is empty"
    // from "destination blocked"; affordability stays the gem's own gate.
    darkRaiseTargets:
      doc.mk.classes[mover] === "necromancer" && doc.mk.charges[mover] >= 1
        ? getRaiseTargets(doc.state, p, mover, true)
        : [],
    exhumeTargets:
      doc.mk.classes[mover] === "necromancer" && doc.mk.ultimateReady[mover]
        ? getExhumeTargets(doc.state, p, mover)
        : [],
    reflipsUsedThisTurn: p.reflipsUsedThisTurn,
  };
}

/** RoomEvent minus seq, distributed over the union (Omit alone collapses
 *  a discriminated union to its common keys). */
type UnseqEvent<T = RoomEvent> = T extends RoomEvent ? Omit<T, "seq"> : never;

/** Append an event (seq assigned here) and trim the window. */
function pushEvent(doc: RoomDoc, ev: UnseqEvent): RoomDoc {
  const seq = doc.seq + 1;
  const events = [...doc.events, { ...ev, seq } as RoomEvent];
  return { ...doc, seq, events: events.slice(-EVENT_WINDOW) };
}

function classPickEventOf(doc: RoomDoc): UnseqEvent {
  return {
    kind: "classPick",
    classes: {
      p1: doc.classesPicked.p1 && doc.mk ? doc.mk.classes.p1 : null,
      p2: doc.classesPicked.p2 && doc.mk ? doc.mk.classes.p2 : null,
    },
    ready: doc.classesPicked.p1 && (doc.classesPicked.p2 || doc.vsCpu),
  };
}

function openingEventOf(doc: RoomDoc, first: PlayerId | null): UnseqEvent {
  const { p1, p2 } = doc.openingFlips;
  return {
    kind: "opening",
    flips: { ...doc.openingFlips },
    first,
    tie: first === null && p1 !== null && p2 !== null && p1 === p2,
  };
}

/** Snapshot the doc's current announcement fields as a replayable frame. */
function stateEventOf(doc: RoomDoc): UnseqEvent {
  return {
    kind: "state",
    state: doc.state,
    flip: doc.currentFlip,
    power: publicPower(doc) ?? undefined,
    lastMove: doc.lastMove,
    lastMovePlayer: doc.lastMovePlayer,
    lastPush: doc.lastPush,
    lastChargedShot: doc.lastChargedShot,
    lastBulwark: doc.lastBulwark,
    lastBulwarkBlock: doc.lastBulwarkBlock,
    lastChargeEvent: doc.lastChargeEvent,
    lastRainOfArrows: doc.lastRainOfArrows,
    lastUltimate: doc.lastUltimate,
    lastChargeSweep: doc.lastChargeSweep ?? null,
    lastReflip: doc.lastReflip ?? null,
    lastRaise: doc.lastRaise ?? null,
    lastExhume: doc.lastExhume ?? null,
    lastSoulHarvest: doc.lastSoulHarvest ?? null,
    wasSkipped: doc.wasSkipped,
    skippedPlayer: doc.skippedPlayer,
    skipReason: doc.skipReason,
  };
}

/** Every state-advancing commit funnels through here: stamp the deadline
 *  clock, reset the one-shot rescue latch, append the frame. */
function commitFrame(doc: RoomDoc, now: number, ev: UnseqEvent): RoomDoc {
  return pushEvent({ ...doc, waitingSince: now, rescueAttempted: false }, ev);
}

// ============================================================================
// FRESH DOCS
// ============================================================================

export function freshMatchFields(
  variant: Variant,
): Pick<
  RoomDoc,
  | "phase" | "openingFlips" | "state" | "currentFlip" | "turns" | "captures"
  | "lastMove" | "lastMovePlayer" | "wasSkipped" | "skippedPlayer" | "skipReason"
  | "mk" | "classesPicked" | "currentPowerMoves" | "lastPush" | "lastChargedShot" | "lastChargeEvent"
  | "zeroFlipChargeBefore" | "lastRainOfArrows" | "lastUltimate" | "lastBulwark" | "lastBulwarkBlock"
  | "lastReflip" | "lastRaise" | "lastExhume" | "lastSoulHarvest" | "rescueAttempted"
> {
  return {
    phase: variant === "masterKiller" ? "classPick" : "opening",
    openingFlips: { p1: null, p2: null },
    state: initialState(),
    currentFlip: null,
    turns: 0,
    captures: { p1: 0, p2: 0 },
    lastMove: null,
    lastMovePlayer: null,
    wasSkipped: false,
    skippedPlayer: null,
    skipReason: null,
    mk: variant === "masterKiller" ? toWirePower(initialPowerState()) : null,
    classesPicked: { p1: false, p2: false },
    currentPowerMoves: null,
    lastPush: null,
    lastChargedShot: null,
    lastChargeEvent: null,
    zeroFlipChargeBefore: null,
    lastRainOfArrows: null,
    lastUltimate: null,
    lastBulwark: null,
    lastBulwarkBlock: null,
    lastReflip: null,
    lastRaise: null,
    lastExhume: null,
    lastSoulHarvest: null,
    rescueAttempted: false,
  };
}

export function createRoomDoc(
  code: string,
  vsCpu: boolean,
  variant: Variant,
  p1Token: string,
  now: number,
  unlisted = false,
  difficulty: BotDifficulty = "standard",
): RoomDoc {
  const doc: RoomDoc = {
    code,
    vsCpu,
    // Set only for CPU rooms — PvP docs stay byte-identical (no key at all).
    ...(vsCpu ? { difficulty } : {}),
    seats: { p1: p1Token, p2: vsCpu ? "BOT" : null },
    started: vsCpu, // cpu rooms are "full" with one human
    unlisted,
    version: 1,
    variant,
    waitingSince: now,
    seq: 0,
    events: [],
    seatLastSeen: { p1: now, p2: now },
    chat: [],
    ...freshMatchFields(variant),
  };
  if (!doc.started) return doc;
  // Room starts immediately (cpu): emit the opening frame for the phase.
  return doc.phase === "classPick"
    ? pushEvent(doc, classPickEventOf(doc))
    : pushEvent(doc, openingEventOf(doc, null));
}

/** The p2 seat just filled (PvP join): mark started and emit the first frame. */
export function startRoom(doc: RoomDoc, now: number): RoomDoc {
  const started: RoomDoc = { ...doc, started: true, waitingSince: now };
  return started.phase === "classPick"
    ? pushEvent(started, classPickEventOf(started))
    : pushEvent(started, openingEventOf(started, null));
}

// ============================================================================
// APPLY ACTION — a seated player did something.
// ============================================================================

export function applyAction(
  doc: RoomDoc,
  seat: PlayerId,
  action: RoomActionInput,
  now: number,
  rand: () => number = Math.random,
): ApplyResult {
  switch (action.op) {
    case "chat": {
      const text = sanitizeChat(action.text);
      if (!text) return { doc };
      const chat = [...doc.chat, { seat, text }].slice(-CHAT_MAX);
      // A chat frame is a wake-up marker for long-polls; it does NOT touch
      // waitingSince (chatting must not delay a pending auto-skip/bot move).
      return { doc: pushEvent({ ...doc, chat }, { kind: "chat" }) };
    }

    case "pickClass": {
      if (doc.phase !== "classPick" || !doc.mk) return { doc, error: "Not in class pick" };
      if (doc.classesPicked[seat]) return { doc, error: "Already picked" };
      let next: RoomDoc = {
        ...doc,
        mk: { ...doc.mk, classes: { ...doc.mk.classes, [seat]: action.class } },
        classesPicked: { ...doc.classesPicked, [seat]: true },
      };
      next = commitFrame(next, now, classPickEventOf(next));
      return { doc: maybeResolveClassPick(next, now) };
    }

    case "openingFlip": {
      if (doc.phase !== "opening") return { doc, error: "Not in the flip-off" };
      if (doc.openingFlips[seat] !== null) return { doc, error: "Already flipped" };
      let next: RoomDoc = {
        ...doc,
        openingFlips: { ...doc.openingFlips, [seat]: flipCoins(rand) },
      };
      next = commitFrame(next, now, openingEventOf(next, null));
      return { doc: maybeResolveOpening(next, now) };
    }

    case "chooseMove": {
      if (doc.state.winner) return { doc, error: "Game is over" };
      if (doc.phase !== "play" || doc.state.currentPlayer !== seat) return { doc, error: "Not your turn" };
      if (doc.currentFlip === null) return { doc, error: "No flip yet" };
      if (doc.variant === "masterKiller") {
        if (!doc.mk || !doc.currentPowerMoves) return { doc, error: "No moves" };
        if (action.moveIndex < 0 || action.moveIndex >= doc.currentPowerMoves.length) {
          return { doc, error: "Invalid move index" };
        }
        return { doc: applyMkMove(doc, seat, doc.currentPowerMoves[action.moveIndex], now, rand) };
      }
      const moves = getLegalMoves(doc.state, doc.currentFlip);
      if (action.moveIndex < 0 || action.moveIndex >= moves.length) return { doc, error: "Invalid move index" };
      const move = moves[action.moveIndex];
      let next: RoomDoc = {
        ...doc,
        state: applyMove(doc.state, move),
        currentFlip: null,
        captures: { ...doc.captures, [seat]: doc.captures[seat] + move.captures.length },
        lastMove: move,
        lastMovePlayer: seat,
        wasSkipped: false,
        skippedPlayer: null,
        skipReason: null,
      };
      next = commitFrame(next, now, stateEventOf(next));
      return { doc: next };
    }

    case "usePower": {
      const err = validateUsePower(doc, seat, action.action);
      if (err) return { doc, error: err };
      const a = action.action;
      if (a.kind === "reflip") return { doc: applyMkReflip(doc, seat, now, rand) };
      if (a.kind === "push") return { doc: applyMkSimple(doc, seat, "push", a.targetTokenId, now) };
      if (a.kind === "chargedShot") return { doc: applyMkSimple(doc, seat, "chargedShot", a.targetTokenId, now) };
      if (a.kind === "blinkStrike") return { doc: applyMkSimple(doc, seat, "blinkStrike", a.targetTokenId, now) };
      if (a.kind === "warpath") return { doc: applyMkSimple(doc, seat, "warpath", a.targetTokenId, now) };
      // `=== true` (not truthiness): these client-supplied flags are echoed
      // into the persisted doc (lastBulwark/lastRaise) and broadcast, and
      // the body arrives as unvalidated JSON — a truthy garbage value must
      // neither ride into the doc verbatim nor diverge from what
      // validateUsePower gated on (which coerces identically).
      if (a.kind === "bulwark") return { doc: applyMkSimple(doc, seat, "bulwark", a.tokenId, now, a.reinforced === true) };
      if (a.kind === "raiseDead") return { doc: applyMkRaise(doc, seat, a.tokenId, a.dark === true, now) };
      if (a.kind === "exhume") return { doc: applyMkSimple(doc, seat, "exhume", a.targetTokenId, now) };
      // charge
      const move = doc.currentPowerMoves![a.moveIndex];
      return { doc: applyMkCharge(doc, seat, move, now, rand) };
    }

    case "newMatch": {
      if (doc.state.winner === null) return { doc, error: "Current match hasn't ended" };
      let next: RoomDoc = { ...doc, ...freshMatchFields(doc.variant), waitingSince: now, rescueAttempted: false };
      next =
        next.phase === "classPick"
          ? pushEvent(next, classPickEventOf(next))
          : pushEvent(next, openingEventOf(next, null));
      return { doc: next };
    }
  }
}

function validateUsePower(
  doc: RoomDoc,
  seat: PlayerId,
  a: Extract<RoomActionInput, { op: "usePower" }>["action"],
): string | null {
  if (doc.variant !== "masterKiller" || !doc.mk) return "Not a Master Killer room";
  if (doc.state.winner !== null) return "Game is over";
  if (doc.phase !== "play" || doc.state.currentPlayer !== seat) return "Not your turn";
  const cls = doc.mk.classes[seat];
  const p = () => fromWirePower(doc.mk!);
  switch (a.kind) {
    case "reflip":
      if (cls !== "mage") return "Only a Mage can Re-flip";
      if (doc.mk.charges[seat] < 1) return "No charge available";
      if (!canReflipAgain(p(), seat)) return "No re-flips left this turn";
      return null;
    case "push":
      if (cls !== "archer") return "Only an Archer can Push";
      if (doc.mk.charges[seat] < 1) return "No charge available";
      if (!getPushTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid push target";
      return null;
    case "chargedShot":
      if (cls !== "archer") return "Only an Archer can Charged Shot";
      if (doc.mk.charges[seat] !== CHARGE_CAP) return "Charged Shot needs a full charge bank";
      if (!getChargedShotTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Charged Shot target";
      return null;
    case "blinkStrike":
      if (cls !== "mage") return "Only a Mage can Blink Strike";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (!getBlinkStrikeTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Blink Strike target";
      return null;
    case "warpath":
      if (cls !== "warrior") return "Only a Warrior can Warpath";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (!getWarpathTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Warpath target";
      return null;
    case "bulwark":
      if (cls !== "warrior") return "Only a Warrior can Bulwark";
      // `=== true`, matching the dispatch's coercion — a truthy non-boolean
      // must gate the same variant here that actually gets applied.
      if (a.reinforced === true) {
        // Mirrors Charged Shot's own full-bank gate: the reinforced cast is
        // a uniform "has the mover banked the whole cap" check, identical
        // for every target.
        if (doc.mk.charges[seat] !== CHARGE_CAP) return "Reinforced Bulwark needs a full charge bank";
      } else if (doc.mk.charges[seat] < 1) {
        return "No charge available";
      }
      if (!getBulwarkTargets(doc.state, p(), seat).includes(a.tokenId)) return "Invalid Bulwark target";
      return null;
    case "raiseDead":
      if (cls !== "necromancer") return "Only a Necromancer can Raise Dead";
      // `=== true`, matching the dispatch's coercion — a truthy non-boolean
      // must gate the same variant (cost AND destination) that gets applied.
      if (a.dark === true) {
        // Same full-bank gate as Reinforced Bulwark's: Dark Resurrection is
        // a uniform "has the mover banked the whole cap" check, identical
        // for every target.
        if (doc.mk.charges[seat] !== CHARGE_CAP) return "Dark Resurrection needs a full charge bank";
      } else if (doc.mk.charges[seat] < 1) {
        return "No charge available";
      }
      // Raise keeps the SAME flip alive (see applyMkRaise) — there has to
      // be one to keep, same guard as chooseMove's.
      if (doc.currentFlip === null) return "No flip yet";
      if (!getRaiseTargets(doc.state, p(), seat, a.dark === true).includes(a.tokenId))
        return "Invalid Raise Dead target";
      return null;
    case "exhume":
      if (cls !== "necromancer") return "Only a Necromancer can Exhume";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (!getExhumeTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Exhume target";
      return null;
    case "charge":
      if (cls !== "warrior") return "Only a Warrior can Charge";
      if (doc.mk.charges[seat] < 1) return "No charge available";
      if (!doc.currentPowerMoves || a.moveIndex < 0 || a.moveIndex >= doc.currentPowerMoves.length)
        return "Invalid move index";
      if (!doc.currentPowerMoves[a.moveIndex].chargeAvailable) return "Charge not available for that move";
      return null;
  }
}

// ---- Master Killer turn-ending commits (mirrors api/ws.ts one-for-one) ----

/** Shared post-shape for every announcement-slot reset. */
const CLEAR_SLOTS = {
  lastMove: null,
  lastPush: null,
  lastChargedShot: null,
  lastBulwark: null,
  lastBulwarkBlock: null,
  lastChargeEvent: null,
  lastRainOfArrows: null,
  lastUltimate: null,
  lastChargeSweep: null,
  lastReflip: null,
  lastRaise: null,
  lastExhume: null,
  lastSoulHarvest: null,
  wasSkipped: false,
  skippedPlayer: null,
  skipReason: null,
} as const;

function applyMkMove(doc: RoomDoc, seat: PlayerId, move: PowerMove, now: number, rand: () => number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const foe = otherSeat(seat);
  const foeChargesBefore = doc.mk!.charges[foe];
  const r = applyPowerMove(doc.state, fromWirePower(doc.mk!), move, seat, rand);
  const delta = r.power.charges[seat] - chargesBefore;
  // Soul Harvest pays the VICTIM's side of the table: lastChargeEvent only
  // carries the actor's delta, so the foe's gain gets its own authoritative
  // before/after diff — non-null only when a necromancer just had tokens
  // sent home (nothing else touches the non-mover's bank mid-commit).
  const foeDelta = r.power.charges[foe] - foeChargesBefore;
  const rainHit = r.rainOfArrows?.targetTokenId != null ? 1 : 0;
  const caps = move.captures.length + move.bonusCaptures.length + rainHit;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: { ...doc.captures, [seat]: doc.captures[seat] + caps },
    lastMove: move,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastSoulHarvest: foeDelta !== 0 ? { player: foe, delta: foeDelta } : null,
    lastRainOfArrows: r.rainOfArrows,
  };
  return commitFrame(next, now, stateEventOf(next));
}

function applyMkCharge(doc: RoomDoc, seat: PlayerId, move: PowerMove, now: number, rand: () => number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const foe = otherSeat(seat);
  const foeChargesBefore = doc.mk!.charges[foe];
  const r = mkApplyCharge(doc.state, fromWirePower(doc.mk!), move, seat, rand);
  const delta = r.power.charges[seat] - chargesBefore;
  // Same foe-side Soul Harvest diff as applyMkMove's — see the note there.
  const foeDelta = r.power.charges[foe] - foeChargesBefore;
  const rainHit = r.rainOfArrows?.targetTokenId != null ? 1 : 0;
  const caps = move.captures.length + move.bonusCaptures.length + move.chargeSweepCaptures.length + rainHit;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: { ...doc.captures, [seat]: doc.captures[seat] + caps },
    lastMove: move,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastSoulHarvest: foeDelta !== 0 ? { player: foe, delta: foeDelta } : null,
    lastRainOfArrows: r.rainOfArrows,
    lastChargeSweep: { sweptTokenIds: move.chargeSweepCaptures },
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Push / Charged Shot / Blink Strike / Warpath / Bulwark / Exhume share
 *  one commit shape and differ only in which apply-fn runs and which slot
 *  announces. `reinforced` only means anything for kind "bulwark" (the
 *  full-bank cast). */
function applyMkSimple(
  doc: RoomDoc,
  seat: PlayerId,
  kind: "push" | "chargedShot" | "blinkStrike" | "warpath" | "bulwark" | "exhume",
  tokenId: number,
  now: number,
  reinforced = false,
): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const foe = otherSeat(seat);
  const foeChargesBefore = doc.mk!.charges[foe];
  const power = fromWirePower(doc.mk!);
  let r: { state: GameState; power: PowerState; sweptTokenIds?: number[] };
  let slots: Partial<RoomDoc> = {};
  let capsGained = 0;
  switch (kind) {
    case "push":
      r = mkApplyPush(doc.state, power, tokenId, seat);
      slots = { lastPush: { targetTokenId: tokenId } };
      break;
    case "chargedShot":
      r = mkApplyChargedShot(doc.state, power, tokenId, seat);
      slots = { lastChargedShot: { targetTokenId: tokenId } };
      break;
    case "blinkStrike": {
      const rr = applyBlinkStrike(doc.state, power, tokenId, seat);
      r = rr;
      capsGained = 1 + rr.sweptTokenIds.length;
      slots = { lastUltimate: { kind: "blinkStrike", targetTokenId: tokenId, sweptTokenIds: rr.sweptTokenIds } };
      break;
    }
    case "warpath": {
      const rr = applyWarpath(doc.state, power, tokenId, seat);
      r = rr;
      capsGained = 1 + rr.sweptTokenIds.length;
      slots = { lastUltimate: { kind: "warpath", targetTokenId: tokenId, sweptTokenIds: rr.sweptTokenIds } };
      break;
    }
    case "bulwark":
      r = applyBulwark(doc.state, power, tokenId, seat, reinforced);
      slots = { lastBulwark: { tokenId, reinforced } };
      break;
    case "exhume": {
      const rr = applyExhume(doc.state, power, tokenId, seat);
      r = rr;
      // No capsGained: Exhume is a return, not a capture (see its doc).
      slots = { lastExhume: { targetTokenId: tokenId, returnedTo: rr.returnedTo } };
      break;
    }
  }
  const delta = r.power.charges[seat] - chargesBefore;
  // Same foe-side Soul Harvest diff as applyMkMove's — see the note there.
  // Live for push/chargedShot/blinkStrike/warpath sends-home; always 0 for
  // bulwark and exhume, which capture nothing.
  const foeDelta = r.power.charges[foe] - foeChargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    ...slots,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: capsGained ? { ...doc.captures, [seat]: doc.captures[seat] + capsGained } : doc.captures,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastSoulHarvest: foeDelta !== 0 ? { player: foe, delta: foeDelta } : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Re-flip does NOT end the turn: it replaces the flip in place. The commit
 *  resets waitingSince, so a pending auto-skip deadline restarts against the
 *  fresh flip by construction. */
function applyMkReflip(doc: RoomDoc, seat: PlayerId, now: number, rand: () => number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  let power = mkApplyReflip(fromWirePower(doc.mk!), seat);
  const flip = flipCoins(rand);
  if (flip === 0) power = grantZeroFlipCharge(power, seat);
  // Move list FIRST, consumption second — a Bulwark that blocks eats the
  // threat for this flip, so the just-blocked capture must NOT appear in
  // the served list. Same ordering as commitTurnFlip and both sim
  // harnesses (and tickBulwarkForNewTurn's own "call right after computing
  // this turn's real move/target lists" contract).
  const currentPowerMoves = getLegalPowerMoves(doc.state, power, flip);
  const bulwarkResult = tickBulwarkForReflip(doc.state, power, flip);
  power = bulwarkResult.power;
  const delta = power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    mk: toWirePower(power),
    currentFlip: flip,
    currentPowerMoves,
    lastMovePlayer: doc.lastMovePlayer,
    lastBulwarkBlock: bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastReflip: { player: seat },
    // A re-rolled zero still ends in the auto-skip path, which announces the
    // NET delta computed here — don't re-derive from zeroFlipChargeBefore.
    zeroFlipChargeBefore: null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Raise Dead does NOT end the turn: the raised token joins the board and
 *  the SAME flip re-resolves against it — Re-flip's contract, minus the
 *  re-roll (see applyRaiseDead's doc in master-killer.ts). The commit
 *  resets waitingSince, so a pending auto-skip deadline restarts against
 *  the recomputed move list by construction. */
function applyMkRaise(doc: RoomDoc, seat: PlayerId, tokenId: number, dark: boolean, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const flip = doc.currentFlip!; // validated non-null (see validateUsePower)
  const raised = applyRaiseDead(doc.state, fromWirePower(doc.mk!), tokenId, seat, dark);
  // Move list FIRST (against the post-raise board), THEN the same-turn
  // Bulwark re-check, exactly the Re-flip path's: the raised token can
  // reveal capture threats the pre-raise board didn't have (no expiry
  // tick — it's still the same turn), and a Bulwark that blocks one eats
  // that threat for this flip, so the served list must come from the
  // pre-consumption power — commitTurnFlip's and both sims' ordering.
  const currentPowerMoves = getLegalPowerMoves(raised.state, raised.power, flip);
  const bulwarkResult = tickBulwarkForReflip(raised.state, raised.power, flip);
  const power = bulwarkResult.power;
  const delta = power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: raised.state,
    mk: toWirePower(power),
    currentFlip: flip,
    currentPowerMoves,
    lastMovePlayer: doc.lastMovePlayer,
    lastBulwarkBlock: bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastRaise: { tokenId, dark },
    // A raise during a zero flip spends AFTER the flip commit banked the
    // grant's baseline: shift the baseline down by the same spend so the
    // auto-skip commit still announces exactly the grant (see the flip-zero
    // branch in tickOnce), not grant-minus-spend.
    zeroFlipChargeBefore:
      doc.zeroFlipChargeBefore !== null ? doc.zeroFlipChargeBefore - (dark ? CHARGE_CAP : 1) : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

// ============================================================================
// PHASE RESOLUTION (delay-0 transitions, chained from actions and ticks)
// ============================================================================

function maybeResolveClassPick(doc: RoomDoc, now: number): RoomDoc {
  if (doc.phase !== "classPick" || !doc.mk) return doc;
  if (!doc.classesPicked.p1 || (!doc.classesPicked.p2 && !doc.vsCpu)) return doc;
  let next: RoomDoc = { ...doc, phase: "opening" };
  return commitFrame(next, now, openingEventOf(next, null));
}

function maybeResolveOpening(doc: RoomDoc, now: number): RoomDoc {
  if (doc.phase !== "opening") return doc;
  const { p1, p2 } = doc.openingFlips;
  if (p1 === null || p2 === null || p1 === p2) return doc; // tie waits on tick's reset
  const first: PlayerId = p1 > p2 ? "p1" : "p2";
  let next: RoomDoc = {
    ...doc,
    phase: "play",
    state: { ...doc.state, currentPlayer: first },
  };
  // The reveal frame ("X goes first") — the flip commit follows on tick
  // after FIRST_TURN_REVEAL_MS.
  return commitFrame(next, now, openingEventOf(next, first));
}

// ============================================================================
// TICK — fire any DUE deadline. Loops so overdue chains catch up in one call
// (e.g. a resumed room: flip → bot move → next flip).
// ============================================================================

function autoSkipDelay(doc: RoomDoc): number {
  const mover = doc.state.currentPlayer;
  const isBot = doc.vsCpu && mover === "p2";
  if (isBot) return AUTO_SKIP_DELAY_MS;
  if (doc.variant === "masterKiller" && doc.mk) {
    const p = fromWirePower(doc.mk);
    if (doc.mk.classes[mover] === "mage" && canReflipAgain(p, mover)) {
      return AUTO_SKIP_WITH_RESCUE_MS; // human Mage gets a real Re-flip window
    }
    // The Necromancer has the SAME dead-flip rescue as the Mage: Raise Dead
    // keeps the flip and recomputes the move list against the raised board
    // (the risen stone may be the one that moves) — so a human with a
    // castable raise gets the same window. Flip-zero stays a snappy skip:
    // no raise can conjure a legal move out of a zero.
    if (
      doc.mk.classes[mover] === "necromancer" &&
      doc.currentFlip !== null &&
      doc.currentFlip !== 0 &&
      ((doc.mk.charges[mover] >= 1 && getRaiseTargets(doc.state, p, mover).length > 0) ||
        (doc.mk.charges[mover] === CHARGE_CAP && getRaiseTargets(doc.state, p, mover, true).length > 0))
    ) {
      return AUTO_SKIP_WITH_RESCUE_MS;
    }
  }
  return AUTO_SKIP_DELAY_MS;
}

/** One tick pass. Returns the (possibly unchanged) doc. */
function tickOnce(doc: RoomDoc, now: number, rand: () => number): RoomDoc {
  if (!doc.started) return doc;
  const elapsed = now - doc.waitingSince;

  if (doc.phase === "classPick") {
    if (doc.vsCpu && !doc.classesPicked.p2 && doc.mk && elapsed >= BOT_THINK_MS) {
      const cls = MK_CLASSES[Math.floor(rand() * MK_CLASSES.length)];
      let next: RoomDoc = {
        ...doc,
        mk: { ...doc.mk, classes: { ...doc.mk.classes, p2: cls } },
        classesPicked: { ...doc.classesPicked, p2: true },
      };
      next = commitFrame(next, now, classPickEventOf(next));
      return maybeResolveClassPick(next, now);
    }
    return maybeResolveClassPick(doc, now);
  }

  if (doc.phase === "opening") {
    const { p1, p2 } = doc.openingFlips;
    if (doc.vsCpu && p2 === null && elapsed >= BOT_THINK_MS) {
      let next: RoomDoc = { ...doc, openingFlips: { ...doc.openingFlips, p2: flipCoins(rand) } };
      next = commitFrame(next, now, openingEventOf(next, null));
      return maybeResolveOpening(next, now);
    }
    if (p1 !== null && p2 !== null && p1 === p2 && elapsed >= OPENING_TIE_RESET_MS) {
      let next: RoomDoc = { ...doc, openingFlips: { p1: null, p2: null } };
      return commitFrame(next, now, openingEventOf(next, null));
    }
    return maybeResolveOpening(doc, now);
  }

  // ---- play ----
  if (doc.state.winner) return doc;

  if (doc.currentFlip === null) {
    const delay = doc.turns === 0 ? FIRST_TURN_REVEAL_MS : 0;
    if (elapsed < delay) return doc;
    return commitTurnFlip(doc, now, rand);
  }
  // Captured before the rescue latch reassigns `doc` (which would defeat
  // TS's null-narrowing on the field).
  const flip = doc.currentFlip;

  const moves = doc.variant === "masterKiller" ? (doc.currentPowerMoves ?? []) : getLegalMoves(doc.state, flip);
  const isBotTurn = doc.vsCpu && doc.state.currentPlayer === "p2";

  // MK bot zero-move rescue: one shot, before the auto-skip becomes due.
  if (
    isBotTurn &&
    doc.variant === "masterKiller" &&
    doc.mk &&
    moves.length === 0 &&
    !doc.rescueAttempted &&
    elapsed >= BOT_RESCUE_THINK_MS
  ) {
    const power = fromWirePower(doc.mk);
    const action = pickBotPowerAction(
      doc.state,
      power,
      doc.currentPowerMoves ?? [],
      flip,
      rand,
      doc.difficulty ?? "standard",
    );
    if (action) return applyBotAction(doc, "p2", action, now, rand);
    // Latch the null attempt WITHOUT resetting the skip clock or emitting a
    // frame — the auto-skip below stays on schedule.
    doc = { ...doc, rescueAttempted: true };
  }

  if (moves.length === 0 && elapsed >= autoSkipDelay(doc)) {
    const skipped = doc.state.currentPlayer;
    const skipReason = doc.currentFlip === 0 ? ("flip-zero" as const) : ("no-legal-move" as const);
    let lastChargeEvent: RoomDoc["lastChargeEvent"] = null;
    if (skipReason === "flip-zero" && doc.mk && doc.zeroFlipChargeBefore !== null) {
      const delta = doc.mk.charges[skipped] - doc.zeroFlipChargeBefore;
      lastChargeEvent = delta !== 0 ? { player: skipped, delta } : null;
    }
    const mk = doc.mk ? toWirePower(breakShieldStreak(fromWirePower(doc.mk), skipped)) : doc.mk;
    let next: RoomDoc = {
      ...doc,
      ...CLEAR_SLOTS,
      state: applyNoMove(doc.state),
      mk,
      currentFlip: null,
      currentPowerMoves: null,
      wasSkipped: true,
      skippedPlayer: skipped,
      skipReason,
      lastChargeEvent,
      lastMovePlayer: doc.lastMovePlayer,
      zeroFlipChargeBefore: null,
    };
    return commitFrame(next, now, stateEventOf(next));
  }

  if (isBotTurn && moves.length > 0 && elapsed >= BOT_THINK_MS) {
    if (doc.variant === "masterKiller" && doc.mk) {
      const power = fromWirePower(doc.mk);
      const action = pickBotPowerAction(
        doc.state,
        power,
        doc.currentPowerMoves ?? [],
        flip,
        rand,
        doc.difficulty ?? "standard",
      );
      if (action) return applyBotAction(doc, "p2", action, now, rand);
      return doc;
    }
    const botMoves = getLegalMoves(doc.state, flip);
    if (botMoves.length === 0) return doc;
    const idx = pickBotMove(doc.state, botMoves, rand, doc.difficulty ?? "standard");
    const move = botMoves[idx];
    let next: RoomDoc = {
      ...doc,
      state: applyMove(doc.state, move),
      currentFlip: null,
      captures: { ...doc.captures, p2: doc.captures.p2 + move.captures.length },
      lastMove: move,
      lastMovePlayer: "p2" as PlayerId,
      wasSkipped: false,
      skippedPlayer: null,
      skipReason: null,
    };
    return commitFrame(next, now, stateEventOf(next));
  }

  return doc;
}

function applyBotAction(doc: RoomDoc, seat: PlayerId, action: PowerAction, now: number, rand: () => number): RoomDoc {
  switch (action.kind) {
    case "move":
      return applyMkMove(doc, seat, action.move, now, rand);
    case "charge":
      return applyMkCharge(doc, seat, action.move, now, rand);
    case "push":
      return applyMkSimple(doc, seat, "push", action.targetTokenId, now);
    case "chargedShot":
      return applyMkSimple(doc, seat, "chargedShot", action.targetTokenId, now);
    case "reflip":
      return applyMkReflip(doc, seat, now, rand);
    case "blinkStrike":
      return applyMkSimple(doc, seat, "blinkStrike", action.targetTokenId, now);
    case "warpath":
      return applyMkSimple(doc, seat, "warpath", action.targetTokenId, now);
    case "bulwark":
      return applyMkSimple(doc, seat, "bulwark", action.tokenId, now, action.reinforced ?? false);
    case "raiseDead":
      return applyMkRaise(doc, seat, action.tokenId, action.dark ?? false, now);
    case "exhume":
      return applyMkSimple(doc, seat, "exhume", action.targetTokenId, now);
  }
}

/** Start a turn: flip the coins, deal the zero-flip charge, tick Bulwark. */
function commitTurnFlip(doc: RoomDoc, now: number, rand: () => number): RoomDoc {
  const flip = flipCoins(rand);
  let mk = doc.mk;
  let currentPowerMoves: PowerMove[] | null = null;
  let zeroFlipChargeBefore: number | null = null;
  let lastBulwarkBlock: RoomDoc["lastBulwarkBlock"] = null;
  if (doc.variant === "masterKiller" && mk) {
    let power = fromWirePower(mk);
    if (flip === 0) {
      zeroFlipChargeBefore = power.charges[doc.state.currentPlayer];
      power = grantZeroFlipCharge(power, doc.state.currentPlayer);
    }
    currentPowerMoves = getLegalPowerMoves(doc.state, power, flip);
    const bulwarkResult = tickBulwarkForNewTurn(doc.state, power, flip);
    power = bulwarkResult.power;
    if (bulwarkResult.blockedIds.length > 0) lastBulwarkBlock = { tokenIds: bulwarkResult.blockedIds };
    mk = toWirePower(power);
  }
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    currentFlip: flip,
    mk,
    currentPowerMoves,
    turns: doc.turns + 1,
    lastBulwarkBlock,
    zeroFlipChargeBefore,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Public tick: loop tickOnce until nothing more is due (bounded). */
export function tick(doc: RoomDoc, now: number, rand: () => number = Math.random): RoomDoc {
  for (let i = 0; i < 12; i++) {
    const next = tickOnce(doc, now, rand);
    if (next === doc) return doc;
    doc = next;
  }
  return doc;
}

// ============================================================================
// VIEW — the per-seat poll response.
// ============================================================================

export function viewFor(doc: RoomDoc, seat: PlayerId, since: number, now: number): RoomView {
  const oldest = doc.events.length > 0 ? doc.events[0].seq : doc.seq + 1;
  const resync = since < oldest - 1;
  const yourTurn = doc.phase === "play" && doc.state.winner === null && doc.state.currentPlayer === seat;
  const legalMoves =
    doc.variant === "classic" && doc.currentFlip !== null && yourTurn
      ? getLegalMoves(doc.state, doc.currentFlip)
      : null;
  const powerMoves = doc.variant === "masterKiller" && yourTurn ? doc.currentPowerMoves : null;
  const opp = otherSeat(seat);
  const oppSeen = doc.seatLastSeen[opp];
  const oppIsBot = doc.vsCpu && opp === "p2";
  return {
    latestSeq: doc.seq,
    resync,
    events: resync ? [] : doc.events.filter((e) => e.seq > since),
    started: doc.started,
    phase: doc.phase,
    vsCpu: doc.vsCpu,
    difficulty: doc.vsCpu ? (doc.difficulty ?? "standard") : null,
    variant: doc.variant,
    state: doc.state,
    flip: doc.currentFlip,
    openingFlips: { ...doc.openingFlips },
    classPick:
      doc.variant === "masterKiller" && doc.mk
        ? {
            classes: {
              p1: doc.classesPicked.p1 ? doc.mk.classes.p1 : null,
              p2: doc.classesPicked.p2 ? doc.mk.classes.p2 : null,
            },
            ready: doc.classesPicked.p1 && (doc.classesPicked.p2 || doc.vsCpu),
          }
        : null,
    power: publicPower(doc),
    yourTurn,
    legalMoves,
    powerMoves,
    gameOver: doc.state.winner
      ? { winner: doc.state.winner, stats: { turns: doc.turns, captures: { ...doc.captures } } }
      : null,
    opponentAway: !oppIsBot && doc.started && now - oppSeen > OPPONENT_AWAY_MS,
    opponentLeft: !oppIsBot && doc.started && now - oppSeen > OPPONENT_LEFT_MS,
    chat: doc.chat,
  };
}
