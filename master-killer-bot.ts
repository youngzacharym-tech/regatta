// ============================================================================
// master-killer-bot.ts — CPU decision-making for Master Killer mode.
//
// Mirrors bot.ts's approach (ranked heuristic, small jitter) but scores
// across ALL available actions this turn — a normal/power-boosted move,
// Archer's Push, Mage's Re-flip, Warrior's Charge or Bulwark, or (once
// banked) Mage's Blink Strike / Warrior's Warpath ultimate — and takes
// whichever scores highest. Separate file from bot.ts so classic mode's bot
// (and anything reading it, including Kasen's audit) stays untouched.
//
// Three difficulty tiers, same shape as bot.ts (see bot-difficulty.ts):
//   easy     — win short-circuit, then mostly uniform-random over EVERY
//              legal action (including legal-but-wasteful ones, e.g. an
//              empty-sweep Charge — the blunders are the point).
//   standard — the original ranked heuristic above, byte-preserved as the
//              default so every existing call site and balance baseline is
//              untouched.
//   hard     — charge-valued static eval (evaluateMK) + one-ply expectimax
//              over FLIP_WEIGHTS, simulating candidates through the pure
//              apply* functions.
// ============================================================================

import { BOARD_LAYOUT, PATH_LENGTH_PER_PLAYER, type GameState, type PlayerId } from "./rulebook.ts";
import {
  applyBlinkStrike,
  applyBulwark,
  applyCharge,
  applyChargedShot,
  applyPowerMove,
  applyPush,
  applyReflip,
  applyWarpath,
  canReflipAgain,
  CHARGE_CAP,
  CHARGED_SHOT_DISTANCE,
  CHARGED_SHOT_WARD_DISTANCE,
  getBlinkStrikeTargets,
  getBulwarkTargets,
  getChargedShotTargets,
  getLegalPowerMoves,
  getPushTargets,
  getWarpathTargets,
  isBulwarked,
  isWarded,
  PUSH_DISTANCE,
  PUSH_WARD_DISTANCE,
  type PlayerClass,
  type PowerAction,
  type PowerMove,
  type PowerState,
} from "./master-killer.ts";
import { EASY_HEED_P, FLIP_WEIGHTS, FLIP_WEIGHT_TOTAL, type BotDifficulty } from "./bot-difficulty.ts";

/** Same shape of scoring bot.ts uses for a plain move, extended with the
 *  power-derived capture sets (bonus snipe / charge sweep) so a Master
 *  Killer move that happens to snipe or sweep scores appropriately higher
 *  than an equivalent classic move would. */
function scoreMove(state: GameState, m: PowerMove, extraCaptures: number[], rand: () => number): number {
  let score = 0;
  const allCaptures = [...m.captures, ...m.bonusCaptures, ...extraCaptures];

  if (m.causesWin) score += 1000;
  if (allCaptures.length > 0) {
    const victimProgress = Math.max(
      ...allCaptures.map((id) => state.tokens.find((t) => t.id === id)?.position ?? 0),
    );
    // Each additional capture in the same move (Snipe/Charge stacking) is
    // worth a real but diminishing bonus — multi-capture moves should win
    // ties against single captures without becoming a blowout auto-pick.
    score += 400 + victimProgress * 10 + (allCaptures.length - 1) * 150;
  }
  if (m.landsOnShield) score += 250;
  if (m.to === PATH_LENGTH_PER_PLAYER) score += 300;
  if (m.from === -1) score += 60;

  const fromContested = m.from >= 0 && BOARD_LAYOUT[m.from]?.isContested;
  const toSafe = m.to < PATH_LENGTH_PER_PLAYER && !BOARD_LAYOUT[m.to]?.isContested;
  if (fromContested && toSafe) score += 120;

  if (m.to < PATH_LENGTH_PER_PLAYER && BOARD_LAYOUT[m.to]?.isContested && BOARD_LAYOUT[m.to]?.type !== "shield") {
    const threatened = state.tokens.some(
      (t) =>
        t.owner !== state.currentPlayer &&
        t.position >= 0 &&
        m.to - t.position >= 1 &&
        m.to - t.position <= 4,
    );
    if (threatened) score -= 80;
  }

  score += m.to;
  score += rand() * 20;
  return score;
}

