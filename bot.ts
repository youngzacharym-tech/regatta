// ============================================================================
// bot.ts — the CPU opponent's move picker.
//
// Pure function over (state, legalMoves) -> move index, so it can be unit
// tested and reused. The referee owns WHEN the bot acts (turn timing); this
// file owns WHICH move it takes.
//
// Three difficulty tiers (see bot-difficulty.ts for the shared vocabulary):
//   easy     — blunder-prone: mostly uniform-random, but never passes up an
//              outright win (an "easy" bot that anti-plays forever is
//              infuriating, not gentle).
//   standard — the original ranked heuristic, byte-preserved as the default
//              so every existing call site and balance baseline is untouched.
//              Priorities, highest first:
//                win > capture > shield (extra turn) > escape > reach safety > develop
//   hard     — static evaluation + one-ply expectimax over the enumerable
//              4-coin flip distribution (FLIP_WEIGHTS).
// ============================================================================

import {
  applyMove,
  BOARD_LAYOUT,
  getLegalMoves,
  PATH_LENGTH_PER_PLAYER,
  type GameState,
  type Move,
  type PlayerId,
} from "./rulebook";
import { EASY_HEED_P, FLIP_WEIGHTS, FLIP_WEIGHT_TOTAL, type BotDifficulty } from "./bot-difficulty";

// ============================================================================
// TUNABLES — same convention as master-killer.ts: named constants with the
// balance rationale attached. Retune against batch-bot-difficulty.ts.
// (EASY_HEED_P, the easy tier's shared knob, lives in bot-difficulty.ts.)
// ============================================================================

/** Hard tier eval: value of a token that has escaped the board. Dominates
 *  every positional term (max positional value is 8·13 + 25 ≈ 129) so the
 *  search always prefers banking real progress over posturing. */
const EVAL_ESCAPED = 200;
/** Hard tier eval: value per tile of board progress. */
const EVAL_PER_TILE = 8;
/** Hard tier eval: penalty per token still in reserve. Without it a reserve
 *  token is worth exactly 0 — indistinguishable from one entering at tile 0 —
 *  so the search always preferred advancing an on-board token (+8·flip) over
 *  developing (+8·(flip-1)), ran 1-2 lone tokens, and burned late-game flips
 *  with no legal move (exact-roll escapes + nothing else on the board). The
 *  penalty makes development strictly attractive AND prices the re-entry
 *  tempo a capture inflicts. First sim iteration: hard-vs-standard classic
 *  was 43% WITHOUT this term — hard lost to the bot it was meant to beat.
 *  Swept -12/-20/-24/-32 once the search structure below settled; -20 won
 *  (58.9% head-to-head at 3000 games vs 56.6% at -12). */
const EVAL_RESERVE = -20;
/** Hard tier eval: bonus for sitting on a shield tile (uncapturable perch).
 *  Kept SMALL on purpose — the extra-turn tempo of landing there is priced
 *  by the search itself (bestOwnFollowup), so a big static bonus
 *  double-counts it. Swept 0/10/15/25 against the standard tier: 25 (the
 *  first guess) had hard chasing shield perches over real captures. */
const EVAL_SHIELD_TILE = 10;
/** Hard tier eval: bonus per token on the safe finish rows (tiles 12-13) —
 *  past the whole contested zone, nothing can touch it, only the exact-roll
 *  escape wait remains. Linear per-tile value undersells that safety.
 *  Swept 0/12/16/20 vs the standard tier: 0 -> ~55%, 12 -> ~57%, 16 -> best
 *  (58.9% at 3000 games paired with EVAL_RESERVE=-20), 20 -> flat-to-worse. */
const EVAL_HOME_STRETCH = 16;
/** NOTE — there is deliberately NO static "threatened token" term. The
 *  first iteration had one (probability-weighted expected capture loss per
 *  enemy in the 1..4 window). It LOST to the standard tier 43/57: the
 *  search's min-node already prices real captures, so the leaf term
 *  double-counted danger — and worse, it pre-discounted a threatened ENEMY
 *  token so far that actually capturing it gained almost nothing over
 *  merely hovering behind it (0-vs-1393 capture-decline asymmetry against
 *  standard in 15k sampled decisions). Deleting it and deepening the search
 *  one level (see worstOppReply) is what got hard past the gate. */
