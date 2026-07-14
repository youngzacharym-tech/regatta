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

/** Warrior's Charge sweep: how many EXTRA enemies it can capture beyond the
 *  primary landing tile, in a single move. Matches Snipe's own bonus-capture
 *  ceiling (1) on principle — no class's single move should out-capture the
 *  others by more than one extra. (Was uncapped — a bot-quality bug meant
 *  Warriors almost never spent Charge on a real multi-capture sweep, so the
 *  ceiling never mattered in practice; once that bug was fixed, an uncapped
 *  sweep made Charge worth far more per use than anything in Archer's kit,
 *  flipping archer-vs-warrior from 51.6/48.4 to 43.5/56.5 warrior-favored.) */
export const CHARGE_SWEEP_CAP = 1;

/** Mage's Ward: "all" = every one of the mage's tokens is warded while at
 *  CHARGE_CAP. "most-advanced" = only their furthest-along token is warded.
 *  (Was "all" — simulation showed Archer vs Mage at 29.5/70.5, since only
 *  Warriors can pierce a ward at all; "most-advanced" narrows the shield to
 *  one token so non-Warriors have more to work with.) */
export type WardScope = "all" | "most-advanced";
export const WARD_SCOPE: WardScope = "most-advanced";

/** Archer's Push can target a warded token (previously impossible — Push
 *  used to treat Ward as full immunity, same as everyone else). This is the
 *  charge cost for pushing a WARDED target specifically; a normal push still
 *  costs 1.
 *  (Was 2 — the "base reposition (1) + piercing Ward (1 more)" framing, on
 *  the theory that draining the whole CHARGE_CAP bank in one shot suits
 *  bypassing the game's strongest defensive ability. Simulation showed 2
 *  brought Archer vs Mage from 30.6/69.3 to 37.6/62.4 — a real improvement,
 *  but still the widest margin of the three matchups (24.8 pts, vs ~17-21
 *  for the other two edges). Dropping to 1 instead brought it to 40.2/59.8
 *  (19.6 pts) — landing right in line with archer-vs-warrior (19.8) and
 *  mage-vs-warrior (15.0), the most even the whole RPS triangle has been.
 *  Kept at 1: same cost as a normal push, still gated on `charges >=
 *  PUSH_WARD_COST` so it scales cleanly if ever retuned back up.) */
export const PUSH_WARD_COST = 1;

/** How far a Push knocks back a WARDED target specifically — a normal push
 *  still uses PUSH_DISTANCE. PUSH_WARD_COST is already at its floor (1, same
 *  as a normal push), so this is the next lever: a bigger knockback doesn't
 *  touch Ward's actual promise (still fully uncapturable — Push never
 *  captures), it just makes the one thing Archer CAN do to a warded token
 *  hit harder. Scoped by construction to matchups against a Mage (isWarded
 *  is never true otherwise), so archer-mirror/archer-vs-warrior can't drift
 *  from this — see the isWarded branch in applyPush.
 *  (Tried 2: archer-vs-mage barely moved, 34.0/66.0 -> 35.8/64.2 — the
 *  contested zone is only 8 tiles, so a 2-tile shove rarely crosses back
 *  into the private lane. Tried 4: overshot to 55.1/44.9 (archer favored).
 *  Landed on 3: 46.6/53.4 on a 5000-game sample — now the TIGHTEST margin
 *  in the whole triangle (mage-vs-warrior, untouched by this change, is
 *  the widest at 19.2 and is the next open balance thread). Confirms the
 *  scoping claim too: archer-vs-warrior and archer-mirror held flat across
 *  every value tried, exactly as expected since isWarded can't be true
 *  without a Mage on the other side.) */
export const PUSH_WARD_DISTANCE = 3;