/** Score Push against its best available target — favors hitting the
 *  furthest-advanced enemy, same "capture the leader" instinct bot.ts uses
 *  for normal captures, scaled down a bit since it costs a charge and (for
 *  the non-collision case) doesn't remove the token outright.
 *
 *  A warded target costs the same PUSH_WARD_COST as a normal push (both are
 *  1), but travels PUSH_WARD_DISTANCE instead of PUSH_DISTANCE — same price,
 *  bigger effect. Sending it home strips Ward permanently (scored well above
 *  a normal send-home); even the non-collision case is worth a bit more
 *  than an equivalent normal push, since the longer knockback is more likely
 *  to shove the target out of the contested zone entirely or hand Ward off
 *  to a different token. */
function scorePush(state: GameState, power: PowerState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  const warded = isWarded(state, power, target);
  const distance = warded ? PUSH_WARD_DISTANCE : PUSH_DISTANCE;
  const rawTo = target.position - distance;
  const collides = state.tokens.some(
    (t) => t.id !== targetId && t.owner === target.owner && t.position === rawTo,
  );
  const sendsHome = collides || rawTo < 0;
  let score: number;
  if (sendsHome) {
    score = 350 + target.position * 8;
    if (warded) score += 250; // sending a Warded token home is still a big win — removes Ward from play entirely
  } else {
    // Soft-push baseline scales with the ACTUAL distance moved — 180 per
    // tile, chosen so this reduces to the exact pre-existing formula for a
    // normal (unwarded) push: PUSH_DISTANCE=1 -> 180*1=180, byte-for-byte
    // unchanged from before this fix. This replaces the old flat "+60 if
    // warded" bonus, which assumed a warded soft-push always repositions
    // the target meaningfully; now that PUSH_WARD_DISTANCE can legitimately
    // be 0 (a mechanical no-op against a Warded target — spends the charge,
    // target doesn't move at all), the bonus must scale down to zero too,
    // or the bot repeats the exact "flat bonus quietly out-competes a
    // strictly-better plain move" bug already fixed once each for
    // scoreBulwark and scoreChargedShot in this file.
    score = 180 * distance + target.position * 8;
  }
  score += rand() * 20;
  return score;
}

/** Score Archer's Charged Shot: spends BOTH banked charges (CHARGE_CAP) in
 *  one shot, so — same bug class already hit twice this session (see
 *  scoreBulwark's own history note, and the chargeSweepCaptures.length guard
 *  above) — it must NOT get a flat "you can afford it" bonus, or the bot
 *  burns the whole bank on marginal targets instead of ever letting a
 *  cheaper Push or a real move fire. Mirrors scorePush's own shape exactly
 *  (sendsHome bonus + target.position scaling, nothing else) rather than
 *  inventing a new one, since that shape has already survived this exact
 *  scrutiny — but a non-send-home shove scores far below Push's own 180
 *  baseline (20 here, vs Push's 180), since spending the WHOLE bank for a
 *  shove that leaves the target on the board is rarely worth it when a
 *  1-charge Push (net 0 on a send-home) is usually sitting right there as a
 *  cheaper alternative. Only a real send-home — the one outcome a normal
 *  Push's shorter PUSH_DISTANCE often can't reach — clears the bar to beat
 *  an ordinary move or a Push. */
function scoreChargedShot(state: GameState, power: PowerState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  const warded = isWarded(state, power, target);
  const rawTo = target.position - (warded ? CHARGED_SHOT_WARD_DISTANCE : CHARGED_SHOT_DISTANCE);
  const collides = state.tokens.some(
    (t) => t.id !== targetId && t.owner === target.owner && t.position === rawTo,
  );
  const sendsHome = collides || rawTo < 0;
  let score = (sendsHome ? 420 : 20) + target.position * 10;
  score += rand() * 20;
  return score;
}

