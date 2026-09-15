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
  applyBless,
  applyBenediction,
  applyBlinkStrike,
  applyBulwark,
  applyCharge as mkApplyCharge,
  applyChargedShot as mkApplyChargedShot,
  applyCorpseExplosion,
  applyCurse,
  applyExhume,
  applyFelStorm,
  applyGrandHeist,
  applyBloodbath,
  applyCrescendo,
  applyInspire,
  applySongOfHaste,
  applyPiercingShot,
  applyRecklessSwing,
  applyWhirlwind,
  applyHeal,
  applyPickpocket,
  applyPowerMove,
  applyPush as mkApplyPush,
  applyReflip as mkApplyReflip,
  applyRevive,
  applySacrifice,
  applyBackstab,
  applyBlink,
  getBlinkTiles,
  BACKSTAB_COST,
  getBackstabTargets,
  applySnare,
  applyVanish,
  applyWarpath,
  applyWildHunt,
  BLESS_COST,
  breakShieldStreak,
  canReflipAgain,
  CHARGE_CAP,
  CHARGED_SHOT_COST,
  BULWARK_REINFORCED_COST,
  BULWARK_REINFORCED_RETIRED,
  CURSE_COST,
  getBenedictionTargets,
  getBlessTargets,
  getBlinkStrikeTargets,
  getBulwarkTargets,
  getChargedShotTargets,
  getCorpseExplosionTargets,
  getCurseTargets,
  getExhumeTargets,
  getFelStormTargets,
  getGrandHeistTargets,
  getBloodbathTargets,
  getCrescendoTargets,
  getInspireTargets,
  getSongOfHasteTargets,
  getPiercingShotTargets,
  getRecklessSwingTargets,
  getWhirlwindTargets,
  getHealTargets,
  getLegalPowerMoves,
  getPickpocketTargets,
  getPushTargets,
  getReviveSpawnTile,
  getSacrificeTargets,
  getSnareTiles,
  getVanishTargets,
  getWarpathTargets,
  getWildHuntTargets,
  grantZeroFlipCharge,
  PIERCING_SHOT_COST,
  RECKLESS_SWING_COST,
  WHIRLWIND_COST,
  HASTE_COST,
  INSPIRE_COST,
  rageFor,
  tickInspireForNewTurn,
  initialPowerState,
  PICKPOCKET_COST,
  REVIVE_COST,
  SNARE_COST,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
  tickCurseForNewTurn,
  tickHamstringForNewTurn,
  tickThrallForNewTurn,
  VANISH_COST,
  wolfGuardTile,
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

/** The SHIPPED-AND-PLAYABLE roster: what the class picker offers, what the
 *  CPU draws from, and what the balance sim enumerates. Deliberately shorter
 *  than master-killer.ts's PlayerClass union, which also carries the four
 *  portrait-only classes (warlock/hunter/barbarian/bard) whose kits are being
 *  built one at a time. Appending a name here is the single switch that makes
 *  a finished class live — until then a player physically cannot be dealt one,
 *  so half-built abilities can never reach a real game. */