/** Ultimates: how many CONSECUTIVE shield-tile landings, within one unbroken
 *  turn-chain, it takes to earn a class's ultimate. Shared by all three
 *  classes — Archer's Rain of Arrows fires immediately on the 3rd landing;
 *  Mage's and Warrior's ultimates (not yet built) instead bank an
 *  ultimateReady flag to spend later. Only 3 shield tiles exist on the whole
 *  board, so this is rare by construction even at 3.
 *  (Balance-sim confirmed at 3, 5000 games/matchup against a freshly
 *  captured pre-change baseline: rainOfArrows/g stayed at 0.007-0.016 —
 *  fires in roughly 1-in-100 games, confirming the rarity — while every
 *  matchup's win split moved less than ~1.5 points from baseline, well
 *  inside normal run-to-run sampling noise (warrior mirror, which should be
 *  mathematically untouched since Rain of Arrows never applies there,
 *  settled to an exact 50.0/50.0). Matchups not involving an Archer showed
 *  rainOfArrows/g=0.0000 exactly, confirming Mage/Warrior's banked
 *  ultimateReady flag has zero gameplay leakage since nothing consumes it
 *  yet. No retuning needed at 3.) */
export const ULTIMATE_STREAK = 3;

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
  /** Consecutive shield-tile landings within one unbroken turn-chain, 0-2
   *  (fires/banks and resets to 0 the instant it would become
   *  ULTIMATE_STREAK). Shared by all three classes. Deliberately NOT reset
   *  by resetTurnFlags — that fires on every resolved turn, including the
   *  shield landing's own extra turn, which is exactly the turn this streak
   *  has to survive. Only cleared by resolveShieldStreak (a non-landing
   *  move/charge that ends the turn), applyPush (never lands the mover on a
   *  shield), or breakShieldStreak (called directly by the server's
   *  auto-skip paths, which resolve a turn-end without going through
   *  resolveTurn at all — same shape of problem zeroFlipChargeBefore in
   *  referee.ts/api/ws.ts already solves for the charge economy). */
  shieldStreak: Record<PlayerId, number>;
  /** True once a Mage or Warrior has completed the shield-streak combo —
   *  their ultimate (not yet built) is banked and spendable on a future
   *  turn of their choosing, unlike Archer's, which resolves immediately
   *  and never sets this. Persists indefinitely until spent: never touched
   *  by resetTurnFlags, and not yet consumed by anything (no ultimate
   *  action exists yet), so it just sits true once earned. */
  ultimateReady: Record<PlayerId, boolean>;
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
  | { kind: "charge"; move: PowerMove }
  | { kind: "blinkStrike"; targetTokenId: number }
  | { kind: "warpath"; targetTokenId: number };

// ============================================================================
// STATE
// ============================================================================

export function initialPowerState(): PowerState {
  return {
    classes: { p1: "archer", p2: "archer" }, // placeholder until picked
    charges: { p1: 0, p2: 0 },
    safeTokens: new Set(),
    reflipUsedThisTurn: false,
    shieldStreak: { p1: 0, p2: 0 },
    ultimateReady: { p1: false, p2: false },
  };
}

/** Called once each turn a fresh flip is dealt (new turn or post-skip). */
export function resetTurnFlags(power: PowerState): PowerState {
  return { ...power, reflipUsedThisTurn: false };
}

/** On-board only (0 <= position < PATH_LENGTH_PER_PLAYER) — escaped tokens
 *  sit at position 15, which would otherwise always outrank real board
 *  positions and permanently (and pointlessly — an escaped token can't be
 *  captured) hog "most advanced", including multiple escaped tokens tying
 *  and warding simultaneously once more than one has come home. */