/** Score Mage's Blink Strike / Warrior's Warpath: both are a guaranteed hit
 *  that bypasses shield-tile protection and Ward outright — scored like a
 *  strong capture (same shape as scoreMove's capture bonus), plus a flat
 *  bonus so the bot doesn't sit on a banked ultimateReady flag once a legal
 *  target exists. Doesn't account for Warpath's extra sweep captures along
 *  the way — target choice among a rarely-more-than-one-deep candidate pool
 *  isn't worth the complexity of a speculative applyWarpath() call here. */
function scoreUltimateStrike(state: GameState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  let score = 500 + target.position * 10;
  score += rand() * 20;
  return score;
}

/** Score Warrior's Bulwark: defensive insurance on the mover's most-advanced
 *  un-Bulwarked on-board token, scaled by how far along it already is
 *  (mirrors scorePush's own target.position scaling) so the bot naturally
 *  favors protecting whichever token has the most invested.
 *
 *  Deliberately biased NEGATIVE at the low end (score starts at -35, not 0)
 *  rather than just "modest but positive" — this is the fix for a real bug
 *  found while tuning this exact function, worth recording since it's a new
 *  instance of the file's established "flat bonus quietly out-competes a
 *  strictly-better plain move" failure mode (see the chargeSweepCaptures.length
 *  check above for the original case). Bulwark is essentially ALWAYS
 *  evaluable for a Warrior with a spare charge (unlike Push, which needs a
 *  specific enemy on a contested tile, or Reflip, which needs a bad flip) —
 *  so ANY comfortably-positive flat score, even a small one, made the bot
 *  cast it almost every eligible turn instead of advancing or Charging.
 *  Balance-sim fallout was severe: archer-vs-warrior swung from the ~43.6/
 *  56.4 warrior-favored baseline all the way to ~80/20 ARCHER-favored,
 *  because a Warrior burning its charge income on defense instead of
 *  Charge's actual capture-and-advance loop stops converting board control
 *  into wins. The negative floor means Bulwark only wins against an
 *  already-bad alternative (a quiet move into contested territory near an
 *  enemy takes scoreMove's -80 "threatened" penalty, for example) or a
 *  well-advanced token (position 12+ pulls the score back toward/above
 *  zero) — occasional insurance on a valuable token when nothing better is
 *  on offer, not a default action. */
function scoreBulwark(state: GameState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  let score = -40 + target.position * 3;
  score += rand() * 20;
  return score;
}

/** Is this own token actually in capture danger — on a contested, non-shield
 *  tile with an enemy inside the 1-4 flip landing window behind it (the same
 *  window scoreMove's own "threatened" penalty uses)? Bulwark's protection is
 *  worth ~nothing off the contested row (private-lane tokens can't be
 *  captured, Pushed, swept, or ultimate-struck at all), so a full-bank spend
 *  that isn't answering a live threat is pure waste. This gate is
 *  load-bearing, not a nicety: the first-round candidate scoring skipped it
 *  and every second-charge Bulwark design tanked the Warrior (~-1 to -2.5pts
 *  across its matchups at 30000 games) — the bot was burning the bank on
 *  un-threatened and even un-capturable tokens while charge/g (the Charge
 *  capture loop, the class's actual win engine) starved. With the gate, the
 *  same ability design flipped to IMPROVING both Warrior matchups. */
function bulwarkFacesThreat(state: GameState, target: { position: number; owner: PlayerId }): boolean {
  if (target.position < 0 || target.position >= PATH_LENGTH_PER_PLAYER) return false;
  const tile = BOARD_LAYOUT[target.position];
  if (!tile.isContested || tile.type === "shield") return false;
  return state.tokens.some(
    (t) =>
      t.owner !== target.owner &&
      t.position >= 0 &&
      target.position - t.position >= 1 &&
      target.position - t.position <= 4,
  );
}