export const MK_CLASSES: PlayerClass[] = [
  "archer", "mage", "warrior", "necromancer", "cleric", "rogue",
  "warlock", "hunter", "barbarian", "bard",
];

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
  /** Necromancer rework (2026-07-19): corpse marker + active thrall — see
   *  PowerState's docs. Plain JSON, rides the doc verbatim. */
  corpse: Record<PlayerId, { tokenId: number; tile: number } | null>;
  thrall: Record<PlayerId, { tokenId: number; turnsLeft: number } | null>;
  /** Cleric (2026-07-21): per-token blessed/wounded state — see
   *  PowerState.vitality. Plain JSON, rides the doc verbatim. */
  vitality: Record<number, "blessed" | "wounded">;
  /** Warlock (2026-07-26): each caster's single live curse — see
   *  PowerState.curse. Plain JSON, rides the doc verbatim. */
  curse: Record<PlayerId, { tokenId: number; turnsLeft: number } | null>;
  /** Hunter (2026-07-26): each hunter's armed trap tile, and every frozen
   *  stone's remaining victim-turns — see PowerState.traps / .hamstrung. */
  traps: Record<PlayerId, number | null>;
  hamstrung: Record<number, number>;
  /** Bard (2026-07-27): every lit stone's remaining bard-turns — see
   *  PowerState.inspired. */
  inspired: Record<number, number>;
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
    // Docs persisted before the necromancer rework have neither corpse nor
    // thrall — no possession in flight, which the null pair means exactly.
    // (Their live necromancers ALSO lose the old Raise kit mid-game; the
    // deploy ships a rules change, not just a schema one, and the old
    // fields simply stop being read.)
    corpse: w.corpse ?? { p1: null, p2: null },
    thrall: w.thrall ?? { p1: null, p2: null },
    // Docs persisted before the cleric existed have no vitality — no
    // blessings in flight, which the empty map means exactly.
    vitality: w.vitality ?? {},
    // Docs persisted before the warlock existed have no curse — no chains
    // in flight, which the null pair means exactly.
    curse: w.curse ?? { p1: null, p2: null },
    // Same for the hunter: no traps armed, nothing frozen.
    traps: w.traps ?? { p1: null, p2: null },
    hamstrung: w.hamstrung ?? {},
    // Docs persisted before the bard existed have nothing lit.
    inspired: w.inspired ?? {},
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
  /** Bulwark countdowns (token id -> turns remaining) and Reinforced saves
   *  (token id -> blocks remaining) — the raw lifecycle numbers behind
   *  bulwarkedTokenIds. ADDITIVE fields (older events lack them), added
   *  2026-07-19 for the activity log's effects panel so a "why did that
   *  block / why did the glow drop" question is answerable from the log. */
  bulwarkTurns?: Record<number, number>;
  bulwarkSavesLeft?: Record<number, number>;
  /** Shield-streak progress per player — ADDITIVE, same activity-log pass
   *  (diagnosing "did my Dark Resurrection count toward the ultimate"). */
  shieldStreak?: Record<PlayerId, number>;
  /** Necromancer rework: the corpse each player has banked, broadcast only
   *  while still RAISABLE (its token waiting in reserve) — the client's
   *  corpse decal and the DENIED inference both key off presence here. */
  corpse: Record<PlayerId, { tokenId: number; tile: number } | null>;
  /** The active possession, if any: which token serves which player and
   *  for how many more of their turns — drives the possession VFX and the
   *  activity log's lifecycle panel. */
  thrall: Record<PlayerId, { tokenId: number; turnsLeft: number } | null>;
  /** getReviveSpawnTile's answer for the CURRENT player (null = Revive not
   *  castable right now) — the client's gem gate and spawn preview, the
   *  server's own validation, and the bot all read the same oracle. */
  reviveSpawnTile: number | null;
  /** Corpse Explosion's victim list for the CURRENT player (empty = not
   *  castable) — the dock gate and the blast preview highlight. */
  corpseExplosionTargets: number[];
  exhumeTargets: number[];
  /** Cleric (2026-07-21): Bless / Heal target pools for the CURRENT player
   *  (affordability baked into the oracles — empty = not castable), and
   *  Benediction's would-change pool (empty = not castable; gated on
   *  ultimateReady here like every ultimate's list). ADDITIVE: older
   *  events lack them. */
  blessTargets?: number[];
  healTargets?: number[];
  benedictionTargets?: number[];
  /** Every token's blessed/wounded state — public table-state (the rings
   *  are visible board truth, same idea as bulwarkedTokenIds). ADDITIVE. */
  vitality?: Record<number, "blessed" | "wounded">;
  /** Rogue (2026-07-21, Vanish added 2026-07-22): Pickpocket / Vanish
   *  target pools for the CURRENT player (affordability baked in — Vanish's
   *  own list is gated on charges at the call site, same convention as
   *  Bulwark's), and Grand Heist's ultimate pool (gated on ultimateReady
   *  here like every ultimate's list). ADDITIVE. */
  pickpocketTargets?: number[];
  vanishTargets?: number[];
  backstabTargets?: number[];
  grandHeistTargets?: number[];
  blinkTiles?: number[];
  /** Warlock (2026-07-26): Curse / Sacrifice pools for the CURRENT player
   *  (affordability baked into both oracles — empty = not castable) and
   *  Fel Storm's victim pool (gated on ultimateReady here like every
   *  ultimate's list). ADDITIVE. */
  curseTargets?: number[];
  sacrificeTargets?: number[];
  felStormTargets?: number[];
  /** Every live curse (token id -> victim turn-starts remaining) — public
   *  table-state, same visibility rule as bulwarkedTokenIds (the chains
   *  are visible board truth for both seats). ADDITIVE. */
  cursed?: Record<number, number>;
  /** Hunter (2026-07-26): Snare's legal TILE pool (not a token pool — the
   *  one ability that targets a square), Hamstring's enemy pool, and Wild
   *  Hunt's (gated on ultimateReady like every ultimate list). ADDITIVE. */
  snareTiles?: number[];
  /** Piercing Shot's pool is at most ONE id — the arrow's own path picks
   *  the victim, so this is a castability signal plus a highlight, not a
   *  choice (Revive/Exhume's one-candidate collapse). */
  piercingShotTargets?: number[];
  wildHuntTargets?: number[];
  /** Both hunters' armed traps and the tiles their wolves guard — PUBLIC
   *  board truth for both seats by design (see PowerState.traps: routing
   *  around a visible trap is the play). Keyed by seat so a hunter mirror
   *  renders two of each. */
  traps?: Record<PlayerId, number | null>;
  wolfGuard?: Record<PlayerId, number | null>;
  /** Every frozen stone (token id -> victim turn-starts remaining). */
  hamstrung?: Record<number, number>;
  /** Barbarian (2026-07-27): Reckless Swing's enemy pool, Whirlwind's
   *  would-catch pool, and Bloodbath's would-run-down pool (gated on
   *  ultimateReady like every ultimate list). Plus each player's live Rage
   *  bonus — public board truth, since it is derived from visible reserve
   *  counts anyway and both seats' plates show it. ADDITIVE. */
  recklessSwingTargets?: number[];
  whirlwindTargets?: number[];
  bloodbathTargets?: number[];
  rage?: Record<PlayerId, number>;
  /** Bard (2026-07-27): Inspire's own-stone pool, and the two payoff pools
   *  (Song of Haste's lit stones, Crescendo's whole army — the latter
   *  gated on ultimateReady like every ultimate list). Plus every lit
   *  stone's remaining turns, public board truth like the other statuses. */
  inspireTargets?: number[];
  songOfHasteTargets?: number[];
  crescendoTargets?: number[];
  inspired?: Record<number, number>;
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
      lastUltimate: {
        kind: "blinkStrike" | "warpath" | "grandHeist";
        targetTokenId: number;
        sweptTokenIds: number[];
        /** Grand Heist only: how much of the target owner's bank was
         *  actually drained (before/after diff, server-computed). Absent
         *  for blinkStrike/warpath — they don't touch charges at all. */
        drained?: number;
      } | null;
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
      /** Necromancer's Revive just resolved on this commit. Same
       *  turn-continues lifecycle as lastReflip: the flip is unchanged and
       *  the move list was recomputed against the board the risen thrall
       *  now stands on. `tile` is the spawn the walk actually chose
       *  (server-computed, never re-derived client-side). */
      lastRevive?: { tokenId: number; tile: number } | null;
      /** A thrall crumbled at the start of this commit's turn (its
       *  duration ran out) — the token is back in its real owner's
       *  reserve. Drives the crumble VFX + activity log lifecycle. */
      lastThrallExpired?: { tokenId: number } | null;
      /** The corpse's owner re-entered the marked token this commit — the
       *  soul is reclaimed and the necromancer's Revive is denied. Derived
       *  server-side in applyMkMove (corpse token moved from reserve by
       *  its owner), same authority rule as every announcement here. */
      lastCorpseDenied?: { tokenId: number } | null;
      /** Necromancer's Corpse Explosion resolved on this commit: the
       *  epicenter tile and who the blast struck / sent home —
       *  server-computed, drives the blast announcement + activity log. */
      lastCorpseExplosion?: { tile: number; struckTokenIds: number[]; sentHomeIds: number[] } | null;
      /** Necromancer's Exhume ultimate just resolved on this commit — same
       *  lifecycle as lastUltimate. `returnedTo` is the tile the occupancy
       *  walk actually landed the dragged token on (server-computed, never
       *  re-derived client-side). */
      lastExhume?: { targetTokenId: number; returnedTo: number } | null;
      /** Cleric's Bless / Heal just resolved on this commit. */
      lastBless?: { tokenId: number } | null;
      lastHeal?: { tokenId: number } | null;
      /** Cleric's Benediction ultimate — the ids it blessed. */
      lastBenediction?: { tokenIds: number[] } | null;
      /** One or more BLESSINGS BROKE on this commit — a capture/knockback
       *  resolved as a wound instead of a kill (any path: landing, Snipe,
       *  sweep, Push, Charged Shot, Corpse Explosion). Positions are in
       *  `state`; this is the authoritative "announce the survival"
       *  signal, never re-derived client-side. */
      lastWound?: { tokenIds: number[] } | null;
      /** Sanctified Ground fired: the cleric's shield landing mended these
       *  wounded stones back to blessed. */
      lastMend?: { tokenIds: number[] } | null;
      /** Rogue's Pickpocket just resolved on this commit — bank-level, not
       *  board-level: no token moved, but the target owner's charges
       *  dropped by `stolen` (server-computed, never re-derived
       *  client-side — same discipline as every other announcement here). */
      lastPickpocket?: { targetTokenId: number; stolen: number } | null;
      /** Rogue's Vanish just resolved on this commit — same shape/lifecycle
       *  as lastBulwark, since it IS Bulwark's mechanic under a Rogue
       *  cast (see VANISH_COST's doc in master-killer.ts). */
      lastVanish?: { tokenId: number } | null;
      /** Warlock's Curse of Chains just resolved on this commit — same
       *  turn-continues lifecycle as lastReflip/lastBless. */
      lastCurse?: { targetTokenId: number } | null;
      /** A curse ran out at the start of this commit's turn — the chains
       *  lifted (lastThrallExpired's lifecycle). */
      lastCurseExpired?: { tokenId: number } | null;
      /** Warlock's Sacrifice just resolved: the mover's own stone that was
       *  given (server-selected, most-advanced) and the enemy it killed. */
      lastSacrifice?: { sacrificedTokenId: number; targetTokenId: number } | null;
      /** Rogue's Backstab just resolved — a guaranteed hit on this token. */
      lastBackstab?: { targetTokenId: number } | null;
      /** Mage's Blink just resolved — the stone that jumped and its path. */
      lastBlink?: { tokenId: number; from: number; to: number } | null;
      /** Warlock's Fel Storm ultimate — who the storm dragged, and the
       *  (rare, thrall-only) crumble deaths. Positions are in `state`. */
      lastFelStorm?: { struckTokenIds: number[]; sentHomeIds: number[] } | null;
      /** Hunter's Snare was just ARMED this commit (turn-keeping, so the
       *  same lifecycle as lastCurse). The tile is public board truth. */
      lastSnare?: { tile: number } | null;
      /** A trap SPRUNG on this commit's landing — server-computed inside
       *  resolveTurn, never re-derived client-side. */
      lastTrapSprung?: { tile: number; tokenId: number; sentHome: boolean } | null;
      /** The Wolf Companion bit the mover on this commit's landing. */
      lastWolfBite?: { tokenId: number; sentHome: boolean } | null;
      /** Hunter's Hamstring just froze a stone. */
      lastPiercingShot?: { killedTokenId: number | null; woundedTokenId: number | null } | null;
      /** A freeze ran out at the start of this commit's turn — the stones
       *  that thawed (lastThrallExpired's lifecycle). */
      lastThaw?: { tokenIds: number[] } | null;
      /** Hunter's Wild Hunt ultimate — who froze and what the wolf took. */
      lastWildHunt?: { frozenTokenIds: number[]; killedTokenId: number | null } | null;
      /** Barbarian's Reckless Swing — the trade, both halves: who swung,
       *  what died (or was wounded), and whether the recoil sent the
       *  swinger home too. */
      lastRecklessSwing?: {
        swingerTokenId: number;
        killedTokenId: number | null;
        woundedTokenId: number | null;
        swingerSentHome: boolean;
      } | null;
      /** Barbarian's Whirlwind — captured vs merely shoved. */
      lastWhirlwind?: { capturedTokenIds: number[]; knockedTokenIds: number[]; sentHomeIds: number[] } | null;
      /** Barbarian's Bloodbath ultimate — everything the charge ran down,
       *  and the tile it finished on. */
      lastBloodbath?: { killedTokenIds: number[]; endedOn: number } | null;
      /** Bard's Inspire lit a stone this commit (turn-keeping, lastCurse's
       *  lifecycle). */
      lastInspire?: { tokenId: number } | null;
      /** Inspirations that faded at the start of this commit's turn. */
      lastInspireFaded?: { tokenIds: number[] } | null;
      /** Bard's Song of Haste / Crescendo resolved — which stones marched,
       *  and anything they ran over on the way. Crescendo also reports the
       *  ids it lit. */
      lastSongOfHaste?: { movedIds: number[]; capturedIds: number[] } | null;
      lastCrescendo?: { inspiredIds: number[]; movedIds: number[]; capturedIds: number[] } | null;
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
  lastUltimate: {
    kind: "blinkStrike" | "warpath" | "grandHeist";
    targetTokenId: number;
    sweptTokenIds: number[];
    drained?: number;
  } | null;
  lastBulwark: { tokenId: number; reinforced?: boolean } | null;
  lastBulwarkBlock: { tokenIds: number[] } | null;
  /** See RoomEvent's doc: set only on the commit where a Re-flip resolved.
   *  Docs persisted before this field existed read as undefined ≙ null. */
  lastReflip?: { player: PlayerId } | null;
  /** See RoomEvent's doc: set only on the commit where a Revive resolved.
   *  Docs persisted before this field existed read as undefined ≙ null. */
  lastRevive?: { tokenId: number; tile: number } | null;
  /** See RoomEvent's doc: set on the commit whose turn-start crumbled a
   *  thrall. */
  lastThrallExpired?: { tokenId: number } | null;
  /** See RoomEvent's doc: set on the commit where the corpse's owner
   *  re-entered the marked token, denying the Revive. */
  lastCorpseDenied?: { tokenId: number } | null;
  /** See RoomEvent's doc: set on the commit where a Corpse Explosion
   *  resolved. */
  lastCorpseExplosion?: { tile: number; struckTokenIds: number[]; sentHomeIds: number[] } | null;
  /** See RoomEvent's doc: set only on the commit where an Exhume resolved. */
  lastExhume?: { targetTokenId: number; returnedTo: number } | null;
  /** See RoomEvent's docs — the cleric's announcement slots (2026-07-21).
   *  Docs persisted before these fields existed read as undefined ≙ null. */
  lastBless?: { tokenId: number } | null;
  lastHeal?: { tokenId: number } | null;
  lastBenediction?: { tokenIds: number[] } | null;
  lastWound?: { tokenIds: number[] } | null;
  lastMend?: { tokenIds: number[] } | null;
  /** See RoomEvent's docs — the rogue's announcement slots (2026-07-21).
   *  Docs persisted before these fields existed read as undefined ≙ null. */
  lastPickpocket?: { targetTokenId: number; stolen: number } | null;
  lastVanish?: { tokenId: number } | null;
  /** See RoomEvent's docs — the warlock's announcement slots (2026-07-26).
   *  Docs persisted before these fields existed read as undefined ≙ null. */
  lastCurse?: { targetTokenId: number } | null;
  lastCurseExpired?: { tokenId: number } | null;
  lastSacrifice?: { sacrificedTokenId: number; targetTokenId: number } | null;
  lastBackstab?: { targetTokenId: number } | null;
  lastBlink?: { tokenId: number; from: number; to: number } | null;
  lastFelStorm?: { struckTokenIds: number[]; sentHomeIds: number[] } | null;
  /** See RoomEvent's docs — the hunter's announcement slots (2026-07-26).
   *  Docs persisted before these fields existed read as undefined ≙ null. */
  lastSnare?: { tile: number } | null;
  lastTrapSprung?: { tile: number; tokenId: number; sentHome: boolean } | null;
  lastWolfBite?: { tokenId: number; sentHome: boolean } | null;
  lastPiercingShot?: { killedTokenId: number | null; woundedTokenId: number | null } | null;
  lastThaw?: { tokenIds: number[] } | null;
  lastWildHunt?: { frozenTokenIds: number[]; killedTokenId: number | null } | null;
  /** See RoomEvent's docs — the barbarian's announcement slots (2026-07-27).
   *  Docs persisted before these fields existed read as undefined ≙ null. */
  lastRecklessSwing?: {
    swingerTokenId: number;
    killedTokenId: number | null;
    woundedTokenId: number | null;
    swingerSentHome: boolean;
  } | null;
  lastWhirlwind?: { capturedTokenIds: number[]; knockedTokenIds: number[]; sentHomeIds: number[] } | null;
  lastBloodbath?: { killedTokenIds: number[]; endedOn: number } | null;
  /** See RoomEvent's docs — the bard's announcement slots (2026-07-27).
   *  Docs persisted before these fields existed read as undefined ≙ null. */
  lastInspire?: { tokenId: number } | null;
  lastInspireFaded?: { tokenIds: number[] } | null;
  lastSongOfHaste?: { movedIds: number[]; capturedIds: number[] } | null;
  lastCrescendo?: { inspiredIds: number[]; movedIds: number[]; capturedIds: number[] } | null;
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
        /** Necromancer's Revive: no payload — the banked corpse fully
         *  determines what rises and where (getReviveSpawnTile is the
         *  shared legality oracle). */
        | { kind: "revive" }
        /** Corpse Explosion: no payload — the marked corpse is the
         *  epicenter; getCorpseExplosionTargets is the shared oracle. */
        | { kind: "corpseExplosion" }
        | { kind: "exhume"; targetTokenId: number }
        /** Cleric's Bless / Heal: target one of the caster's OWN stones
         *  (Bulwark's shape) — the shared oracles are the whole gate. */
        | { kind: "bless"; targetTokenId: number }
        | { kind: "heal"; targetTokenId: number }
        /** Cleric's Benediction: no payload — getBenedictionTargets is the
         *  shared oracle (empty pool = not castable). */
        | { kind: "benediction" }
        /** Rogue's Pickpocket: targets an enemy in shared water, but the
         *  effect is bank-level (getPickpocketTargets is the shared
         *  oracle). */
        | { kind: "pickpocket"; targetTokenId: number }
        /** Rogue's Vanish: targets one of the caster's OWN stones, same
         *  shape as Bulwark's tokenId (getVanishTargets is the shared
         *  oracle — it IS Bulwark's mechanic under a Rogue cast). */
        | { kind: "vanish"; tokenId: number }
        | { kind: "grandHeist"; targetTokenId: number };
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

