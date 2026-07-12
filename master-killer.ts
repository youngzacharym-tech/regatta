// ============================================================================
// master-killer.ts — rulebook for "Master Killer" mode, a class-powers
// variant of Regatta.
//
// SEPARATE from rulebook.ts on purpose. rulebook.ts stays the untouched
// classic game; this file layers class abilities on top by reimplementing
// its own move generator (see the note above getLegalPowerMoves for why a
// wrapper isn't possible) and importing only rulebook's plain data types.
//
// Same design principles as rulebook.ts:
//   - Pure functions. No I/O, no randomness (flipCoins is passed in/reused).
//   - GameState/PowerState are immutable — every function returns new ones.
//   - Tunable numbers are named constants at the top, not buried in logic.
// ============================================================================

import {
  BOARD_LAYOUT,
  PATH_LENGTH_PER_PLAYER,
  type GameState,
  type TokenState,
  type PlayerId,
} from "./rulebook.ts";

// rulebook.ts's otherPlayer() is a private helper, not exported — kept that
// way on purpose (Phase 1 promise: zero changes to existing files), so this
// file carries its own trivial copy instead of touching rulebook.ts.
function otherPlayerId(p: PlayerId): PlayerId {
  return p === "p1" ? "p2" : "p1";
}

// ============================================================================
// TUNABLES — adjust these, re-run batch-random-master-killer-games.ts, done.
// ============================================================================

/** Charges bank up to this many; further income while at the cap is a no-op. */
export const CHARGE_CAP = 2;

/** Archer's Push: how many tiles back along the TARGET's own path.
 *  (Was 2 — simulation showed Archer mirrors grinding to ~270 turns via a
 *  push-enables-snipe-grants-charge-fuels-more-push loop; 1 breaks the loop
 *  without making Push useless.) */
export const PUSH_DISTANCE = 1;

/** Mage's Ward: "all" = every one of the mage's tokens is warded while at
 *  CHARGE_CAP. "most-advanced" = only their furthest-along token is warded.
 *  (Was "all" — simulation showed Archer vs Mage at 29.5/70.5, since only
 *  Warriors can pierce a ward at all; "most-advanced" narrows the shield to
 *  one token so non-Warriors have more to work with.) */
export type WardScope = "all" | "most-advanced";
export const WARD_SCOPE: WardScope = "most-advanced";

// ============================================================================
// TYPES
// ============================================================================

export type PlayerClass = "archer" | "mage" | "warrior";

export interface PowerState {
  classes: Record<PlayerId, PlayerClass>;
  /** Banked charges, 0..CHARGE_CAP, per player. */
  charges: Record<PlayerId, number>;
  /** Token ids granted Warrior Shieldbreaker's transient safety — cleared
   *  the moment that specific token next moves (its own, or captured). */
  safeTokens: Set<number>;
  /** Guards Mage's Re-flip to once per turn. Reset whenever a fresh flip
   *  is dealt (a new turn, or after auto-skip). */
  reflipUsedThisTurn: boolean;
}

/** Superset of rulebook.Move — same fields, plus power-derived ones. */
export interface PowerMove {
  tokenId: number;
  from: number;
  to: number;
  captures: number[];
  /** Archer Snipe: 0 or 1 extra captured token id, free of charge. */
  bonusCaptures: number[];
  landsOnShield: boolean;
  causesWin: boolean;
  /** True if the mover is a Warrior and this move's landing tile is a
   *  Mage-warded (non-shield) enemy — Shieldbreaker triggers automatically
   *  as part of taking this move, no separate action needed. */
  breaksWard: boolean;
  /** True if a Warrior could spend a charge to Charge through this move
   *  (from >= 0, clear lane of own tokens, at least implicitly meaningful
   *  even if chargeSweepCaptures ends up empty). */
  chargeAvailable: boolean;
  /** Precomputed: enemies on contested tiles strictly between from and to
   *  that a Charge would additionally capture. Only meaningful when
   *  chargeAvailable is true. */
  chargeSweepCaptures: number[];
}