/** Score Reinforced Bulwark — the 2-charge, full-bank Bulwark that lasts
 *  and saves twice as long (see BULWARK_REINFORCED_TURNS). Requires a live
 *  threat (see bulwarkFacesThreat), then the same negative floor as
 *  scoreBulwark with steeper position scaling (5/tile vs 3) because doubled
 *  durability is worth most on the token with the most invested — and
 *  nothing else, so spending the whole bank still has to EARN its slot over
 *  a plain move/Charge, the same discipline scoreChargedShot applies to
 *  Archer's own full-bank spend. Scaling swept at 4/5/6 per tile, 30000
 *  games each: 5 gave the best combined Warrior matchup distance-from-50
 *  (aw 50.9-51.6/48.4-49.1, mw 54.7-55.0/45.0-45.3, fire rate 0.4-1.1/g);
 *  4 under-used it (0.28-0.79/g, aw 48.1), 6 was flat-to-worse on aw
 *  (48.4) for no mw gain beyond noise. */
function scoreReinforcedBulwark(state: GameState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  if (!bulwarkFacesThreat(state, target)) return -Infinity;
  let score = -40 + target.position * 5;
  score += rand() * 20;
  return score;
}

/** Score Re-flip: only worth it when the CURRENT flip is bad — zero, or a
 *  flip that produces no legal moves at all (about to be skipped anyway). */
function scoreReflip(currentMoveCount: number, flip: number, rand: () => number): number {
  if (flip === 0 || currentMoveCount === 0) return 500 + rand() * 20;
  return -1; // never worth it over an already-legal move otherwise
}

/**
 * Pick the best action for the current player this turn: a plain/powered
 * move, Push, Re-flip, or Charge (on an eligible move) — whichever scores
 * highest. `flip` is needed to score Re-flip; pass the CURRENT flip's move
 * list and value even if a reflip ends up chosen (the caller re-rolls and
 * re-picks afterward — this function only decides WHETHER to reflip, not
 * what to do with the new flip).
 *
 * `difficulty` selects the tier (default "standard" = the pre-difficulty
 * behavior, byte-preserved — see pickStandardPowerAction).
 *
 * Returns null when there is truly no legal action (no moves, and no
 * charge-funded rescue available) — the caller should treat that exactly
 * like the classic game's empty-legalMoves case and skip the turn.
 */
export function pickBotPowerAction(
  state: GameState,
  power: PowerState,
  moves: PowerMove[],
  flip: number,
  rand: () => number = Math.random,
  difficulty: BotDifficulty = "standard",
): PowerAction | null {
  if (difficulty === "easy") return pickEasyPowerAction(state, power, moves, flip, rand);
  if (difficulty === "hard") return pickHardPowerAction(state, power, moves, rand);
  return pickStandardPowerAction(state, power, moves, flip, rand);
}

// ============================================================================
// STANDARD — the original heuristic, extracted verbatim (same rand() call
// order) so the default tier's behavior is byte-identical to the
// pre-difficulty bot. Do not "improve" this one; that's what hard is for.
// ============================================================================