function isMostAdvanced(state: GameState, token: TokenState): boolean {
  if (token.position < 0 || token.position >= PATH_LENGTH_PER_PLAYER) return false;
  const mine = state.tokens.filter(
    (t) => t.owner === token.owner && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return false;
  const best = Math.max(...mine.map((t) => t.position));
  return token.position === best;
}

/** Mage's Blink Strike ultimate always moves the mover's most-advanced
 *  on-board token (the same one Ward would protect) — null if they have no
 *  on-board tokens at all. */
function findMostAdvancedToken(state: GameState, mover: PlayerId): TokenState | null {
  const mine = state.tokens.filter(
    (t) => t.owner === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => (t.position > best.position ? t : best));
}

/** Warrior's Warpath ultimate always moves the mover's LEAST-advanced
 *  on-board token — the one that benefits most from an instant reposition —
 *  null if they have no on-board tokens at all. */
function findLeastAdvancedToken(state: GameState, mover: PlayerId): TokenState | null {
  const mine = state.tokens.filter(
    (t) => t.owner === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => (t.position < best.position ? t : best));
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
 *  case a Warrior's landing can pierce via Shieldbreaker) and Push (which
 *  can also pierce Ward, at a price — see getPushTargets/pushCost). Shield
 *  tiles and transient safety block every class with no exception. */
function isProtected(state: GameState, power: PowerState, token: TokenState): boolean {
  return onShieldTile(token) || hasTransientSafety(power, token) || isWarded(state, power, token);
}

/** What a Push against this specific target will cost: PUSH_WARD_COST if
 *  it's currently warded, 1 otherwise. Evaluated against the pre-push
 *  state/target, since isWarded is derived from live board position. */
function pushCost(state: GameState, power: PowerState, target: TokenState): number {
  return isWarded(state, power, target) ? PUSH_WARD_COST : 1;
}

/** How far a Push against this specific target knocks it back:
 *  PUSH_WARD_DISTANCE if it's currently warded, PUSH_DISTANCE otherwise. */
function pushDistance(state: GameState, power: PowerState, target: TokenState): number {
  return isWarded(state, power, target) ? PUSH_WARD_DISTANCE : PUSH_DISTANCE;
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
    // tile further along the shared contested row. MUST check that to+1 is
    // itself a contested tile, not just "<= 11" — tiles 0-3 and 12-14 are
    // each player's own private lane, where the SAME index numbers a
    // completely different physical square for each owner (this is what
    // makes "home base" safe at all). Without this check, an Archer sitting
    // in their own private lane could snipe an enemy token that merely
    // shares a numeric index in ITS OWN separate private lane — a real bug
    // found via playtest confusion ("why are we attacking tokens on the
    // home base?"), confirmed with a repro: archer enters at to=0, enemy
    // sits at their own private position 1, Snipe fired anyway.
    const bonusCaptures: number[] = [];
    if (cls === "archer" && BOARD_LAYOUT[to + 1].isContested) {
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
    // shield tile or a token under Warrior Shieldbreaker's own transient
    // safety. A WARDED token in the sweep IS captured, same as a direct
    // landing — Shieldbreaker's whole identity is "Warriors pierce Ward,"
    // so the sweep shouldn't quietly disagree with that just because the
    // token is in the middle of the lane instead of the landing tile.
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
        if (
          foe &&
          chargeSweepCaptures.length < CHARGE_SWEEP_CAP &&
          !onShieldTile(foe) &&
          !hasTransientSafety(power, foe)
        ) {
          chargeSweepCaptures.push(foe.id);
        }
        // Keep scanning past the cap anyway — laneClear still needs the
        // WHOLE lane checked for the Warrior's own blocking tokens, even
        // once no more captures will be recorded.
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

/** Rain of Arrows' target pool (Archer's ultimate only): enemy tokens,
 *  on-board, anywhere in the contested zone — deliberately skipping
 *  onShieldTile/isWarded, since punching through both is the whole point.
 *  Only hasTransientSafety still guards against it. */
export function getRainOfArrowsTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => t.owner === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => !hasTransientSafety(power, t))
    .map((t) => t.id);
}

/** Breaks a player's shield-streak combo — called both from applyPush
 *  (which never lands the mover on a shield, so it always ends any live
 *  streak) and directly by the server's auto-skip paths (referee.ts/
 *  api/ws.ts resolve a turn-end without ever going through resolveTurn,
 *  same shape of problem grantZeroFlipCharge already solves for the charge
 *  economy). No class gate needed — every class tracks this now. */
export function breakShieldStreak(power: PowerState, player: PlayerId): PowerState {
  if (power.shieldStreak[player] === 0) return power;
  return { ...power, shieldStreak: { ...power.shieldStreak, [player]: 0 } };
}

/** Advances or breaks the mover's shield-streak for this resolving action,
 *  and resolves whatever completing it means for their class. Archer's
 *  ultimate (Rain of Arrows) fires immediately; Mage/Warrior instead bank
 *  ultimateReady for a not-yet-built active ability to spend later. */
function resolveShieldStreak(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
  landsOnShield: boolean,
  allCaptures: number[],
  rand: () => number,
): { power: PowerState; rainOfArrows: { targetTokenId: number | null } | null } {
  if (!landsOnShield) return { power: breakShieldStreak(power, mover), rainOfArrows: null };

  const next = power.shieldStreak[mover] + 1;
  if (next < ULTIMATE_STREAK) {
    return { power: { ...power, shieldStreak: { ...power.shieldStreak, [mover]: next } }, rainOfArrows: null };
  }

  // Completed the combo — consumed either way, regardless of class or target availability.
  const reset: PowerState = { ...power, shieldStreak: { ...power.shieldStreak, [mover]: 0 } };
  const cls = power.classes[mover];
  if (cls !== "archer") {
    return { power: { ...reset, ultimateReady: { ...reset.ultimateReady, [mover]: true } }, rainOfArrows: null };
  }

  const pool = getRainOfArrowsTargets(state, reset, mover).filter((id) => !allCaptures.includes(id));
  if (pool.length === 0) return { power: reset, rainOfArrows: { targetTokenId: null } };
  const picked = pool[Math.floor(rand() * pool.length)];
  return { power: reset, rainOfArrows: { targetTokenId: picked } };
}

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
  rand: () => number = Math.random,
): { state: GameState; power: PowerState; rainOfArrows: { targetTokenId: number | null } | null } {
  const streakResult = resolveShieldStreak(state, power, mover, landsOnShield, allCaptures, rand);
  power = streakResult.power;
  const rainOfArrows = streakResult.rainOfArrows;
  const finalCaptures =
    rainOfArrows?.targetTokenId != null ? [...allCaptures, rainOfArrows.targetTokenId] : allCaptures;

  const tokens = state.tokens.map((t) => {
    if (t.id === tokenId) return { ...t, position: to };
    if (finalCaptures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });

  let safeTokens = power.safeTokens;
  if (safeTokens.has(tokenId) || finalCaptures.some((id) => safeTokens.has(id))) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(tokenId); // this token moved — any OLD safety it carried is spent
    for (const id of finalCaptures) safeTokens.delete(id); // captured tokens carry none forward
  }
  if (grantsSafety) {
    safeTokens = new Set(safeTokens);
    safeTokens.add(tokenId); // fresh grant, added AFTER the stale-clear above
  }

  let nextPower: PowerState = { ...power, safeTokens };
  if (finalCaptures.length > 0 || landsOnShield) {
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
  return { state: nextState, power: resetTurnFlags(nextPower), rainOfArrows };
}

export function applyPowerMove(
  state: GameState,
  power: PowerState,
  move: PowerMove,
  mover: PlayerId,
  rand: () => number = Math.random,
): { state: GameState; power: PowerState; rainOfArrows: { targetTokenId: number | null } | null } {
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
    rand,
  );
}

