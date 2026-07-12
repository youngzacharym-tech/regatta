// ============================================================================
// master-killer-bot.ts — CPU decision-making for Master Killer mode.
//
// Mirrors bot.ts's approach (ranked heuristic, small jitter) but scores
// across ALL available actions this turn — a normal/power-boosted move,
// Archer's Push, Mage's Re-flip, or Warrior's Charge — and takes whichever
// scores highest. Separate file from bot.ts so classic mode's bot (and
// anything reading it, including Kasen's audit) stays untouched.
// ============================================================================

import { BOARD_LAYOUT, PATH_LENGTH_PER_PLAYER, type GameState } from "./rulebook.ts";
import {
  getPushTargets,
  type PlayerClass,
  type PowerAction,
  type PowerMove,
  type PowerState,
} from "./master-killer.ts";

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
 *  the non-collision case) doesn't remove the token outright. */
function scorePush(state: GameState, targetId: number, rand: () => number): number {
  const target = state.tokens.find((t) => t.id === targetId)!;
  const rawTo = target.position - 2; // mirrors master-killer.ts's PUSH_DISTANCE
  const collides = state.tokens.some(
    (t) => t.id !== targetId && t.owner === target.owner && t.position === rawTo,
  );
  const sendsHome = collides || rawTo < 0;
  let score = (sendsHome ? 350 : 180) + target.position * 8;
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
    if (cls === "warrior" && m.chargeAvailable && charges >= 1) {
      const chargeScore = scoreMove(state, m, m.chargeSweepCaptures, rand) + 20; // small "use the cool ability" nudge
      if (chargeScore > bestScore) {
        bestScore = chargeScore;
        best = { kind: "charge", move: m };
      }
    }
  }

  if (cls === "archer" && charges >= 1) {
    for (const targetId of getPushTargets(state, power, mover)) {
      const score = scorePush(state, targetId, rand);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: "push", targetTokenId: targetId };
      }
    }
  }

  if (cls === "mage" && charges >= 1 && !power.reflipUsedThisTurn) {
    const score = scoreReflip(moves.length, flip, rand);
    if (score > bestScore) {
      bestScore = score;
      best = { kind: "reflip" };
    }
  }

  return best;
}