function pickStandardPowerAction(
  state: GameState,
  power: PowerState,
  moves: PowerMove[],
  flip: number,
  rand: () => number,
): PowerAction | null {
  const mover = state.currentPlayer;
  const cls: PlayerClass = power.classes[mover];
  const charges = power.charges[mover];

  let best: PowerAction | null = null;
  let bestScore = -Infinity;

  for (const m of moves) {
    const score = scoreMove(state, m, [], rand);
    if (score > bestScore) {
      bestScore = score;
      best = { kind: "move", move: m };
    }
    // chargeSweepCaptures.length > 0 is required, not just chargeAvailable:
    // chargeAvailable only means "the lane is clear of the Warrior's OWN
    // tokens" — it says nothing about whether there's an enemy to actually
    // sweep. Without this check the bot would spend a real charge on a
    // Charge that captures nothing extra beyond the plain move it's
    // wrapping, which is strictly worse (identical board outcome, minus a
    // charge). Found via a suspiciously high charge/g stat in the balance
    // sim (~40% of all turns in a warrior mirror game) that traced back to
    // the +20 nudge below always winning over an empty-sweep plain move.
    if (cls === "warrior" && m.chargeAvailable && m.chargeSweepCaptures.length > 0 && charges >= 1) {
      const chargeScore = scoreMove(state, m, m.chargeSweepCaptures, rand) + 20; // small "use the cool ability" nudge
      if (chargeScore > bestScore) {
        bestScore = chargeScore;
        best = { kind: "charge", move: m };
      }
    }
  }

  if (cls === "archer" && charges >= 1) {
    for (const targetId of getPushTargets(state, power, mover)) {
      const score = scorePush(state, power, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "push", targetTokenId: targetId };
      }
    }
  }

  if (cls === "archer" && charges === CHARGE_CAP) {
    for (const targetId of getChargedShotTargets(state, power, mover)) {
      const score = scoreChargedShot(state, power, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "chargedShot", targetTokenId: targetId };
      }
    }
  }

  if (cls === "mage" && canReflipAgain(power, mover)) {
    const score = scoreReflip(moves.length, flip, rand);
    if (score > bestScore) {
      bestScore = score;
      best = { kind: "reflip" };
    }
  }

  if (cls === "mage" && power.ultimateReady[mover]) {
    for (const targetId of getBlinkStrikeTargets(state, power, mover)) {
      const score = scoreUltimateStrike(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "blinkStrike", targetTokenId: targetId };
      }
    }
  }

  if (cls === "warrior" && power.ultimateReady[mover]) {
    for (const targetId of getWarpathTargets(state, power, mover)) {
      const score = scoreUltimateStrike(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "warpath", targetTokenId: targetId };
      }
    }
  }

  if (cls === "warrior" && charges >= 1) {
    const bulwarkTargets = getBulwarkTargets(state, power, mover);
    for (const targetId of bulwarkTargets) {
      const score = scoreBulwark(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "bulwark", tokenId: targetId };
      }
    }
    // Reinforced Bulwark: the full-bank cast, offered alongside the plain
    // one — same target pool, its own threat-gated scoring.
    if (charges === CHARGE_CAP) {
      for (const targetId of bulwarkTargets) {
        const score = scoreReinforcedBulwark(state, targetId, rand);
        if (score > bestScore) {
          bestScore = score;
          best = { kind: "bulwark", tokenId: targetId, reinforced: true };
        }
      }
    }
  }

  return best;
}

// ============================================================================
// CANDIDATE ENUMERATION — shared by easy and hard. Mirrors validateUsePower's
// gates in room-engine.ts EXACTLY (class, charge affordability, target
// getters), so every candidate either tier emits is guaranteed to survive
// the server's re-validation. Kept as one enumerator on purpose: three
// per-tier copies of these gates would drift.
// ============================================================================

function enumerateCandidates(state: GameState, power: PowerState, moves: PowerMove[]): PowerAction[] {
  const mover = state.currentPlayer;
  const cls: PlayerClass = power.classes[mover];
  const charges = power.charges[mover];
  const out: PowerAction[] = [];

  for (const m of moves) {
    out.push({ kind: "move", move: m });
    // Deliberately validateUsePower's gate (chargeAvailable + charges >= 1),
    // NOT standard's extra chargeSweepCaptures.length > 0 discipline — an
    // empty-sweep Charge is legal-but-wasteful, which is exactly the blunder
    // pool easy picks from; hard's charge-valued eval prices the wasted
    // charge and declines it on its own.
    if (cls === "warrior" && m.chargeAvailable && charges >= 1) {
      out.push({ kind: "charge", move: m });
    }
  }
  if (cls === "archer" && charges >= 1) {
    for (const id of getPushTargets(state, power, mover)) out.push({ kind: "push", targetTokenId: id });
  }
  if (cls === "archer" && charges === CHARGE_CAP) {
    for (const id of getChargedShotTargets(state, power, mover)) {
      out.push({ kind: "chargedShot", targetTokenId: id });
    }
  }
  if (cls === "mage" && canReflipAgain(power, mover)) out.push({ kind: "reflip" });
  if (cls === "mage" && power.ultimateReady[mover]) {
    for (const id of getBlinkStrikeTargets(state, power, mover)) {
      out.push({ kind: "blinkStrike", targetTokenId: id });
    }
  }
  if (cls === "warrior" && power.ultimateReady[mover]) {
    for (const id of getWarpathTargets(state, power, mover)) out.push({ kind: "warpath", targetTokenId: id });
  }
  if (cls === "warrior" && charges >= 1) {
    const bulwarkTargets = getBulwarkTargets(state, power, mover);
    for (const id of bulwarkTargets) out.push({ kind: "bulwark", tokenId: id });
    if (charges === CHARGE_CAP) {
      for (const id of bulwarkTargets) out.push({ kind: "bulwark", tokenId: id, reinforced: true });
    }
  }
  return out;
}