/** Warrior's Charge: same move, but the sweep captures ride along too, and
 *  (like any move) a Shieldbreaker landing still grants its safety. */
export function applyCharge(
  state: GameState,
  power: PowerState,
  move: PowerMove,
  mover: PlayerId,
  rand: () => number = Math.random,
): { state: GameState; power: PowerState; rainOfArrows: { targetTokenId: number | null } | null } {
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
    rand,
  );
}

/** Archer's Push: valid targets are enemy tokens on a contested tile that
 *  aren't shield/transient-safety blocked. A warded token is ALSO a valid
 *  target, but only if the Archer can afford PUSH_WARD_COST — baking
 *  affordability into the target list itself (rather than a separate
 *  legality branch at the call site) so the UI's target highlights and the
 *  server's legality check can never drift apart. Ends the turn — no token
 *  of the pusher's moves (see applyPush's history note for why granting an
 *  extra turn here was tried and reverted).
 *
 *  Refunds its charge (see applyPush) specifically when it sends the target
 *  all the way home to reserve — that outcome is functionally a capture
 *  (the token is off the board, back to square one), so it earns the same
 *  refund any other capturing action gets under the shared charge economy.
 *  A partial shove that leaves the target on the board is NOT a capture and
 *  never refunds. */
export function getPushTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => t.owner === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => !onShieldTile(t) && !hasTransientSafety(power, t))
    .filter((t) => !isWarded(state, power, t) || power.charges[mover] >= PUSH_WARD_COST)
    .map((t) => t.id);
}