export type PowerAction =
  | { kind: "move"; move: PowerMove }
  | { kind: "push"; targetTokenId: number }
  | { kind: "reflip" }
  | { kind: "charge"; move: PowerMove };

// ============================================================================
// STATE
// ============================================================================

export function initialPowerState(): PowerState {
  return {
    classes: { p1: "archer", p2: "archer" }, // placeholder until picked
    charges: { p1: 0, p2: 0 },
    safeTokens: new Set(),
    reflipUsedThisTurn: false,
  };
}

/** Called once each turn a fresh flip is dealt (new turn or post-skip). */
export function resetTurnFlags(power: PowerState): PowerState {
  return { ...power, reflipUsedThisTurn: false };
}

function isMostAdvanced(state: GameState, token: TokenState): boolean {
  const mine = state.tokens.filter((t) => t.owner === token.owner);
  const best = Math.max(...mine.map((t) => t.position));
  return token.position === best && token.position >= 0;
}

/** Is this token currently protected by its owner's Ward? Derived, not
 *  stored — see the Mage kit note in the plan for why it's gated at the
 *  full charge cap rather than any-charge. */
export function isWarded(
  state: GameState,
  power: PowerState,
  token: TokenState,
): boolean {
  if (power.classes[token.owner] !== "mage") return false;
  if (power.charges[token.owner] < CHARGE_CAP) return false;
  if (WARD_SCOPE === "most-advanced") return isMostAdvanced(state, token);
  return true;
}

/** Is this token currently protected by a real shield TILE (base-game rule,
 *  same as rulebook's Q5a — every class respects this, including Warriors). */
function onShieldTile(token: TokenState): boolean {
  if (token.position < 0 || token.position >= PATH_LENGTH_PER_PLAYER) return false;
  return BOARD_LAYOUT[token.position].type === "shield";
}

/** Is this token currently protected by Warrior Shieldbreaker's transient
 *  "safe until it next moves" grant? Unlike Ward, nothing pierces this —
 *  not even another Warrior's Shieldbreaker — it's a simple temporary
 *  shield, not a re-breakable one. */
function hasTransientSafety(power: PowerState, token: TokenState): boolean {
  return power.safeTokens.has(token.id);
}

/** Universal "is this token capturable/pushable/sweepable AT ALL right
 *  now" check, used everywhere EXCEPT the main landing-capture path (which
 *  needs to distinguish ward-protection specifically, since that's the one
 *  case a Warrior's landing can pierce via Shieldbreaker). Shield tiles and
 *  transient safety block every class with no exception. */
function isProtected(state: GameState, power: PowerState, token: TokenState): boolean {
  return onShieldTile(token) || hasTransientSafety(power, token) || isWarded(state, power, token);
}

function addCharge(power: PowerState, player: PlayerId): PowerState {
  const current = power.charges[player];
  if (current >= CHARGE_CAP) return power;
  return { ...power, charges: { ...power.charges, [player]: current + 1 } };
}

export function grantZeroFlipCharge(power: PowerState, mover: PlayerId): PowerState {
  return addCharge(power, mover);
}

// ============================================================================
// MOVE GENERATION
//
// Reimplements rulebook.getLegalMoves()'s from/to/occupancy walk rather than
// wrapping it — Ward changes LEGALITY (a warded-but-non-shield landing must
// flip from "legal capture" to "illegal" for non-Warriors), which a wrapper
// around the classic function can't express without changing its signature.
// Kept intentionally close in shape/order to the original so a side-by-side
// diff stays readable; see the anti-drift regression test for the safety
// net this duplication needs.
// ============================================================================

