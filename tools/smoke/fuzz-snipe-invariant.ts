// Diagnostic-only, not part of the shipped test suite. Hunts for the
// unreproduced "Snipe hit my own token (one turn after I captured)" report
// by asserting invariants over EVERY legal move generated on EVERY turn
// across thousands of simulated games — not just the moves the bot picks:
//   1. move.captures never contains a mover-owned token id
//   2. move.bonusCaptures (Snipe) never contains a mover-owned token id,
//      never contains the moving token itself, and is empty for non-Archers
//   3. move.chargeSweepCaptures never contains a mover-owned token id
//   4. after any applied action, no mover-owned token other than the moved
//      one changes position (Push has its own harness; still covered here)
// Also counts how often the reported pattern (a Snipe fired by a player who
// captured on their previous turn) was actually exercised, so a clean run
// means "the scenario happened N times and never misfired," not "the
// scenario never came up."
//
// Run: npx tsx tools/smoke/fuzz-snipe-invariant.ts [gamesPerMatchup]

import { initialState, flipCoins, applyNoMove, type GameState, type PlayerId } from "../../rulebook.ts";
import {
  applyBlinkStrike,
  applyBulwark,
  applyCharge,
  applyChargedShot,
  applyPowerMove,
  applyPush,
  applyReflip,
  applyShieldWall,
  getLegalPowerMoves,
  grantZeroFlipCharge,
  initialPowerState,
  tickBulwarkForNewTurn,
  tickBulwarkForReflip,
  type PlayerClass,
  type PowerMove,
  type PowerState,
} from "../../master-killer.ts";
import { pickBotPowerAction } from "../../master-killer-bot.ts";

const GAMES_PER_MATCHUP = Number(process.argv[2] ?? 3000);
const MAX_TURNS_PER_GAME = 1000;
const CLASSES: PlayerClass[] = ["archer", "mage", "warrior"];

function otherPlayerId(p: PlayerId): PlayerId {
  return p === "p1" ? "p2" : "p1";
}

let movesChecked = 0;
let snipeMovesSeen = 0;
let snipeAfterCapturePattern = 0;
let appliesChecked = 0;
let failures = 0;

function dumpState(label: string, state: GameState) {
  console.error(`--- ${label} ---`);
  for (const t of state.tokens) {
    console.error(`  tok${t.id} owner=${t.owner} pos=${t.position}`);
  }
}

function fail(msg: string, state: GameState) {
  failures++;
  console.error(`\n!!! INVARIANT VIOLATION: ${msg}`);
  dumpState("STATE", state);
}

function checkGeneratedMoves(
  state: GameState,
  power: PowerState,
  moves: PowerMove[],
  mover: PlayerId,
  moverCapturedLastTurn: boolean,
): void {
  const cls = power.classes[mover];
  for (const m of moves) {
    movesChecked++;
    for (const id of m.captures) {
      const t = state.tokens.find((tok) => tok.id === id)!;
      if (t.owner === mover) fail(`captures contains OWN token tok${id} (mover=${mover}, move ${m.from}->${m.to})`, state);
    }
    for (const id of m.bonusCaptures) {
      const t = state.tokens.find((tok) => tok.id === id)!;
      if (t.owner === mover) fail(`Snipe bonusCaptures contains OWN token tok${id} (mover=${mover}, move ${m.from}->${m.to})`, state);
      if (id === m.tokenId) fail(`Snipe bonusCaptures contains the MOVING token tok${id} itself`, state);
    }
    if (m.bonusCaptures.length > 0) {
      snipeMovesSeen++;
      if (moverCapturedLastTurn) snipeAfterCapturePattern++;
      if (cls !== "archer") fail(`non-Archer (${cls}) generated a Snipe bonusCapture`, state);
    }
    for (const id of m.chargeSweepCaptures) {
      const t = state.tokens.find((tok) => tok.id === id)!;
      if (t.owner === mover) fail(`chargeSweepCaptures contains OWN token tok${id} (mover=${mover})`, state);
    }
  }
}

function checkApplied(before: GameState, after: GameState, mover: PlayerId, movedTokenId: number | null): void {
  appliesChecked++;
  for (const bt of before.tokens) {
    if (bt.owner !== mover) continue;
    if (movedTokenId !== null && bt.id === movedTokenId) continue;
    const at = after.tokens.find((t) => t.id === bt.id)!;
    if (bt.position !== at.position) {
      fail(
        `mover's OWN token tok${bt.id} moved ${bt.position} -> ${at.position} as a side effect (mover=${mover}, moved tok=${movedTokenId})`,
        before,
      );
    }
  }
}