// ============================================================================
// EASY — mostly random over every legal action, never suicidal about a win.
// ============================================================================

function pickEasyPowerAction(
  state: GameState,
  power: PowerState,
  moves: PowerMove[],
  flip: number,
  rand: () => number,
): PowerAction | null {
  // Win short-circuit: an easy bot that declines to end the game produces
  // unbounded, infuriating matches — take it every time.
  const winMove = moves.find((m) => m.causesWin);
  if (winMove) return { kind: "move", move: winMove };
  if (rand() < EASY_HEED_P) return pickStandardPowerAction(state, power, moves, flip, rand);
  const candidates = enumerateCandidates(state, power, moves);
  if (candidates.length === 0) return null; // same auto-skip path as standard's null
  return candidates[Math.floor(rand() * candidates.length)];
}

// ============================================================================
// HARD — charge-valued static eval + one-ply expectimax over FLIP_WEIGHTS.
//
// Every candidate is SIMULATED through the same pure apply* functions the
// server executes with, then valued by averaging the next actor's best
// response over the five flip outcomes. The eval's explicit charge value is
// what stops the bot burning the bank on marginal spends — the failure mode
// this file has fixed three times by hand (see scoreBulwark's history note);
// pricing the resource in the eval solves it structurally instead of
// per-ability.
// ============================================================================

/** Hard tier eval terms — board terms match bot.ts's evaluateClassic values
 *  (duplicated, not imported: this file deliberately never imports bot.ts),
 *  plus the Master Killer economy. */
const MK_EVAL_ESCAPED = 200;
const MK_EVAL_PER_TILE = 8;
const MK_EVAL_SHIELD_TILE = 25;
const MK_EVAL_THREAT_BASE = 40;
const MK_EVAL_THREAT_PER_TILE = 6;
/** A banked charge is roughly "one Push, or one Re-flip, on demand" — worth
 *  a few tiles of progress (3 tiles at MK_EVAL_PER_TILE) but well under a
 *  capture's swing, so the bot spends when a spend beats holding, not
 *  reflexively either way. */
const MK_EVAL_CHARGE = 24;
/** A banked ultimate is a guaranteed future capture of a token of the bot's
 *  choosing (Blink Strike / Warpath both bypass shields and Ward) — priced
 *  near a mid-board capture's positional swing so it isn't spent on scraps. */
const MK_EVAL_ULTIMATE = 70;
/** Live shield-streak progress toward that ultimate, per landing banked. */
const MK_EVAL_STREAK = 12;
/** An active Bulwark on an own token — insurance, real but modest (it
 *  expires on its own; see BULWARK_TURNS). */
const MK_EVAL_BULWARK = 12;
/** A certain win outranks any expectation sum (max weighted contribution of
 *  a probabilistic win is < 1 · MK_WIN_VALUE). */
const MK_WIN_VALUE = 1_000_000;

/** Fixed rand for inside-the-search simulation: only Rain of Arrows' target
 *  pick consumes it, and search nodes must be deterministic so candidate
 *  values are comparable. The REAL rand still governs the authoritative
 *  apply in room-engine once an action is chosen. */