export function getLegalPowerMoves(
  state: GameState,
  power: PowerState,
  flip: number,
): PowerMove[] {
  if (state.winner !== null) return [];
  if (flip <= 0) return [];

  const player = state.currentPlayer;
  const cls = power.classes[player];
  const moves: PowerMove[] = [];

  for (const token of state.tokens) {
    if (token.owner !== player) continue;
    if (token.position >= PATH_LENGTH_PER_PLAYER) continue; // already escaped

    const from = token.position;
    const to = from === -1 ? flip - 1 : from + flip;

    // Escape — identical to the classic rule, no power interacts with it.
    if (to >= PATH_LENGTH_PER_PLAYER - 1) {
      if (to !== PATH_LENGTH_PER_PLAYER - 1) continue;
      const remaining = state.tokens.filter(
        (t) => t.owner === player && t.id !== token.id && t.position < PATH_LENGTH_PER_PLAYER,
      );
      moves.push({
        tokenId: token.id,
        from,
        to: PATH_LENGTH_PER_PLAYER,
        captures: [],
        bonusCaptures: [],
        landsOnShield: false,
        causesWin: remaining.length === 0,
        breaksWard: false,
        chargeAvailable: false,
        chargeSweepCaptures: [],
      });
      continue;
    }

    const destTile = BOARD_LAYOUT[to];
    const occupants = state.tokens.filter(
      (t) => t.position === to && t.id !== token.id && (destTile.isContested || t.owner === player),
    );
    const self = occupants.find((t) => t.owner === player);
    const enemy = occupants.find((t) => t.owner !== player);

    if (self) continue; // own-token blocks, same as classic

    let captures: number[] = [];
    let breaksWard = false;

    if (enemy) {
      // Shield tiles and transient safety block EVERY class, no exception.
      if (onShieldTile(enemy) || hasTransientSafety(power, enemy)) continue;
      if (isWarded(state, power, enemy)) {
        if (cls !== "warrior") continue; // blocked for everyone but a Warrior
        breaksWard = true; // Shieldbreaker: legal, captures, grants safety below
        captures = [enemy.id];
      } else {
        captures = [enemy.id]; // normal contested capture
      }
    }

    // Archer Snipe (passive, free): a second unprotected enemy exactly one
    // tile further along the shared contested row.
    const bonusCaptures: number[] = [];
    if (cls === "archer" && to + 1 <= 11) {
      const sniped = state.tokens.find(
        (t) => t.position === to + 1 && t.owner !== player && t.id !== enemy?.id,
      );
      if (sniped && !isProtected(state, power, sniped)) {
        bonusCaptures.push(sniped.id);
      }
    }

    // Warrior Charge availability: from must be on-board and every
    // intermediate contested tile must be clear of the Warrior's own
    // tokens. The sweep itself only touches contested tiles strictly
    // between from and to, and — like a normal move — never crosses a
    // shield tile or a warded token.
    let chargeAvailable = false;
    const chargeSweepCaptures: number[] = [];
    if (cls === "warrior" && from >= 0) {
      let laneClear = true;
      for (let i = from + 1; i < to; i++) {
        const tile = BOARD_LAYOUT[i];
        if (!tile.isContested) continue; // sweep only matters on shared tiles
        const occ = state.tokens.filter((t) => t.position === i && t.id !== token.id);
        if (occ.some((t) => t.owner === player)) {
          laneClear = false;
          break;
        }
        const foe = occ.find((t) => t.owner !== player);
        if (foe && !isProtected(state, power, foe)) {
          chargeSweepCaptures.push(foe.id);
        }
      }
      chargeAvailable = laneClear;
    }

    moves.push({
      tokenId: token.id,
      from,
      to,
      captures,
      bonusCaptures,
      landsOnShield: destTile.type === "shield",
      causesWin: false,
      breaksWard,
      chargeAvailable,
      chargeSweepCaptures,
    });
  }

  return moves;
}

// ============================================================================
// APPLYING MOVES / ACTIONS
// ============================================================================

/** Shared plumbing: send a set of token ids to reserve, advance the mover,
 *  clear any of their SPENT (stale, prior-turn) Shieldbreaker safety, grant
 *  fresh safety if THIS move just broke a ward, grant a charge for a
 *  capturing/shield-landing move, hand the turn to the opponent (or keep it
 *  on a shield landing), and reset per-turn flags for the next flip.
 *
 *  Ordering matters: stale safety is cleared BEFORE a fresh grant is added,
 *  never after — otherwise a same-turn Shieldbreaker grant would be wiped
 *  out by its own move's stale-safety cleanup before ever being returned. */