function takeTurn(
  state: GameState,
  power: PowerState,
  rand: () => number,
  moverCapturedLastTurn: boolean,
): { state: GameState; power: PowerState; captured: boolean } {
  const mover = state.currentPlayer;
  let flip = flipCoins();
  let moves = getLegalPowerMoves(state, power, flip);
  const newTurnBulwark = tickBulwarkForNewTurn(state, power, flip);
  power = newTurnBulwark.power;
  checkGeneratedMoves(state, power, moves, mover, moverCapturedLastTurn);
  let action = pickBotPowerAction(state, power, moves, flip, rand);

  if (action?.kind === "reflip") {
    power = applyReflip(power, mover);
    flip = flipCoins();
    moves = getLegalPowerMoves(state, power, flip);
    const reflipBulwark = tickBulwarkForReflip(state, power, flip);
    power = reflipBulwark.power;
    checkGeneratedMoves(state, power, moves, mover, moverCapturedLastTurn);
    action = pickBotPowerAction(state, power, moves, flip, rand);
  }

  if (action === null || action.kind === "reflip") {
    if (flip === 0) power = grantZeroFlipCharge(power, mover);
    return { state: applyNoMove(state), power, captured: false };
  }

  switch (action.kind) {
    case "move": {
      const r = applyPowerMove(state, power, action.move, mover, rand);
      checkApplied(state, r.state, mover, action.move.tokenId);
      return { state: r.state, power: r.power, captured: action.move.captures.length + action.move.bonusCaptures.length > 0 };
    }
    case "charge": {
      const r = applyCharge(state, power, action.move, mover, rand);
      checkApplied(state, r.state, mover, action.move.tokenId);
      return {
        state: r.state,
        power: r.power,
        captured: action.move.captures.length + action.move.bonusCaptures.length + action.move.chargeSweepCaptures.length > 0,
      };
    }
    case "push": {
      const r = applyPush(state, power, action.targetTokenId, mover);
      checkApplied(state, r.state, mover, null);
      return { state: r.state, power: r.power, captured: false };
    }
    case "chargedShot": {
      const r = applyChargedShot(state, power, action.targetTokenId, mover);
      checkApplied(state, r.state, mover, null);
      return { state: r.state, power: r.power, captured: false };
    }
    case "blinkStrike": {
      const before = state;
      const r = applyBlinkStrike(state, power, action.targetTokenId, mover);
      // Blink Strike moves the Mage's own most-advanced token — exempt it.
      const moved = before.tokens.find((bt) => {
        const at = r.state.tokens.find((t) => t.id === bt.id)!;
        return bt.owner === mover && bt.position !== at.position;
      });
      checkApplied(before, r.state, mover, moved ? moved.id : null);
      return { state: r.state, power: r.power, captured: true };
    }
    case "shieldWall": {
      // No target, no move, no capture (2026-09-17, replaces Warpath).
      const r = applyShieldWall(state, power, mover);
      checkApplied(state, r.state, mover, null);
      return { state: r.state, power: r.power, captured: false };
    }
    case "bulwark": {
      const r = applyBulwark(state, power, action.tokenId, mover);
      checkApplied(state, r.state, mover, null);
      return { state: r.state, power: r.power, captured: false };
    }
  }
}

function playOne(p1Class: PlayerClass, p2Class: PlayerClass): void {
  let state: GameState = initialState();
  let power: PowerState = { ...initialPowerState(), classes: { p1: p1Class, p2: p2Class } };
  let turns = 0;
  const rand = Math.random;
  // Track, per player, whether their PREVIOUS turn captured — to count how
  // often the reported "Snipe right after a capture" pattern is exercised.
  const capturedLastTurn: Record<PlayerId, boolean> = { p1: false, p2: false };

  while (state.winner === null && turns < MAX_TURNS_PER_GAME) {
    turns++;
    const mover = state.currentPlayer;
    const r = takeTurn(state, power, rand, capturedLastTurn[mover]);
    capturedLastTurn[mover] = r.captured;
    state = r.state;
    power = r.power;
  }
}

const matchups: [PlayerClass, PlayerClass][] = [];
for (let i = 0; i < CLASSES.length; i++) {
  for (let j = i; j < CLASSES.length; j++) {
    matchups.push([CLASSES[i], CLASSES[j]]);
  }
}

console.log(`Fuzzing Snipe/capture invariants — ${GAMES_PER_MATCHUP} games per matchup.`);
for (const [a, b] of matchups) {
  for (let i = 0; i < GAMES_PER_MATCHUP; i++) {
    playOne(a, b);
    playOne(b, a);
    if (failures > 20) break;
  }
  console.log(
    `${a} vs ${b}: done (moves=${movesChecked}, snipes=${snipeMovesSeen}, snipe-after-capture=${snipeAfterCapturePattern}, failures=${failures})`,
  );
  if (failures > 20) break;
}

console.log(`\nLegal moves checked: ${movesChecked}`);
console.log(`Snipe moves generated: ${snipeMovesSeen}`);
console.log(`Snipe-immediately-after-a-capture pattern hits: ${snipeAfterCapturePattern}`);
console.log(`Applied actions checked: ${appliesChecked}`);
console.log(`Invariant violations: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