const SIM_RAND = () => 0.5;

/** One player's side of the eval: escaped >> progress + shield perch, minus
 *  probability-weighted capture threat (skipped while Ward/Bulwark
 *  protects the token), plus the charge economy terms. */
function mkEvalSide(state: GameState, power: PowerState, player: PlayerId): number {
  let score = 0;
  for (const t of state.tokens) {
    if (t.owner !== player) continue;
    if (t.position >= PATH_LENGTH_PER_PLAYER) {
      score += MK_EVAL_ESCAPED;
      continue;
    }
    if (t.position < 0) continue; // reserve is worth exactly nothing
    score += MK_EVAL_PER_TILE * t.position;
    const tile = BOARD_LAYOUT[t.position];
    if (tile.type === "shield") score += MK_EVAL_SHIELD_TILE;
    if (
      tile.isContested &&
      tile.type !== "shield" &&
      !isWarded(state, power, t) &&
      !isBulwarked(power, t)
    ) {
      for (const e of state.tokens) {
        if (e.owner === player || e.position < 0 || e.position >= PATH_LENGTH_PER_PLAYER) continue;
        const gap = t.position - e.position;
        if (gap >= 1 && gap <= 4) {
          score -=
            ((MK_EVAL_THREAT_BASE + MK_EVAL_THREAT_PER_TILE * t.position) * FLIP_WEIGHTS[gap]) /
            FLIP_WEIGHT_TOTAL;
        }
      }
    }
    if (isBulwarked(power, t)) score += MK_EVAL_BULWARK;
  }
  score += MK_EVAL_CHARGE * power.charges[player];
  if (power.ultimateReady[player]) score += MK_EVAL_ULTIMATE;
  score += MK_EVAL_STREAK * power.shieldStreak[player];
  return score;
}

/** Antisymmetric eval from `me`'s perspective (me minus foe). */
function evaluateMK(state: GameState, power: PowerState, me: PlayerId): number {
  const foe: PlayerId = me === "p1" ? "p2" : "p1";
  return mkEvalSide(state, power, me) - mkEvalSide(state, power, foe);
}

/** Best own follow-up after keeping the turn (shield landing), one flip.
 *  Dead flips (0 / no moves) skip — the board stands as evaluated. Replies
 *  here are plain power moves only; deeper power actions aren't modeled —
 *  one ply of plain replies keeps the search cheap, and the separation sim
 *  is the judge of whether that's strong enough. */
function mkBestOwnFollowup(state: GameState, power: PowerState, flip: number, me: PlayerId): number {
  if (flip === 0) return evaluateMK(state, power, me);
  const moves = getLegalPowerMoves(state, power, flip);
  if (moves.length === 0) return evaluateMK(state, power, me);
  let best = -Infinity;
  for (const m of moves) {
    if (m.causesWin) return MK_WIN_VALUE;
    const r = applyPowerMove(state, power, m, me, SIM_RAND);
    const v = evaluateMK(r.state, r.power, me);
    if (v > best) best = v;
  }
  return best;
}

/** Opponent's best (our worst) plain-move reply for one flip — the min node. */
function mkWorstOppReply(state: GameState, power: PowerState, flip: number, me: PlayerId): number {
  if (flip === 0) return evaluateMK(state, power, me);
  const opp = state.currentPlayer;
  const moves = getLegalPowerMoves(state, power, flip);
  if (moves.length === 0) return evaluateMK(state, power, me);
  let worst = Infinity;
  for (const m of moves) {
    if (m.causesWin) return -MK_WIN_VALUE;
    const r = applyPowerMove(state, power, m, opp, SIM_RAND);
    const v = evaluateMK(r.state, r.power, me);
    if (v < worst) worst = v;
  }
  return worst;
}

/** The shared post-action expectation: whoever `state.currentPlayer` is
 *  after the candidate resolved (the mover again on a shield extra turn, the
 *  opponent otherwise) gets a max/min node averaged over the five flips. */