export function applyPush(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const cost = pushCost(state, power, target);
  const rawTo = target.position - pushDistance(state, power, target);
  // Same-owner tokens share a lane everywhere, so any position match is a
  // real collision. Different-owner tokens only physically share a tile in
  // the contested zone (positions 4-11 are the SAME square for both
  // players' path numbering) — a match outside it is two different tiles
  // that just happen to have the same index, not a collision. Without the
  // contested check here, a push could silently land an enemy token on top
  // of the pusher's own token (both owners, same contested tile), which
  // getLegalPowerMoves's single-token-per-tile assumptions can't handle.
  const contestedLanding = rawTo >= 0 && rawTo < PATH_LENGTH_PER_PLAYER && BOARD_LAYOUT[rawTo].isContested;
  const collides = state.tokens.some(
    (t) =>
      t.id !== targetTokenId &&
      t.position === rawTo &&
      (t.owner === target.owner || contestedLanding),
  );
  const landing = collides || rawTo < 0 ? -1 : rawTo;
  const sendsHome = landing === -1; // functionally a capture — refund below

  const tokens = state.tokens.map((t) => (t.id === targetTokenId ? { ...t, position: landing } : t));
  let safeTokens = power.safeTokens;
  if (safeTokens.has(targetTokenId)) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(targetTokenId);
  }
  let spentPower: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - cost },
    safeTokens,
  };
  if (sendsHome) spentPower = addCharge(spentPower, mover);
  spentPower = breakShieldStreak(spentPower, mover); // Push never lands the mover on a shield
  // TRIED AND REVERTED: granting Push an extra turn (same mechanism as a
  // shield-tile landing — currentPlayer stays the mover) was meant to stop
  // Push from costing the Archer's own board progress, matching how
  // Warrior's Charge advances-while-capturing and Mage's Re-flip doesn't
  // end the turn at all. It compounds instead of just offsetting: a fully
  // charged Archer could chain 2 free pushes (CHARGE_CAP) THEN still make a
  // real move, 3 actions against the opponent's 1, every single round.
  // Result: archer-vs-mage 95.3/4.7, archer-vs-warrior 91.8/8.2 — nowhere
  // close to a fix, a total blowout. Reverted to ending the turn normally.
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

// ============================================================================
// ULTIMATES — see ULTIMATE_STREAK. Archer's Rain of Arrows (above) is
// passive and fully automatic; Mage's Blink Strike and Warrior's Warpath
// are active — completing the shield-streak combo banks ultimateReady, and
// these two are what a Mage/Warrior spends it on. Both auto-select WHICH of
// the mover's own tokens relocates (Mage: most-advanced/Ward-carrying,
// Warrior: least-advanced — the one that benefits most from a free
// reposition) rather than letting the player choose a source token, keeping
// the target-selection UI identical to Push's "tap one target" flow.
// ============================================================================

/** Mage's Blink Strike ultimate: valid targets are the same as Rain of
 *  Arrows (contested-zone enemies, bypassing shield tiles and Ward, but not
 *  transient safety) — reused directly since the underlying "who's
 *  vulnerable to a shield/ward-piercing strike" rule is identical. Empty if
 *  the mover has no on-board token to relocate at all. */
export function getBlinkStrikeTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (!findMostAdvancedToken(state, mover)) return [];
  return getRainOfArrowsTargets(state, power, mover);
}

/** Warrior's Warpath ultimate: same target eligibility as Blink Strike —
 *  the sweep along the way (see applyWarpath) uses the same rule too.
 *  Empty if the mover has no on-board token to relocate at all. */