/** Hard tier: a certain win at the root outranks any expectation sum (the
 *  largest possible weighted contribution is < 1 · WIN_VALUE). */
const WIN_VALUE = 1_000_000;

export function pickBotMove(
  state: GameState,
  moves: Move[],
  rand: () => number = Math.random,
  difficulty: BotDifficulty = "standard",
): number {
  if (difficulty === "easy") return pickEasy(state, moves, rand);
  if (difficulty === "hard") return pickHard(state, moves, rand);
  return pickStandard(state, moves, rand);
}

// ============================================================================
// STANDARD — the original heuristic, extracted verbatim (same rand() call
// order per move) so the default tier's behavior is byte-identical to the
// pre-difficulty bot. Do not "improve" this one; that's what hard is for.
// ============================================================================

function pickStandard(state: GameState, moves: Move[], rand: () => number): number {
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

// ============================================================================
// EASY — mostly random, never suicidal about a win on the table.
// ============================================================================

function pickEasy(state: GameState, moves: Move[], rand: () => number): number {
  // Win short-circuit: an easy bot that declines to end the game produces
  // unbounded, infuriating matches — take it every time.
  const winIdx = moves.findIndex((m) => m.causesWin);
  if (winIdx !== -1) return winIdx;
  if (rand() < EASY_HEED_P) return pickStandard(state, moves, rand);
  return Math.floor(rand() * moves.length);
}

// ============================================================================
// HARD — antisymmetric static eval + one-ply expectimax over FLIP_WEIGHTS.
// ============================================================================

/** One player's side of the eval: escaped >> home stretch > progress, with
 *  a small shield-perch bonus. Purely material/positional — all danger and
 *  tempo is priced by the search (see the EVAL_HOME_STRETCH note above). */
function evalSide(state: GameState, player: PlayerId): number {
  let score = 0;
  for (const t of state.tokens) {
    if (t.owner !== player) continue;
    if (t.position >= PATH_LENGTH_PER_PLAYER) {
      score += EVAL_ESCAPED;
      continue;
    }
    if (t.position < 0) {
      score += EVAL_RESERVE; // see EVAL_RESERVE — reserve is a real liability
      continue;
    }
    score += EVAL_PER_TILE * t.position;
    if (t.position >= 12) score += EVAL_HOME_STRETCH;
    if (BOARD_LAYOUT[t.position].type === "shield") score += EVAL_SHIELD_TILE;
  }
  return score;
}

/** Antisymmetric board eval from `me`'s perspective (me minus foe). */
export function evaluateClassic(state: GameState, me: PlayerId): number {
  const foe: PlayerId = me === "p1" ? "p2" : "p1";
  return evalSide(state, me) - evalSide(state, foe);
}

// The search, root to leaf:
//   my move -> opponent's best reply per flip (min node) -> MY best next
//   move per flip (shallow max) -> eval.
// Shield landings keep the actor, so the tree follows currentPlayer instead
// of strict alternation. Two structural rules, both bought head-to-head
// wins in the sim:
//   (1) PARITY — every line ends at the same depth-parity ("the side whose
//       expectation ends the line is consistent"). The first cut stopped
//       shield lines at "I moved last" while normal lines ended "opponent
//       moved last"; the phantom one-move bonus had hard over-chasing
//       shields (592-vs-1 pick asymmetry against standard).
//   (2) The min-node leaf extends ONE more level to my shallow next-turn
//       expectation — that's what prices future mobility (wasted exact-roll
//       flips, dead boards), which no static term captured; it moved the
//       head-to-head ~3 points by itself.
// Cost: <=4 root x 5 flips x <=4 replies x 5 flips x <=4 moves ~ 1600
// 8-token evals per decision — well under a millisecond.

/** Shallow: my best immediate move for one flip, eval only. */
function myBestShallow(state: GameState, flip: number, me: PlayerId): number {
  if (flip === 0) return evaluateClassic(state, me);
  const moves = getLegalMoves(state, flip);
  if (moves.length === 0) return evaluateClassic(state, me);
  let best = -Infinity;
  for (const m of moves) {
    const v = m.causesWin ? WIN_VALUE : evaluateClassic(applyMove(state, m), me);
    if (v > best) best = v;
  }
  return best;
}

/** Shallow expectation of my next whole turn (over the five flips). */
function myTurnExpectation(state: GameState, me: PlayerId): number {
  let value = 0;
  for (let f = 0; f <= 4; f++) {
    value += (FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL) * myBestShallow(state, f, me);
  }
  return value;
}

/** Shallow: the opponent's extra turn after a shield reply — their best
 *  (our worst) follow-up expectation, eval leaves. Without this branch an
 *  opponent shield reply was priced like a quiet move, under-fearing the
 *  tempo it hands them. */
function oppExtraTurnExpectation(state: GameState, me: PlayerId): number {
  let value = 0;
  for (let f = 0; f <= 4; f++) {
    let leaf: number;
    if (f === 0) {
      leaf = evaluateClassic(state, me);
    } else {
      const moves = getLegalMoves(state, f);
      if (moves.length === 0) {
        leaf = evaluateClassic(state, me);
      } else {
        leaf = Infinity;
        for (const m of moves) {
          const v = m.causesWin ? -WIN_VALUE : evaluateClassic(applyMove(state, m), me);
          if (v < leaf) leaf = v;
        }
      }
    }
    value += (FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL) * leaf;
  }
  return value;
}

/** Opponent's best (our worst) reply for one flip — the min node. Each
 *  reply extends one level: my next-turn expectation after a normal reply,
 *  the opponent's extra-turn expectation after their shield reply. */
function worstOppReply(state: GameState, flip: number, me: PlayerId): number {
  if (flip === 0) return evaluateClassic(state, me);
  const moves = getLegalMoves(state, flip);
  if (moves.length === 0) return evaluateClassic(state, me);
  let worst = Infinity;
  for (const m of moves) {
    let v: number;
    if (m.causesWin) {
      v = -WIN_VALUE;
    } else {
      const next = applyMove(state, m);
      v = next.currentPlayer === me ? myTurnExpectation(next, me) : oppExtraTurnExpectation(next, me);
    }
    if (v < worst) worst = v;
  }
  return worst;
}

/** Expectation over the opponent's flip of their best (our worst) reply. */
function oppReplyExpectation(state: GameState, me: PlayerId): number {
  let value = 0;
  for (let f = 0; f <= 4; f++) {
    value += (FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL) * worstOppReply(state, f, me);
  }
  return value;
}

/** Best own follow-up after landing a shield extra turn, for one flip. A
 *  dead flip (0 / no moves) just skips — the board stands as evaluated.
 *  Each follow-up is then priced through the opponent's expected reply
 *  (oppReplyExpectation) per the parity rule above. A double shield landing
 *  (the follow-up lands on a shield too) is rare enough to cap the depth
 *  and eval as-is. */
function bestOwnFollowup(state: GameState, flip: number, me: PlayerId): number {
  if (flip === 0) return evaluateClassic(state, me);
  const moves = getLegalMoves(state, flip);
  if (moves.length === 0) return evaluateClassic(state, me);
  let best = -Infinity;
  for (const m of moves) {
    let v: number;
    if (m.causesWin) {
      v = WIN_VALUE;
    } else {
      const next = applyMove(state, m);
      v = next.currentPlayer === me ? evaluateClassic(next, me) : oppReplyExpectation(next, me);
    }
    if (v > best) best = v;
  }
  return best;
}

/** Expectimax root: apply each candidate, then average the next actor's
 *  best response over the five flip outcomes (see the search notes above).
 *  Tiny rand tie-break only — hard is meant to feel deterministic, no
 *  20-point jitter. */
function pickHard(state: GameState, moves: Move[], rand: () => number): number {
  const me = state.currentPlayer;
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let value: number;
    if (m.causesWin) {
      value = WIN_VALUE;
    } else {
      const next = applyMove(state, m);
      value = 0;
      for (let f = 0; f <= 4; f++) {
        const p = FLIP_WEIGHTS[f] / FLIP_WEIGHT_TOTAL;
        value +=
          p * (next.currentPlayer === me ? bestOwnFollowup(next, f, me) : worstOppReply(next, f, me));
      }
    }
    value += rand() * 1e-3;
    if (value > bestScore) {
      bestScore = value;
      bestIndex = i;
    }
  }
  return bestIndex;
}