function mkValueAfterAction(state: GameState, power: PowerState, me: PlayerId): number {
  if (state.winner === me) return MK_WIN_VALUE;
  if (state.winner !== null) return -MK_WIN_VALUE;
  const ownTurn = state.currentPlayer === me;
  let value = 0;
  for (let f = 0; f <= 4; f++) {
    const p = FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL;
    value += p * (ownTurn ? mkBestOwnFollowup(state, power, f, me) : mkWorstOppReply(state, power, f, me));
  }
  return value;
}

/** Value of Re-flip: average over the replacement flip of the best immediate
 *  move's full post-apply expectation (so it's on the same scale as every
 *  other candidate). applyReflip's charge spend is priced by the eval's
 *  MK_EVAL_CHARGE term, so the hard Mage re-flips a capture-less 1 when
 *  holding spare charges — strictly smarter than standard's "only on 0/no
 *  moves" rule — and this also upgrades the zero-move rescue path (the
 *  engine calls the bot with moves=[] before auto-skipping). */
function mkReflipValue(state: GameState, power: PowerState, me: PlayerId): number {
  const powerR = applyReflip(power, me);
  let value = 0;
  for (let f = 0; f <= 4; f++) {
    const p = FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL;
    if (f === 0) {
      value += p * evaluateMK(state, powerR, me);
      continue;
    }
    const moves = getLegalPowerMoves(state, powerR, f);
    if (moves.length === 0) {
      value += p * evaluateMK(state, powerR, me);
      continue;
    }
    let best = -Infinity;
    for (const m of moves) {
      const v = m.causesWin
        ? MK_WIN_VALUE
        : (() => {
            const r = applyPowerMove(state, powerR, m, me, SIM_RAND);
            return mkValueAfterAction(r.state, r.power, me);
          })();
      if (v > best) best = v;
    }
    value += p * best;
  }
  return value;
}

/** Simulate one non-reflip candidate through the same pure apply* functions
 *  the server executes with. */
function mkSimulate(
  state: GameState,
  power: PowerState,
  c: Exclude<PowerAction, { kind: "reflip" }>,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  switch (c.kind) {
    case "move":
      return applyPowerMove(state, power, c.move, mover, SIM_RAND);
    case "charge":
      return applyCharge(state, power, c.move, mover, SIM_RAND);
    case "push":
      return applyPush(state, power, c.targetTokenId, mover);
    case "chargedShot":
      return applyChargedShot(state, power, c.targetTokenId, mover);
    case "blinkStrike":
      return applyBlinkStrike(state, power, c.targetTokenId, mover);
    case "warpath":
      return applyWarpath(state, power, c.targetTokenId, mover);
    case "bulwark":
      return applyBulwark(state, power, c.tokenId, mover, c.reinforced ?? false);
  }
}

/** Expectimax root: value every candidate, tiny rand tie-break only (hard is
 *  deterministic-feeling on purpose — no 20-point jitter). Budget: ~25
 *  candidates x 5 flips x ~10 replies, plus Re-flip's 5x10x(5x10) — under
 *  10k O(8-token) evals, low single-digit ms, safe inside a server tick even
 *  across withDoc's 4 CAS retries. */
function pickHardPowerAction(
  state: GameState,
  power: PowerState,
  moves: PowerMove[],
  rand: () => number,
): PowerAction | null {
  const mover = state.currentPlayer;
  const candidates = enumerateCandidates(state, power, moves);
  if (candidates.length === 0) return null;

  let best: PowerAction | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    let value: number;
    if ((c.kind === "move" || c.kind === "charge") && c.move.causesWin) {
      value = MK_WIN_VALUE;
    } else if (c.kind === "reflip") {
      value = mkReflipValue(state, power, mover);
    } else {
      const r = mkSimulate(state, power, c, mover);
      value = mkValueAfterAction(r.state, r.power, mover);
    }
    value += rand() * 1e-3;
    if (value > bestScore) {
      bestScore = value;
      best = c;
    }
  }
  return best;
}