export function getWarpathTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (!findLeastAdvancedToken(state, mover)) return [];
  return getRainOfArrowsTargets(state, power, mover);
}

/** Mage's Blink Strike: instantly relocates the mover's most-advanced
 *  on-board token onto the target's tile, capturing it — bypassing shield
 *  tiles and Ward, same as Rain of Arrows, but not transient safety (see
 *  getBlinkStrikeTargets). Spends the banked ultimateReady flag, not a
 *  charge — but still grants a charge back on the capture, same as any
 *  other capturing action. Always ends the turn, even if the destination
 *  happens to be a shield tile — deliberately no extra-turn interaction
 *  here, given this codebase's history with extra-turn balance blowups. */
export function applyBlinkStrike(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; sweptTokenIds: number[] } {
  const mine = findMostAdvancedToken(state, mover)!;
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: target.position };
    if (t.id === targetTokenId) return { ...t, position: -1 };
    return t;
  });
  let safeTokens = power.safeTokens;
  if (safeTokens.has(mine.id) || safeTokens.has(targetTokenId)) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(mine.id);
    safeTokens.delete(targetTokenId);
  }
  let nextPower: PowerState = {
    ...power,
    safeTokens,
    ultimateReady: { ...power.ultimateReady, [mover]: false },
  };
  nextPower = addCharge(nextPower, mover);
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  // sweptTokenIds is always empty for Blink Strike — kept in the return
  // shape purely so callers can treat it and applyWarpath's result
  // uniformly, since Blink Strike never sweeps.
  return { state: nextState, power: resetTurnFlags(nextPower), sweptTokenIds: [] };
}

/** Warrior's Warpath: instantly relocates the mover's LEAST-advanced
 *  on-board token onto the target's tile, capturing it, AND sweeps every
 *  unprotected enemy on a contested tile strictly between where that token
 *  started and where it lands (either direction — this is a teleport, not
 *  a real move, so "forward" doesn't matter) — uncapped, unlike Charge's
 *  CHARGE_SWEEP_CAP. Same bypass rules as Blink Strike (shield + Ward, not
 *  transient safety) for every token it hits, primary or swept. If it
 *  breaks a Ward anywhere along the way, the landing token gets
 *  Shieldbreaker's usual transient-safety grant — ties this back to
 *  Warrior's core identity instead of being a bare reskin of Blink Strike.
 *  Spends ultimateReady, not a charge; still grants exactly 1 charge back
 *  on a successful capture, matching Charge's own sweep economy (one
 *  capturing move = one charge, regardless of how many tokens it takes
 *  down). Always ends the turn — no extra-turn interaction. */
export function applyWarpath(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; sweptTokenIds: number[] } {
  const mine = findLeastAdvancedToken(state, mover)!;
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const from = mine.position;
  const to = target.position;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);

  const sweepCaptures: number[] = [];
  let brokeWard = isWarded(state, power, target);
  for (let i = lo + 1; i < hi; i++) {
    if (!BOARD_LAYOUT[i].isContested) continue;
    const foe = state.tokens.find(
      (t) => t.position === i && t.owner !== mover && t.id !== mine.id && t.id !== targetTokenId,
    );
    if (foe && !hasTransientSafety(power, foe)) {
      sweepCaptures.push(foe.id);
      if (isWarded(state, power, foe)) brokeWard = true;
    }
  }

  const allCaptures = [targetTokenId, ...sweepCaptures];
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: to };
    if (allCaptures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });

  let safeTokens = power.safeTokens;
  if (safeTokens.has(mine.id) || allCaptures.some((id) => safeTokens.has(id))) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(mine.id);
    for (const id of allCaptures) safeTokens.delete(id);
  }
  if (brokeWard) {
    safeTokens = new Set(safeTokens);
    safeTokens.add(mine.id);
  }

  let nextPower: PowerState = {
    ...power,
    safeTokens,
    ultimateReady: { ...power.ultimateReady, [mover]: false },
  };
  nextPower = addCharge(nextPower, mover);
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(nextPower), sweptTokenIds: sweepCaptures };
}
