// ============================================================================
// bot.ts — the CPU opponent's move picker.
//
// Pure function over (state, legalMoves) -> move index, so it can be unit
// tested and reused. The referee owns WHEN the bot acts (turn timing); this
// file owns WHICH move it takes.
//
// Strategy: ranked heuristic with a small random jitter so games don't play
// out identically. Priorities, highest first:
//   win > capture > shield (extra turn) > escape > reach safety > develop
// ============================================================================

import {
  BOARD_LAYOUT,
  PATH_LENGTH_PER_PLAYER,
  type GameState,
  type Move,
} from "./rulebook";

export function pickBotMove(
  state: GameState,
  moves: Move[],
  rand: () => number = Math.random,
): number {
  let bestIndex = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let score = 0;

    if (m.causesWin) score += 1000;
    if (m.captures.length > 0) {
      // Capturing is strong; capturing a far-advanced enemy token stronger.
      const victimProgress = Math.max(
        ...m.captures.map((id) => {
          const t = state.tokens.find((tok) => tok.id === id);
          return t ? t.position : 0;
        }),
      );
      score += 400 + victimProgress * 10;
    }
    if (m.landsOnShield) score += 250;
    if (m.to === PATH_LENGTH_PER_PLAYER) score += 300; // escape
    if (m.from === -1) score += 60; // develop from reserve

    // Leaving the contested middle for the safe finish rows.
    const fromContested = m.from >= 0 && BOARD_LAYOUT[m.from]?.isContested;
    const toSafe = m.to < PATH_LENGTH_PER_PLAYER && !BOARD_LAYOUT[m.to]?.isContested;
    if (fromContested && toSafe) score += 120;

    // Mild exposure penalty: landing on a capturable contested tile while
    // enemy tokens sit within striking distance (1..4 behind).
    if (
      m.to < PATH_LENGTH_PER_PLAYER &&
      BOARD_LAYOUT[m.to]?.isContested &&
      BOARD_LAYOUT[m.to]?.type !== "shield"
    ) {
      const threatened = state.tokens.some(
        (t) =>
          t.owner !== state.currentPlayer &&
          t.position >= 0 &&
          m.to - t.position >= 1 &&
          m.to - t.position <= 4,
      );
      if (threatened) score -= 80;
    }

    score += m.to; // slight preference for progress
    score += rand() * 20; // jitter so play isn't deterministic

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex;
}