/** A player's corpse, but only while it's still raisable (its token waiting
 *  in reserve) — the lazy-denial rule getReviveSpawnTile enforces, applied
 *  to the broadcast so clients never see a dead-lettered marker. */
function raisableCorpse(doc: RoomDoc, player: PlayerId): { tokenId: number; tile: number } | null {
  const corpse = doc.mk?.corpse?.[player] ?? null;
  if (!corpse) return null;
  const body = doc.state.tokens.find((t) => t.id === corpse.tokenId);
  return body && body.position === -1 ? corpse : null;
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
    // A Bulwark that blocked THIS flip was already consumed by
    // tickBulwarkForNewTurn, but it is still doing its job for the rest of
    // this turn (the served move list was computed with it up). Keep it in
    // the VISIBLE list until the turn resolves — CLEAR_SLOTS wipes
    // lastBulwarkBlock on the next commit, so the glow falls exactly when
    // the protection actually stops mattering. Without this union the glow
    // dropped at the block flip while captures stayed impossible all turn:
    // Kasen's 2026-07-19 "it wore off but it's still activating" report.
    bulwarkedTokenIds: [
      ...new Set([
        ...Object.keys(doc.mk.bulwarked).map(Number),
        ...(doc.lastBulwarkBlock?.tokenIds ?? []),
      ]),
    ],
    bulwarkTurns: { ...doc.mk.bulwarked },
    bulwarkSavesLeft: { ...doc.mk.bulwarkSaves },
    shieldStreak: { ...doc.mk.shieldStreak },
    corpse: {
      // Broadcast only while raisable — the moment the victim re-enters
      // the marked token the decal (and the threat) vanish for both seats.
      p1: raisableCorpse(doc, "p1"),
      p2: raisableCorpse(doc, "p2"),
    },
    thrall: { p1: doc.mk.thrall?.p1 ?? null, p2: doc.mk.thrall?.p2 ?? null },
    reviveSpawnTile:
      doc.mk.classes[mover] === "necromancer" ? getReviveSpawnTile(doc.state, p, mover) : null,
    corpseExplosionTargets:
      doc.mk.classes[mover] === "necromancer" ? getCorpseExplosionTargets(doc.state, p, mover) : [],
    exhumeTargets:
      doc.mk.classes[mover] === "necromancer" && doc.mk.ultimateReady[mover]
        ? getExhumeTargets(doc.state, p, mover)
        : [],
    blessTargets: doc.mk.classes[mover] === "cleric" ? getBlessTargets(doc.state, p, mover) : [],
    healTargets: doc.mk.classes[mover] === "cleric" ? getHealTargets(doc.state, p, mover) : [],
    benedictionTargets:
      doc.mk.classes[mover] === "cleric" && doc.mk.ultimateReady[mover]
        ? getBenedictionTargets(doc.state, p, mover)
        : [],
    vitality: { ...(doc.mk.vitality ?? {}) },
    pickpocketTargets:
      doc.mk.classes[mover] === "rogue" ? getPickpocketTargets(doc.state, p, mover) : [],
    vanishTargets:
      doc.mk.classes[mover] === "rogue" && doc.mk.charges[mover] >= VANISH_COST
        ? getVanishTargets(doc.state, p, mover)
        : [],
    grandHeistTargets:
      doc.mk.classes[mover] === "rogue" && doc.mk.ultimateReady[mover]
        ? getGrandHeistTargets(doc.state, p, mover)
        : [],
    curseTargets: doc.mk.classes[mover] === "warlock" ? getCurseTargets(doc.state, p, mover) : [],
    sacrificeTargets: doc.mk.classes[mover] === "warlock" ? getSacrificeTargets(doc.state, p, mover) : [],
    backstabTargets: doc.mk.classes[mover] === "rogue" ? getBackstabTargets(doc.state, p, mover) : [],
    blinkTiles: doc.mk.classes[mover] === "mage" ? getBlinkTiles(doc.state, p, mover) : [],
    felStormTargets:
      doc.mk.classes[mover] === "warlock" && doc.mk.ultimateReady[mover]
        ? getFelStormTargets(doc.state, p, mover)
        : [],
    cursed: Object.fromEntries(
      (["p1", "p2"] as PlayerId[])
        .map((pl) => p.curse[pl])
        .filter((c): c is { tokenId: number; turnsLeft: number } => c !== null)
        .map((c) => [c.tokenId, c.turnsLeft]),
    ),
    snareTiles: doc.mk.classes[mover] === "hunter" ? getSnareTiles(doc.state, p, mover) : [],
    piercingShotTargets:
      doc.mk.classes[mover] === "hunter" ? getPiercingShotTargets(doc.state, p, mover) : [],
    wildHuntTargets:
      doc.mk.classes[mover] === "hunter" && doc.mk.ultimateReady[mover]
        ? getWildHuntTargets(doc.state, p, mover)
        : [],
    traps: { p1: p.traps?.p1 ?? null, p2: p.traps?.p2 ?? null },
    wolfGuard: {
      p1: wolfGuardTile(doc.state, p, "p1"),
      p2: wolfGuardTile(doc.state, p, "p2"),
    },
    hamstrung: { ...(p.hamstrung ?? {}) },
    recklessSwingTargets:
      doc.mk.classes[mover] === "barbarian" ? getRecklessSwingTargets(doc.state, p, mover) : [],
    whirlwindTargets:
      doc.mk.classes[mover] === "barbarian" ? getWhirlwindTargets(doc.state, p, mover) : [],
    bloodbathTargets:
      doc.mk.classes[mover] === "barbarian" && doc.mk.ultimateReady[mover]
        ? getBloodbathTargets(doc.state, p, mover)
        : [],
    rage: { p1: rageFor(doc.state, p, "p1"), p2: rageFor(doc.state, p, "p2") },
    inspireTargets: doc.mk.classes[mover] === "bard" ? getInspireTargets(doc.state, p, mover) : [],
    songOfHasteTargets: doc.mk.classes[mover] === "bard" ? getSongOfHasteTargets(doc.state, p, mover) : [],
    crescendoTargets:
      doc.mk.classes[mover] === "bard" && doc.mk.ultimateReady[mover]
        ? getCrescendoTargets(doc.state, p, mover)
        : [],
    inspired: { ...(p.inspired ?? {}) },
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
    lastRevive: doc.lastRevive ?? null,
    lastThrallExpired: doc.lastThrallExpired ?? null,
    lastCorpseDenied: doc.lastCorpseDenied ?? null,
    lastCorpseExplosion: doc.lastCorpseExplosion ?? null,
    lastExhume: doc.lastExhume ?? null,
    lastBless: doc.lastBless ?? null,
    lastHeal: doc.lastHeal ?? null,
    lastBenediction: doc.lastBenediction ?? null,
    lastWound: doc.lastWound ?? null,
    lastMend: doc.lastMend ?? null,
    lastPickpocket: doc.lastPickpocket ?? null,
    lastVanish: doc.lastVanish ?? null,
    lastCurse: doc.lastCurse ?? null,
    lastCurseExpired: doc.lastCurseExpired ?? null,
    lastSacrifice: doc.lastSacrifice ?? null,
    lastBackstab: doc.lastBackstab ?? null,
    lastBlink: doc.lastBlink ?? null,
    lastFelStorm: doc.lastFelStorm ?? null,
    lastSnare: doc.lastSnare ?? null,
    lastTrapSprung: doc.lastTrapSprung ?? null,
    lastWolfBite: doc.lastWolfBite ?? null,
    lastPiercingShot: doc.lastPiercingShot ?? null,
    lastThaw: doc.lastThaw ?? null,
    lastWildHunt: doc.lastWildHunt ?? null,
    lastRecklessSwing: doc.lastRecklessSwing ?? null,
    lastWhirlwind: doc.lastWhirlwind ?? null,
    lastBloodbath: doc.lastBloodbath ?? null,
    lastInspire: doc.lastInspire ?? null,
    lastInspireFaded: doc.lastInspireFaded ?? null,
    lastSongOfHaste: doc.lastSongOfHaste ?? null,
    lastCrescendo: doc.lastCrescendo ?? null,
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
  | "lastReflip" | "lastRevive" | "lastThrallExpired" | "lastCorpseDenied" | "lastCorpseExplosion" | "lastExhume"
  | "lastBless" | "lastHeal" | "lastBenediction" | "lastWound" | "lastMend" | "rescueAttempted"
  | "lastPickpocket" | "lastVanish" | "lastBackstab" | "lastBlink"
  | "lastCurse" | "lastCurseExpired" | "lastSacrifice" | "lastFelStorm"
  | "lastSnare" | "lastTrapSprung" | "lastWolfBite" | "lastPiercingShot" | "lastThaw" | "lastWildHunt"
  | "lastRecklessSwing" | "lastWhirlwind" | "lastBloodbath"
  | "lastInspire" | "lastInspireFaded" | "lastSongOfHaste" | "lastCrescendo"
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
    lastRevive: null,
    lastThrallExpired: null,
    lastCorpseDenied: null,
    lastCorpseExplosion: null,
    lastExhume: null,
    lastBless: null,
    lastHeal: null,
    lastBenediction: null,
    lastWound: null,
    lastMend: null,
    lastPickpocket: null,
    lastVanish: null,
    lastCurse: null,
    lastCurseExpired: null,
    lastSacrifice: null,
    lastBackstab: null,
    lastBlink: null,
    lastFelStorm: null,
    lastSnare: null,
    lastTrapSprung: null,
    lastWolfBite: null,
    lastPiercingShot: null,
    lastThaw: null,
    lastWildHunt: null,
    lastRecklessSwing: null,
    lastWhirlwind: null,
    lastBloodbath: null,
    lastInspire: null,
    lastInspireFaded: null,
    lastSongOfHaste: null,
    lastCrescendo: null,
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
      // The client greys out portrait-only classes, but the picker is the one
      // place a client hands the server a class NAME rather than an index into
      // a server-computed list — so it gets the same re-validation every other
      // action does (see CLAUDE.md's trust model). Without this, a crafted
      // pickClass could seat someone in a class whose kit doesn't exist yet.
      if (!MK_CLASSES.includes(action.class)) return { doc, error: "Class not available" };
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
      if (a.kind === "bulwark") return { doc: applyMkSimple(doc, seat, "bulwark", a.tokenId, now, rand, a.reinforced === true) };
      if (a.kind === "revive") return { doc: applyMkRevive(doc, seat, now) };
      if (a.kind === "corpseExplosion") return { doc: applyMkCorpseExplosion(doc, seat, now) };
      if (a.kind === "exhume") return { doc: applyMkSimple(doc, seat, "exhume", a.targetTokenId, now) };
      if (a.kind === "bless") return { doc: applyMkBlessing(doc, seat, a.targetTokenId, now) };
      if (a.kind === "heal") return { doc: applyMkSimple(doc, seat, "heal", a.targetTokenId, now) };
      if (a.kind === "benediction") return { doc: applyMkBenediction(doc, seat, now) };
      if (a.kind === "pickpocket") return { doc: applyMkPickpocket(doc, seat, a.targetTokenId, now) };
      if (a.kind === "vanish") return { doc: applyMkSimple(doc, seat, "vanish", a.tokenId, now, rand) };
      if (a.kind === "grandHeist") return { doc: applyMkSimple(doc, seat, "grandHeist", a.targetTokenId, now) };
      if (a.kind === "curse") return { doc: applyMkCurse(doc, seat, a.targetTokenId, now) };
      if (a.kind === "sacrifice") return { doc: applyMkSacrifice(doc, seat, a.targetTokenId, now) };
      if (a.kind === "backstab") return { doc: applyMkBackstab(doc, seat, a.targetTokenId, now) };
      if (a.kind === "blink") return { doc: applyMkBlink(doc, seat, a.tile, now) };
      if (a.kind === "felStorm") return { doc: applyMkFelStorm(doc, seat, now) };
      if (a.kind === "snare") return { doc: applyMkSnare(doc, seat, a.tile, now) };
      if (a.kind === "piercingShot") return { doc: applyMkPiercingShot(doc, seat, now) };
      if (a.kind === "wildHunt") return { doc: applyMkWildHunt(doc, seat, now) };
      if (a.kind === "recklessSwing") return { doc: applyMkRecklessSwing(doc, seat, a.targetTokenId, now) };
      if (a.kind === "whirlwind") return { doc: applyMkWhirlwind(doc, seat, now) };
      if (a.kind === "bloodbath") return { doc: applyMkBloodbath(doc, seat, now) };
      if (a.kind === "inspire") return { doc: applyMkInspire(doc, seat, a.targetTokenId, now) };
      if (a.kind === "songOfHaste") return { doc: applyMkSongOfHaste(doc, seat, now) };
      if (a.kind === "crescendo") return { doc: applyMkCrescendo(doc, seat, now) };
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
      if (doc.mk.charges[seat] < CHARGED_SHOT_COST) return `Charged Shot costs ${CHARGED_SHOT_COST} charges`;
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
        if (BULWARK_REINFORCED_RETIRED) return "Reinforced Bulwark is retired";
        // Mirrors Charged Shot's own full-bank gate: the reinforced cast is
        // a uniform "has the mover banked the whole cap" check, identical
        // for every target.
        if (doc.mk.charges[seat] < BULWARK_REINFORCED_COST) return `Reinforced Bulwark costs ${BULWARK_REINFORCED_COST} charges`;
      } else if (doc.mk.charges[seat] < 1) {
        return "No charge available";
      }
      if (!getBulwarkTargets(doc.state, p(), seat).includes(a.tokenId)) return "Invalid Bulwark target";
      return null;
    case "revive":
      if (cls !== "necromancer") return "Only a Necromancer can Revive";
      // Revive keeps the SAME flip alive (see applyMkRevive) — there has to
      // be one to keep, same guard as chooseMove's.
      if (doc.currentFlip === null) return "No flip yet";
      // Everything else — corpse banked, corpse still raisable, no thrall
      // up, full soul bank — is getReviveSpawnTile's single shared oracle.
      if (getReviveSpawnTile(doc.state, p(), seat) === null) return "Revive not castable";
      return null;
    case "corpseExplosion":
      if (cls !== "necromancer") return "Only a Necromancer can detonate a corpse";
      if (getCorpseExplosionTargets(doc.state, p(), seat).length === 0)
        return "Corpse Explosion not castable";
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
    case "bless":
      if (cls !== "cleric") return "Only a Cleric can Bless";
      // Bless keeps the SAME flip alive (Revive's contract, see
      // applyMkBlessing) — there has to be one to keep.
      if (doc.currentFlip === null) return "No flip yet";
      // Affordability is baked into the oracle (see getBlessTargets).
      if (!getBlessTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Bless target";
      return null;
    case "heal":
      // Heal ENDS the turn (Bulwark's shape) — no flip guard needed.
      if (cls !== "cleric") return "Only a Cleric can Heal";
      if (!getHealTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Heal target";
      return null;
    case "benediction":
      if (cls !== "cleric") return "Only a Cleric can cast Benediction";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (getBenedictionTargets(doc.state, p(), seat).length === 0) return "Benediction would bless no one";
      return null;
    case "pickpocket":
      if (cls !== "rogue") return "Only a Rogue can Pickpocket";
      // Pickpocket keeps the SAME flip alive (Bless's contract, see
      // applyMkPickpocket) — there has to be one to keep.
      if (doc.currentFlip === null) return "No flip yet";
      if (!getPickpocketTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Pickpocket target";
      return null;
    case "vanish":
      if (cls !== "rogue") return "Only a Rogue can Vanish";
      if (doc.mk.charges[seat] < VANISH_COST) return "No charge available";
      if (!getVanishTargets(doc.state, p(), seat).includes(a.tokenId)) return "Invalid Vanish target";
      return null;
    case "grandHeist":
      if (cls !== "rogue") return "Only a Rogue can Grand Heist";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (!getGrandHeistTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Grand Heist target";
      return null;
    case "curse":
      if (cls !== "warlock") return "Only a Warlock can Curse";
      // Curse keeps the SAME flip alive (Bless's contract, see
      // applyMkCurse) — there has to be one to keep.
      if (doc.currentFlip === null) return "No flip yet";
      if (!getCurseTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Curse target";
      return null;
    case "sacrifice":
      // Turn-ending (Push's shape) — no flip guard needed.
      if (cls !== "warlock") return "Only a Warlock can Sacrifice";
      if (!getSacrificeTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Sacrifice target";
      return null;
    case "blink":
      // Turn-ending (Push's shape) — no flip guard needed.
      if (cls !== "mage") return "Only a Mage can Blink";
      if (!getBlinkTiles(doc.state, p(), seat).includes(a.tile)) return "Invalid Blink tile";
      return null;
    case "backstab":
      // Turn-ending (Push's shape) — no flip guard needed.
      if (cls !== "rogue") return "Only a Rogue can Backstab";
      if (doc.mk.charges[seat] < BACKSTAB_COST) return `Backstab costs ${BACKSTAB_COST} charges`;
      if (!getBackstabTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Backstab target";
      return null;
    case "felStorm":
      if (cls !== "warlock") return "Only a Warlock can call a Fel Storm";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (getFelStormTargets(doc.state, p(), seat).length === 0) return "Fel Storm would drag no one";
      return null;
    case "snare":
      if (cls !== "hunter") return "Only a Hunter can set a Snare";
      // Snare keeps the SAME flip alive (Curse's contract, see
      // applyMkSnare) — there has to be one to keep.
      if (doc.currentFlip === null) return "No flip yet";
      // A TILE, not a token id — the one action shaped this way.
      if (!getSnareTiles(doc.state, p(), seat).includes(a.tile)) return "Invalid Snare tile";
      return null;
    case "piercingShot":
      // Turn-ending (Push's shape) — no flip guard needed.
      if (cls !== "hunter") return "Only a Hunter can loose a Piercing Shot";
      if (doc.mk.charges[seat] < PIERCING_SHOT_COST) return "Piercing Shot needs a full charge bank";
      // No target to validate — the arrow's path picks the victim. A
      // non-empty oracle IS the castability check.
      if (getPiercingShotTargets(doc.state, p(), seat).length === 0) return "No clear shot";
      return null;
    case "wildHunt":
      if (cls !== "hunter") return "Only a Hunter can call the Wild Hunt";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (getWildHuntTargets(doc.state, p(), seat).length === 0) return "Nothing left to hunt";
      return null;
    case "recklessSwing":
      if (cls !== "barbarian") return "Only a Barbarian can swing recklessly";
      if (doc.mk.charges[seat] < RECKLESS_SWING_COST) return "No charge available";
      if (!getRecklessSwingTargets(doc.state, p(), seat).includes(a.targetTokenId)) {
        return "Invalid Reckless Swing target";
      }
      return null;
    case "whirlwind":
      if (cls !== "barbarian") return "Only a Barbarian can Whirlwind";
      if (doc.mk.charges[seat] < WHIRLWIND_COST) return "Whirlwind needs a full charge bank";
      if (getWhirlwindTargets(doc.state, p(), seat).length === 0) return "Nothing within reach";
      return null;
    case "bloodbath":
      if (cls !== "barbarian") return "Only a Barbarian can Bloodbath";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (getBloodbathTargets(doc.state, p(), seat).length === 0) return "Nothing in the charge's path";
      return null;
    case "inspire":
      if (cls !== "bard") return "Only a Bard can Inspire";
      // Inspire keeps the SAME flip alive (Curse's contract, see
      // applyMkInspire) — there has to be one to keep.
      if (doc.currentFlip === null) return "No flip yet";
      if (!getInspireTargets(doc.state, p(), seat).includes(a.targetTokenId)) return "Invalid Inspire target";
      return null;
    case "songOfHaste":
      // Turn-ending (Push's shape) — no flip guard needed.
      if (cls !== "bard") return "Only a Bard can sing the Song of Haste";
      if (doc.mk.charges[seat] < HASTE_COST) return "Song of Haste needs a full charge bank";
      if (getSongOfHasteTargets(doc.state, p(), seat).length === 0) return "No inspired stones to carry the song";
      return null;
    case "crescendo":
      if (cls !== "bard") return "Only a Bard can play a Crescendo";
      if (!doc.mk.ultimateReady[seat]) return "Ultimate not ready";
      if (getCrescendoTargets(doc.state, p(), seat).length === 0) return "No one on the board to sing to";
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
  lastRevive: null,
  lastThrallExpired: null,
  lastCorpseDenied: null,
  lastCorpseExplosion: null,
  lastExhume: null,
  lastBless: null,
  lastHeal: null,
  lastBenediction: null,
  lastWound: null,
  lastMend: null,
  lastPickpocket: null,
  lastVanish: null,
  lastCurse: null,
  lastCurseExpired: null,
  lastSacrifice: null,
  lastBackstab: null,
  lastBlink: null,
  lastFelStorm: null,
  lastSnare: null,
  lastTrapSprung: null,
  lastWolfBite: null,
  lastPiercingShot: null,
  lastThaw: null,
  lastWildHunt: null,
  lastRecklessSwing: null,
  lastWhirlwind: null,
  lastBloodbath: null,
  lastInspire: null,
  lastInspireFaded: null,
  lastSongOfHaste: null,
  lastCrescendo: null,
  wasSkipped: false,
  skippedPlayer: null,
  skipReason: null,
} as const;

function applyMkMove(doc: RoomDoc, seat: PlayerId, move: PowerMove, now: number, rand: () => number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const foe = otherSeat(seat);
  const r = applyPowerMove(doc.state, fromWirePower(doc.mk!), move, seat, rand);
  const delta = r.power.charges[seat] - chargesBefore;
  const rainHit = r.rainOfArrows?.targetTokenId != null ? 1 : 0;
  // Wounds are not captures: a blessed victim survived, so the scoreboard
  // must not count it (r.wounded ⊂ the move's capture lists).
  const caps = move.captures.length + move.bonusCaptures.length + rainHit - r.wounded.length;
  // Corpse denial: the mover just re-entered the exact token the enemy
  // necromancer's corpse marker points at — the soul is reclaimed. Derived
  // here (the only path a reserve token re-enters by) so the client gets
  // an authoritative announcement instead of inferring from the corpse
  // field vanishing.
  const foeCorpse = doc.mk!.corpse?.[foe] ?? null;
  const corpseDenied = foeCorpse !== null && move.tokenId === foeCorpse.tokenId && move.from === -1;
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
    lastCorpseDenied: corpseDenied ? { tokenId: move.tokenId } : null,
    lastRainOfArrows: r.rainOfArrows,
    lastWound: r.wounded.length > 0 ? { tokenIds: r.wounded.map((w) => w.tokenId) } : null,
    lastMend: r.mendedTokenIds.length > 0 ? { tokenIds: r.mendedTokenIds } : null,
    // The enemy hunter's reactive layer fired on this landing (see
    // resolveTurn) — server-computed, never re-derived client-side.
    lastTrapSprung: r.trapSprung,
    lastWolfBite: r.wolfBite,
  };
  return commitFrame(next, now, stateEventOf(next));
}

function applyMkCharge(doc: RoomDoc, seat: PlayerId, move: PowerMove, now: number, rand: () => number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = mkApplyCharge(doc.state, fromWirePower(doc.mk!), move, seat, rand);
  const delta = r.power.charges[seat] - chargesBefore;
  const rainHit = r.rainOfArrows?.targetTokenId != null ? 1 : 0;
  // Same wounds-aren't-captures scoreboard rule as applyMkMove's.
  const caps =
    move.captures.length + move.bonusCaptures.length + move.chargeSweepCaptures.length + rainHit - r.wounded.length;
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
    lastRainOfArrows: r.rainOfArrows,
    lastChargeSweep: { sweptTokenIds: move.chargeSweepCaptures },
    lastWound: r.wounded.length > 0 ? { tokenIds: r.wounded.map((w) => w.tokenId) } : null,
    lastMend: r.mendedTokenIds.length > 0 ? { tokenIds: r.mendedTokenIds } : null,
    lastTrapSprung: r.trapSprung,
    lastWolfBite: r.wolfBite,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Push / Charged Shot / Blink Strike / Warpath / Bulwark / Exhume share
 *  one commit shape and differ only in which apply-fn runs and which slot
 *  announces. `reinforced` only means anything for kind "bulwark" (the
 *  full-bank cast). (Bless/Heal are NOT here — they keep the turn, see
 *  applyMkBlessing.) */
function applyMkSimple(
  doc: RoomDoc,
  seat: PlayerId,
  kind: "push" | "chargedShot" | "blinkStrike" | "warpath" | "bulwark" | "exhume" | "heal" | "vanish" | "grandHeist",
  tokenId: number,
  now: number,
  rand: () => number = Math.random,
  reinforced = false,
): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const power = fromWirePower(doc.mk!);
  let r: { state: GameState; power: PowerState; sweptTokenIds?: number[] };
  let slots: Partial<RoomDoc> = {};
  let capsGained = 0;
  switch (kind) {
    case "push": {
      const rr = mkApplyPush(doc.state, power, tokenId, seat);
      r = rr;
      slots = {
        lastPush: { targetTokenId: tokenId },
        // A blessing absorbed the send-home: announce the survival too.
        lastWound: rr.woundedTokenId !== null ? { tokenIds: [rr.woundedTokenId] } : null,
      };
      break;
    }
    case "chargedShot": {
      const rr = mkApplyChargedShot(doc.state, power, tokenId, seat);
      r = rr;
      slots = {
        lastChargedShot: { targetTokenId: tokenId },
        lastWound: rr.woundedTokenId !== null ? { tokenIds: [rr.woundedTokenId] } : null,
      };
      break;
    }
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
    case "heal":
      // Turn-ending, Bulwark's shape (Bless is the turn-keeper — see
      // applyMkBlessing).
      r = applyHeal(doc.state, power, tokenId, seat);
      slots = { lastHeal: { tokenId } };
      break;
    case "vanish":
      // Turn-ending, no capture, no board movement — exactly Bulwark's
      // shape, since Vanish IS Bulwark's mechanic under a Rogue cast.
      r = applyVanish(doc.state, power, tokenId, seat);
      slots = { lastVanish: { tokenId } };
      break;
    case "grandHeist": {
      const heistFoe: PlayerId = seat === "p1" ? "p2" : "p1";
      const foeChargesBefore = power.charges[heistFoe];
      const rr = applyGrandHeist(doc.state, power, tokenId, seat);
      r = { ...rr, sweptTokenIds: [] };
      capsGained = 1;
      const drained = foeChargesBefore - rr.power.charges[heistFoe];
      slots = { lastUltimate: { kind: "grandHeist", targetTokenId: tokenId, sweptTokenIds: [], drained } };
      break;
    }
  }
  const delta = r.power.charges[seat] - chargesBefore;
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

/** Revive does NOT end the turn: the risen thrall joins the board and the
 *  SAME flip re-resolves against it — Re-flip's contract, minus the
 *  re-roll (see applyRevive's doc in master-killer.ts). The commit resets
 *  waitingSince, so a pending auto-skip deadline restarts against the
 *  recomputed move list by construction. */
function applyMkRevive(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const flip = doc.currentFlip!; // validated non-null (see validateUsePower)
  const risen = applyRevive(doc.state, fromWirePower(doc.mk!), seat);
  // Move list FIRST (against the post-revive board), THEN the same-turn
  // Bulwark re-check, exactly the Re-flip path's: the thrall can reveal
  // capture threats the pre-revive board didn't have (no expiry tick —
  // it's still the same turn), and a Bulwark that blocks one eats that
  // threat for this flip, so the served list must come from the
  // pre-consumption power — commitTurnFlip's and both sims' ordering.
  const currentPowerMoves = getLegalPowerMoves(risen.state, risen.power, flip);
  const bulwarkResult = tickBulwarkForReflip(risen.state, risen.power, flip);
  const power = bulwarkResult.power;
  const delta = power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: risen.state,
    mk: toWirePower(power),
    currentFlip: flip,
    currentPowerMoves,
    lastMovePlayer: doc.lastMovePlayer,
    lastBulwarkBlock: bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastRevive: { tokenId: risen.raisedTokenId, tile: risen.raisedTo },
    // A revive during a zero flip spends AFTER the flip commit banked the
    // grant's baseline: shift the baseline down by the same spend so the
    // auto-skip commit still announces exactly the grant (see the flip-zero
    // branch in tickOnce), not grant-minus-spend.
    zeroFlipChargeBefore:
      doc.zeroFlipChargeBefore !== null ? doc.zeroFlipChargeBefore - REVIVE_COST : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Cleric's Bless does NOT end the turn — Revive's exact commit contract
 *  (see applyMkRevive): the SAME flip stays live and the move list is
 *  recomputed (the board is untouched — only a vitality flag changed —
 *  but the recompute keeps the turn-keeping shape uniform and
 *  future-proof). The commit resets waitingSince, so a pending auto-skip
 *  restarts against the recomputed list by construction. (Heal is
 *  deliberately NOT here — it ends the turn via applyMkSimple; see
 *  HEAL_COST's doc for the asymmetry's balance trace.) */
function applyMkBlessing(doc: RoomDoc, seat: PlayerId, tokenId: number, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const flip = doc.currentFlip!; // validated non-null (see validateUsePower)
  const power = fromWirePower(doc.mk!);
  const r = applyBless(doc.state, power, tokenId, seat);
  const currentPowerMoves = getLegalPowerMoves(r.state, r.power, flip);
  const bulwarkResult = tickBulwarkForReflip(r.state, r.power, flip);
  const nextPower = bulwarkResult.power;
  const delta = nextPower.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(nextPower),
    currentFlip: flip,
    currentPowerMoves,
    lastMovePlayer: doc.lastMovePlayer,
    lastBulwarkBlock: bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastBless: { tokenId },
    // A cast during a zero flip spends AFTER the flip commit banked the
    // grant's baseline — applyMkRevive's exact bookkeeping, so the
    // auto-skip commit still announces exactly the grant.
    zeroFlipChargeBefore:
      doc.zeroFlipChargeBefore !== null ? doc.zeroFlipChargeBefore - BLESS_COST : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Rogue's Pickpocket does NOT end the turn — Bless's exact commit
 *  contract (see applyMkBlessing): the SAME flip stays live and the move
 *  list is recomputed, which matters here more than for most turn-keepers
 *  — draining the foe below CHARGE_CAP can drop their Ward mid-turn,
 *  immediately unlocking a capture the mover's own move list didn't offer
 *  a moment ago. `stolen` is the amount actually drained (foe's real
 *  before/after difference, not just PICKPOCKET_STEAL) so the
 *  announcement never overstates a theft the oracle's own floor already
 *  capped. */
function applyMkPickpocket(doc: RoomDoc, seat: PlayerId, tokenId: number, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const foe = otherSeat(seat);
  const foeChargesBefore = doc.mk!.charges[foe];
  const flip = doc.currentFlip!; // validated non-null (see validateUsePower)
  const power = applyPickpocket(fromWirePower(doc.mk!), seat);
  const currentPowerMoves = getLegalPowerMoves(doc.state, power, flip);
  const bulwarkResult = tickBulwarkForReflip(doc.state, power, flip);
  const nextPower = bulwarkResult.power;
  const delta = nextPower.charges[seat] - chargesBefore;
  const stolen = foeChargesBefore - nextPower.charges[foe];
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    mk: toWirePower(nextPower),
    currentFlip: flip,
    currentPowerMoves,
    lastMovePlayer: doc.lastMovePlayer,
    lastBulwarkBlock: bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastPickpocket: { targetTokenId: tokenId, stolen },
    zeroFlipChargeBefore:
      doc.zeroFlipChargeBefore !== null ? doc.zeroFlipChargeBefore - PICKPOCKET_COST : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Corpse Explosion ends the turn (Push's shape): its own commit fn only
 *  because the blast's announce payload is richer than applyMkSimple's
 *  one-token slots. */
function applyMkCorpseExplosion(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyCorpseExplosion(doc.state, fromWirePower(doc.mk!), seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastCorpseExplosion: { tile: r.tile, struckTokenIds: r.struckTokenIds, sentHomeIds: r.sentHomeIds },
    lastWound: r.woundedTokenIds.length > 0 ? { tokenIds: r.woundedTokenIds } : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Warlock's Curse of Chains does NOT end the turn — Pickpocket's exact
 *  commit contract (see applyMkPickpocket): the SAME flip stays live and
 *  the move list is recomputed. The recompute is load-bearing here rather
 *  than merely uniform: the curse changes the VICTIM's stride, not the
 *  mover's, so the mover's own list is unchanged — but a Bulwark re-check
 *  against the live flip still has to run, and keeping the shape identical
 *  to every other turn-keeper is what stops the two servers drifting. */
function applyMkCurse(doc: RoomDoc, seat: PlayerId, tokenId: number, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const flip = doc.currentFlip!; // validated non-null (see validateUsePower)
  const power = applyCurse(fromWirePower(doc.mk!), tokenId, seat);
  const currentPowerMoves = getLegalPowerMoves(doc.state, power, flip);
  const bulwarkResult = tickBulwarkForReflip(doc.state, power, flip);
  const nextPower = bulwarkResult.power;
  const delta = nextPower.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    mk: toWirePower(nextPower),
    currentFlip: flip,
    currentPowerMoves,
    lastMovePlayer: doc.lastMovePlayer,
    lastBulwarkBlock: bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastCurse: { targetTokenId: tokenId },
    // A cast during a zero flip spends AFTER the flip commit banked the
    // grant's baseline — applyMkRevive's exact bookkeeping.
    zeroFlipChargeBefore:
      doc.zeroFlipChargeBefore !== null ? doc.zeroFlipChargeBefore - CURSE_COST : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Sacrifice ends the turn (Push's shape): its own commit fn only because
 *  it announces TWO deaths — the enemy killed and the mover's own stone
 *  given for it (server-selected, never re-derived client-side). The
 *  scoreboard counts the enemy kill only: giving your own stone is a
 *  price, not a capture. */
function applyMkSacrifice(doc: RoomDoc, seat: PlayerId, tokenId: number, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applySacrifice(doc.state, fromWirePower(doc.mk!), tokenId, seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: { ...doc.captures, [seat]: doc.captures[seat] + 1 },
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastSacrifice: { sacrificedTokenId: r.sacrificedTokenId, targetTokenId: tokenId },
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Blink ends the turn (Push's shape): a repositioning, no capture credit. */
function applyMkBlink(doc: RoomDoc, seat: PlayerId, tile: number, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyBlink(doc.state, fromWirePower(doc.mk!), tile, seat);
  const delta = r.power.charges[seat] - chargesBefore;
  const next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastBlink: { tokenId: r.tokenId, from: r.from, to: tile },
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Backstab ends the turn (Push's shape). A wound is not a capture: the
 *  scoreboard counts the kill only. */
function applyMkBackstab(doc: RoomDoc, seat: PlayerId, tokenId: number, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyBackstab(doc.state, fromWirePower(doc.mk!), tokenId, seat);
  const delta = r.power.charges[seat] - chargesBefore;
  const killed = r.woundedTokenId === null;
  const next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: { ...doc.captures, [seat]: doc.captures[seat] + (killed ? 1 : 0) },
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastBackstab: { targetTokenId: tokenId },
    lastWound: r.woundedTokenId !== null ? { tokenIds: [r.woundedTokenId] } : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Fel Storm ends the turn (its ultimate siblings' shape) — its own commit
 *  fn only because the announce payload is the dragged/crumbled id lists,
 *  not a single token slot. No capture credit: the storm displaces, and
 *  its rare thrall-crumble deaths are the possession rule collecting its
 *  own debt, not a kill the warlock scored. */
function applyMkFelStorm(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyFelStorm(doc.state, fromWirePower(doc.mk!), seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastFelStorm: { struckTokenIds: r.struckTokenIds, sentHomeIds: r.sentHomeIds },
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Hunter's Snare does NOT end the turn — Curse's exact commit contract
 *  (see applyMkCurse): same flip, move list recomputed. The recompute
 *  genuinely matters here: the trap occupies a tile, and while it doesn't
 *  change the mover's own legal moves, keeping the shape identical across
 *  every turn-keeper is what stops the two servers drifting. */
function applyMkSnare(doc: RoomDoc, seat: PlayerId, tile: number, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const flip = doc.currentFlip!; // validated non-null (see validateUsePower)
  const power = applySnare(fromWirePower(doc.mk!), tile, seat);
  const currentPowerMoves = getLegalPowerMoves(doc.state, power, flip);
  const bulwarkResult = tickBulwarkForReflip(doc.state, power, flip);
  const nextPower = bulwarkResult.power;
  const delta = nextPower.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    mk: toWirePower(nextPower),
    currentFlip: flip,
    currentPowerMoves,
    lastMovePlayer: doc.lastMovePlayer,
    lastBulwarkBlock: bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastSnare: { tile },
    zeroFlipChargeBefore:
      doc.zeroFlipChargeBefore !== null ? doc.zeroFlipChargeBefore - SNARE_COST : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Piercing Shot ends the turn (Push's shape). Its own commit fn because it
 *  takes no target from the client at all — the arrow's path picks the
 *  victim server-side — and its result splits into a kill or a wound (a
 *  mortal weapon, so a Blessing absorbs it). */
function applyMkPiercingShot(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyPiercingShot(doc.state, fromWirePower(doc.mk!), seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: r.killedTokenId !== null ? { ...doc.captures, [seat]: doc.captures[seat] + 1 } : doc.captures,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastPiercingShot: { killedTokenId: r.killedTokenId, woundedTokenId: r.woundedTokenId },
    lastWound: r.woundedTokenId !== null ? { tokenIds: [r.woundedTokenId] } : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Wild Hunt ends the turn (its ultimate siblings' shape) — its own commit
 *  fn because the payload is a frozen id list PLUS the wolf's kill, and the
 *  kill is the only part that scores. */
function applyMkWildHunt(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyWildHunt(doc.state, fromWirePower(doc.mk!), seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: r.killedTokenId !== null ? { ...doc.captures, [seat]: doc.captures[seat] + 1 } : doc.captures,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastWildHunt: { frozenTokenIds: r.frozenTokenIds, killedTokenId: r.killedTokenId },
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Reckless Swing ends the turn (Push's shape). Its own commit fn because
 *  the announce payload is a TRADE — what died and what the recoil cost —
 *  and the scoreboard must count only the enemy: the swinger going home is
 *  a price the barbarian paid, never a capture for the opponent. */
function applyMkRecklessSwing(doc: RoomDoc, seat: PlayerId, targetTokenId: number, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyRecklessSwing(doc.state, fromWirePower(doc.mk!), targetTokenId, seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures: r.killedTokenId !== null ? { ...doc.captures, [seat]: doc.captures[seat] + 1 } : doc.captures,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastRecklessSwing: {
      swingerTokenId: r.swingerTokenId,
      killedTokenId: r.killedTokenId,
      woundedTokenId: r.woundedTokenId,
      swingerSentHome: r.swingerSentHome,
    },
    lastWound: r.woundedTokenId !== null ? { tokenIds: [r.woundedTokenId] } : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Whirlwind ends the turn (Push's shape) — its own commit fn because the
 *  payload splits captured from merely shoved, and only the former score. */
function applyMkWhirlwind(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyWhirlwind(doc.state, fromWirePower(doc.mk!), seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures:
      r.capturedTokenIds.length > 0
        ? { ...doc.captures, [seat]: doc.captures[seat] + r.capturedTokenIds.length }
        : doc.captures,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastWhirlwind: {
      capturedTokenIds: r.capturedTokenIds,
      knockedTokenIds: r.knockedTokenIds,
      sentHomeIds: r.sentHomeIds,
    },
    lastWound: r.woundedTokenIds.length > 0 ? { tokenIds: r.woundedTokenIds } : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Bloodbath ends the turn (its ultimate siblings' shape) — its own commit
 *  fn because the charge kills an UNCAPPED number of stones, so the
 *  scoreboard takes the whole list. */
function applyMkBloodbath(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyBloodbath(doc.state, fromWirePower(doc.mk!), seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures:
      r.killedTokenIds.length > 0
        ? { ...doc.captures, [seat]: doc.captures[seat] + r.killedTokenIds.length }
        : doc.captures,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastBloodbath: { killedTokenIds: r.killedTokenIds, endedOn: r.endedOn },
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Bard's Inspire does NOT end the turn — Curse's exact commit contract
 *  (see applyMkCurse): same flip, move list recomputed. The recompute is
 *  genuinely load-bearing here, unlike for most turn-keepers: the stone
 *  just lit moves INSPIRE_BONUS further, so this turn's own move list
 *  really does change under it. */
function applyMkInspire(doc: RoomDoc, seat: PlayerId, tokenId: number, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const flip = doc.currentFlip!; // validated non-null (see validateUsePower)
  const power = applyInspire(fromWirePower(doc.mk!), tokenId, seat);
  const currentPowerMoves = getLegalPowerMoves(doc.state, power, flip);
  const bulwarkResult = tickBulwarkForReflip(doc.state, power, flip);
  const nextPower = bulwarkResult.power;
  const delta = nextPower.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    mk: toWirePower(nextPower),
    currentFlip: flip,
    currentPowerMoves,
    lastMovePlayer: doc.lastMovePlayer,
    lastBulwarkBlock: bulwarkResult.blockedIds.length > 0 ? { tokenIds: bulwarkResult.blockedIds } : null,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastInspire: { tokenId },
    zeroFlipChargeBefore:
      doc.zeroFlipChargeBefore !== null ? doc.zeroFlipChargeBefore - INSPIRE_COST : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Song of Haste ends the turn (Push's shape) — its own commit fn because
 *  the payload is a march plus whatever it ran over, and only the captures
 *  score. */
function applyMkSongOfHaste(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applySongOfHaste(doc.state, fromWirePower(doc.mk!), seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures:
      r.capturedIds.length > 0
        ? { ...doc.captures, [seat]: doc.captures[seat] + r.capturedIds.length }
        : doc.captures,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastSongOfHaste: { movedIds: r.movedIds, capturedIds: r.capturedIds },
    lastWound: r.woundedIds.length > 0 ? { tokenIds: r.woundedIds } : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Crescendo ends the turn (its ultimate siblings' shape) — lights the whole
 *  army AND marches it, so the payload carries both lists. */
function applyMkCrescendo(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyCrescendo(doc.state, fromWirePower(doc.mk!), seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    captures:
      r.capturedIds.length > 0
        ? { ...doc.captures, [seat]: doc.captures[seat] + r.capturedIds.length }
        : doc.captures,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastCrescendo: { inspiredIds: r.inspiredIds, movedIds: r.movedIds, capturedIds: r.capturedIds },
    lastWound: r.woundedIds.length > 0 ? { tokenIds: r.woundedIds } : null,
  };
  return commitFrame(next, now, stateEventOf(next));
}

/** Benediction ends the turn (its ultimate siblings' shape) — its own
 *  commit fn only because the announce payload is the blessed id list,
 *  not a single token slot. */
function applyMkBenediction(doc: RoomDoc, seat: PlayerId, now: number): RoomDoc {
  const chargesBefore = doc.mk!.charges[seat];
  const r = applyBenediction(doc.state, fromWirePower(doc.mk!), seat);
  const delta = r.power.charges[seat] - chargesBefore;
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state: r.state,
    mk: toWirePower(r.power),
    currentFlip: null,
    currentPowerMoves: null,
    lastMovePlayer: seat,
    lastChargeEvent: delta !== 0 ? { player: seat, delta } : null,
    lastBenediction: { tokenIds: r.blessedTokenIds },
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
    if (
      doc.mk.classes[mover] === "mage" &&
      (canReflipAgain(p, mover) || (doc.currentFlip !== null && doc.currentFlip !== 0 && getBlinkTiles(doc.state, p, mover).length > 0))
    ) {
      return AUTO_SKIP_WITH_RESCUE_MS; // human Mage gets a real Re-flip / Blink window
    }
    // The Necromancer has the SAME dead-flip rescue as the Mage: Revive
    // keeps the flip and recomputes the move list against the risen board
    // (the thrall may be the one that moves) — so a human with a castable
    // Revive gets the same window. Flip-zero stays a snappy skip: no
    // revive can conjure a legal move out of a zero.
    if (
      doc.mk.classes[mover] === "necromancer" &&
      doc.currentFlip !== null &&
      doc.currentFlip !== 0 &&
      (getReviveSpawnTile(doc.state, p, mover) !== null ||
        getCorpseExplosionTargets(doc.state, p, mover).length > 0)
    ) {
      return AUTO_SKIP_WITH_RESCUE_MS;
    }
    // A human Cleric with a dead flip but a castable Bless/Heal (both
    // turn-keeping — the cast banks real value before the skip lands, and
    // Benediction ends the turn outright) gets the same window. Flip-zero
    // stays a snappy skip, matching the necromancer's arm: the zero's
    // charge grant is its compensation, and the game's rhythm keeps zeros
    // fast.
    if (
      doc.mk.classes[mover] === "cleric" &&
      doc.currentFlip !== null &&
      doc.currentFlip !== 0 &&
      (getBlessTargets(doc.state, p, mover).length > 0 ||
        getHealTargets(doc.state, p, mover).length > 0 ||
        (doc.mk.ultimateReady[mover] && getBenedictionTargets(doc.state, p, mover).length > 0))
    ) {
      return AUTO_SKIP_WITH_RESCUE_MS;
    }
    // A human Rogue with a dead flip but a castable Pickpocket/Vanish (the
    // former turn-keeping, the latter turn-ending like Heal/Bulwark — same
    // "don't silently auto-skip a meaningful action" reasoning either way)
    // gets the same window.
    if (
      doc.mk.classes[mover] === "rogue" &&
      doc.currentFlip !== null &&
      doc.currentFlip !== 0 &&
      (getPickpocketTargets(doc.state, p, mover).length > 0 ||
        getBackstabTargets(doc.state, p, mover).length > 0 ||
        (doc.mk.charges[mover] >= VANISH_COST && getVanishTargets(doc.state, p, mover).length > 0) ||
        (doc.mk.ultimateReady[mover] && getGrandHeistTargets(doc.state, p, mover).length > 0))
    ) {
      return AUTO_SKIP_WITH_RESCUE_MS;
    }
    // A human Warlock with a dead flip but a castable Curse (turn-keeping)
    // or Sacrifice/Fel Storm (turn-ending, Heal/Benediction's shape) gets
    // the same window — same "don't silently auto-skip a meaningful
    // action" reasoning as every arm above. Flip-zero stays a snappy skip.
    if (
      doc.mk.classes[mover] === "warlock" &&
      doc.currentFlip !== null &&
      doc.currentFlip !== 0 &&
      (getCurseTargets(doc.state, p, mover).length > 0 ||
        getSacrificeTargets(doc.state, p, mover).length > 0 ||
        (doc.mk.ultimateReady[mover] && getFelStormTargets(doc.state, p, mover).length > 0))
    ) {
      return AUTO_SKIP_WITH_RESCUE_MS;
    }
    // A human Hunter with a dead flip but a castable Snare (turn-keeping)
    // or Hamstring/Wild Hunt (turn-ending) gets the same window — the same
    // "don't silently auto-skip a meaningful action" rule as every arm
    // above. Flip-zero stays a snappy skip.
    if (
      doc.mk.classes[mover] === "hunter" &&
      doc.currentFlip !== null &&
      doc.currentFlip !== 0 &&
      (getSnareTiles(doc.state, p, mover).length > 0 ||
        getPiercingShotTargets(doc.state, p, mover).length > 0 ||
        (doc.mk.ultimateReady[mover] && getWildHuntTargets(doc.state, p, mover).length > 0))
    ) {
      return AUTO_SKIP_WITH_RESCUE_MS;
    }
    // A human Barbarian with a dead flip but a castable swing/spin/charge —
    // all three turn-ending, all three worth more than a silent auto-skip.
    if (
      doc.mk.classes[mover] === "barbarian" &&
      doc.currentFlip !== null &&
      doc.currentFlip !== 0 &&
      (getRecklessSwingTargets(doc.state, p, mover).length > 0 ||
        getWhirlwindTargets(doc.state, p, mover).length > 0 ||
        (doc.mk.ultimateReady[mover] && getBloodbathTargets(doc.state, p, mover).length > 0))
    ) {
      return AUTO_SKIP_WITH_RESCUE_MS;
    }
    // A human Bard with a dead flip but a castable Inspire (turn-keeping —
    // and the buff can itself unstick the flip, since a lit stone moves
    // INSPIRE_BONUS further) or a payoff to sing gets the same window.
    if (
      doc.mk.classes[mover] === "bard" &&
      doc.currentFlip !== null &&
      doc.currentFlip !== 0 &&
      (getInspireTargets(doc.state, p, mover).length > 0 ||
        getSongOfHasteTargets(doc.state, p, mover).length > 0 ||
        (doc.mk.ultimateReady[mover] && getCrescendoTargets(doc.state, p, mover).length > 0))
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
      return applyMkSimple(doc, seat, "bulwark", action.tokenId, now, rand, action.reinforced ?? false);
    case "revive":
      return applyMkRevive(doc, seat, now);
    case "corpseExplosion":
      return applyMkCorpseExplosion(doc, seat, now);
    case "exhume":
      return applyMkSimple(doc, seat, "exhume", action.targetTokenId, now);
    case "bless":
      return applyMkBlessing(doc, seat, action.targetTokenId, now);
    case "heal":
      return applyMkSimple(doc, seat, "heal", action.targetTokenId, now);
    case "benediction":
      return applyMkBenediction(doc, seat, now);
    case "pickpocket":
      return applyMkPickpocket(doc, seat, action.targetTokenId, now);
    case "vanish":
      return applyMkSimple(doc, seat, "vanish", action.tokenId, now);
    case "grandHeist":
      return applyMkSimple(doc, seat, "grandHeist", action.targetTokenId, now);
    case "curse":
      return applyMkCurse(doc, seat, action.targetTokenId, now);
    case "sacrifice":
      return applyMkSacrifice(doc, seat, action.targetTokenId, now);
    case "backstab":
      return applyMkBackstab(doc, seat, action.targetTokenId, now);
    case "blink":
      return applyMkBlink(doc, seat, action.tile, now);
    case "felStorm":
      return applyMkFelStorm(doc, seat, now);
    case "snare":
      return applyMkSnare(doc, seat, action.tile, now);
    case "piercingShot":
      return applyMkPiercingShot(doc, seat, now);
    case "wildHunt":
      return applyMkWildHunt(doc, seat, now);
    case "recklessSwing":
      return applyMkRecklessSwing(doc, seat, action.targetTokenId, now);
    case "whirlwind":
      return applyMkWhirlwind(doc, seat, now);
    case "bloodbath":
      return applyMkBloodbath(doc, seat, now);
    case "inspire":
      return applyMkInspire(doc, seat, action.targetTokenId, now);
    case "songOfHaste":
      return applyMkSongOfHaste(doc, seat, now);
    case "crescendo":
      return applyMkCrescendo(doc, seat, now);
  }
}

/** Start a turn: flip the coins, deal the zero-flip charge, tick the
 *  thrall (BEFORE move gen — a crumbling thrall changes the board the
 *  move list and the Bulwark check must both read), then tick Bulwark. */
function commitTurnFlip(doc: RoomDoc, now: number, rand: () => number): RoomDoc {
  const flip = flipCoins(rand);
  let mk = doc.mk;
  let state = doc.state;
  let currentPowerMoves: PowerMove[] | null = null;
  let zeroFlipChargeBefore: number | null = null;
  let lastBulwarkBlock: RoomDoc["lastBulwarkBlock"] = null;
  let lastThrallExpired: RoomDoc["lastThrallExpired"] = null;
  let lastCurseExpired: RoomDoc["lastCurseExpired"] = null;
  let lastThaw: RoomDoc["lastThaw"] = null;
  let lastInspireFaded: RoomDoc["lastInspireFaded"] = null;
  if (doc.variant === "masterKiller" && mk) {
    let power = fromWirePower(mk);
    if (flip === 0) {
      zeroFlipChargeBefore = power.charges[state.currentPlayer];
      power = grantZeroFlipCharge(power, state.currentPlayer);
    }
    const thrallResult = tickThrallForNewTurn(state, power);
    state = thrallResult.state;
    power = thrallResult.power;
    if (thrallResult.expiredTokenId !== null) lastThrallExpired = { tokenId: thrallResult.expiredTokenId };
    // Curse expiry ticks BEFORE the move list, same as the thrall's: the
    // turn a curse runs out is a turn the freed stone moves its full
    // distance, not one more shackled turn.
    const curseResult = tickCurseForNewTurn(state, power);
    power = curseResult.power;
    if (curseResult.expiredTokenId !== null) lastCurseExpired = { tokenId: curseResult.expiredTokenId };
    // Freeze expiry, same rule and same reason as the curse's: the turn a
    // Hamstring runs out is a turn the stone actually moves.
    const thawResult = tickHamstringForNewTurn(state, power);
    power = thawResult.power;
    if (thawResult.thawedTokenIds.length > 0) lastThaw = { tokenIds: thawResult.thawedTokenIds };
    // Inspiration expiry, same slot and same reason: a stone whose song has
    // faded must move at its true speed on the turn it fades.
    const fadeResult = tickInspireForNewTurn(state, power);
    power = fadeResult.power;
    if (fadeResult.fadedTokenIds.length > 0) lastInspireFaded = { tokenIds: fadeResult.fadedTokenIds };
    currentPowerMoves = getLegalPowerMoves(state, power, flip);
    const bulwarkResult = tickBulwarkForNewTurn(state, power, flip);
    power = bulwarkResult.power;
    if (bulwarkResult.blockedIds.length > 0) lastBulwarkBlock = { tokenIds: bulwarkResult.blockedIds };
    mk = toWirePower(power);
  }
  let next: RoomDoc = {
    ...doc,
    ...CLEAR_SLOTS,
    state,
    currentFlip: flip,
    mk,
    currentPowerMoves,
    turns: doc.turns + 1,
    lastBulwarkBlock,
    lastThrallExpired,
    lastCurseExpired,
    lastThaw,
    lastInspireFaded,
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