function resolveTurn(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
  tokenId: number,
  to: number,
  allCaptures: number[],
  landsOnShield: boolean,
  causesWin: boolean,
  grantsSafety: boolean,
): { state: GameState; power: PowerState } {
  const tokens = state.tokens.map((t) => {
    if (t.id === tokenId) return { ...t, position: to };
    if (allCaptures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });

  let safeTokens = power.safeTokens;
  if (safeTokens.has(tokenId) || allCaptures.some((id) => safeTokens.has(id))) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(tokenId); // this token moved — any OLD safety it carried is spent
    for (const id of allCaptures) safeTokens.delete(id); // captured tokens carry none forward
  }
  if (grantsSafety) {
    safeTokens = new Set(safeTokens);
    safeTokens.add(tokenId); // fresh grant, added AFTER the stale-clear above
  }

  let nextPower: PowerState = { ...power, safeTokens };
  if (allCaptures.length > 0 || landsOnShield) {
    nextPower = addCharge(nextPower, mover);
  }

  const extraTurn = landsOnShield;
  const nextState: GameState = {
    tokens,
    currentPlayer: extraTurn ? mover : otherPlayerId(mover),
    lastFlip: null,
    winner: causesWin ? mover : null,
    extraTurn,
  };
  return { state: nextState, power: resetTurnFlags(nextPower) };
}

export function applyPowerMove(
  state: GameState,
  power: PowerState,
  move: PowerMove,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const allCaptures = [...move.captures, ...move.bonusCaptures];
  return resolveTurn(
    state,
    power,
    mover,
    move.tokenId,
    move.to,
    allCaptures,
    move.landsOnShield,
    move.causesWin,
    move.breaksWard,
  );
}

/** Warrior's Charge: same move, but the sweep captures ride along too, and
 *  (like any move) a Shieldbreaker landing still grants its safety. */
export function applyCharge(
  state: GameState,
  power: PowerState,
  move: PowerMove,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const allCaptures = [...move.captures, ...move.bonusCaptures, ...move.chargeSweepCaptures];
  const spent: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 },
  };
  // resolveTurn grants a charge back if this capture-laden move qualifies
  // under the normal economy (it almost always will) — that's correct, not
  // a double-spend: the -1 above IS the Charge action's cost, separate from
  // whatever this move's own capture(s) earn.
  return resolveTurn(
    state,
    spent,
    mover,
    move.tokenId,
    move.to,
    allCaptures,
    move.landsOnShield,
    move.causesWin,
    move.breaksWard,
  );
}

/** Archer's Push: valid targets are unprotected enemy tokens on a contested
 *  tile. Spends the turn (no token of the pusher's moves). Deliberately
 *  never grants a charge back, even in the knocked-overboard case — Push is
 *  a repositioning tool, not a capture tool, and its cost is meant to be a
 *  clean 1-charge spend with no chance to chain into a refund. */
export function getPushTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => t.owner === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => !isProtected(state, power, t))
    .map((t) => t.id);
}

export function applyPush(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const rawTo = target.position - PUSH_DISTANCE;
  const collides = state.tokens.some(
    (t) => t.id !== targetTokenId && t.owner === target.owner && t.position === rawTo,
  );
  const landing = collides || rawTo < 0 ? -1 : rawTo;

  const tokens = state.tokens.map((t) => (t.id === targetTokenId ? { ...t, position: landing } : t));
  let safeTokens = power.safeTokens;
  if (safeTokens.has(targetTokenId)) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(targetTokenId);
  }
  const spentPower: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 },
    safeTokens,
  };
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(spentPower) };
}

/** Mage's Re-flip: spends a charge, does NOT end the turn — the caller
 *  re-rolls with flipCoins() and recomputes legal moves against the same
 *  (unmoved) GameState. Guarded to once per turn by reflipUsedThisTurn. */
export function applyReflip(power: PowerState, mover: PlayerId): PowerState {
  return {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 },
    reflipUsedThisTurn: true,
  };
}
