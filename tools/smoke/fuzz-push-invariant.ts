// Diagnostic-only, not part of the shipped test suite. Hunts for the
// "Archer captured its own token with push back" bug report by asserting an
// invariant after every applyPush call across thousands of simulated games:
// the mover's own tokens must never change position, and the only token
// that moves must be the enemy-owned target.
//
// Run: npx tsx tools/smoke/fuzz-push-invariant.ts [gamesPerMatchup]

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
  type PowerState,
} from "../../master-killer.ts";
import { pickBotPowerAction } from "../../master-killer-bot.ts";

const GAMES_PER_MATCHUP = Number(process.argv[2] ?? 3000);
const MAX_TURNS_PER_GAME = 1000;
const CLASSES: PlayerClass[] = ["archer", "mage", "warrior"];

function otherPlayerId(p: PlayerId): PlayerId {
  return p === "p1" ? "p2" : "p1";
}

let pushChecks = 0;
let failures = 0;

function checkPushInvariant(
  before: GameState,
  after: GameState,
  mover: PlayerId,
  targetTokenId: number,
): void {
  pushChecks++;
  const foe = otherPlayerId(mover);
  const beforeTarget = before.tokens.find((t) => t.id === targetTokenId)!;
  if (beforeTarget.owner !== foe) {
    failures++;
    console.error(`\n!!! INVARIANT VIOLATION (target ownership) !!!`);
    console.error(`mover=${mover} targetTokenId=${targetTokenId} targetOwner=${beforeTarget.owner} (expected ${foe})`);
    dumpState("BEFORE", before);
    dumpState("AFTER", after);
    return;
  }
  for (const bt of before.tokens) {
    const at = after.tokens.find((t) => t.id === bt.id)!;
    if (bt.position !== at.position) {
      if (bt.id !== targetTokenId) {
        failures++;
        console.error(`\n!!! INVARIANT VIOLATION (unexpected token moved) !!!`);
        console.error(
          `mover=${mover} targetTokenId=${targetTokenId} but tok${bt.id} (owner=${bt.owner}) moved ${bt.position} -> ${at.position}`,
        );
        dumpState("BEFORE", before);
        dumpState("AFTER", after);
        return;
      }
    }
  }
}

function dumpState(label: string, state: GameState) {
  console.error(`--- ${label} ---`);
  for (const t of state.tokens) {
    console.error(`  tok${t.id} owner=${t.owner} pos=${t.position}`);
  }
}

function takeTurn(state: GameState, power: PowerState, rand: () => number): { state: GameState; power: PowerState } {
  const mover = state.currentPlayer;
  let flip = flipCoins();
  let moves = getLegalPowerMoves(state, power, flip);
  const newTurnBulwark = tickBulwarkForNewTurn(state, power, flip);
  power = newTurnBulwark.power;
  let action = pickBotPowerAction(state, power, moves, flip, rand);

  if (action?.kind === "reflip") {
    power = applyReflip(power, mover);
    flip = flipCoins();
    moves = getLegalPowerMoves(state, power, flip);
    const reflipBulwark = tickBulwarkForReflip(state, power, flip);
    power = reflipBulwark.power;
    action = pickBotPowerAction(state, power, moves, flip, rand);
  }

  if (action === null || action.kind === "reflip") {
    if (flip === 0) power = grantZeroFlipCharge(power, mover);
    return { state: applyNoMove(state), power };
  }

  switch (action.kind) {
    case "move": {
      const r = applyPowerMove(state, power, action.move, mover, rand);
      return { state: r.state, power: r.power };
    }
    case "charge": {
      const r = applyCharge(state, power, action.move, mover, rand);
      return { state: r.state, power: r.power };
    }
    case "push": {
      const r = applyPush(state, power, action.targetTokenId, mover);
      checkPushInvariant(state, r.state, mover, action.targetTokenId);
      return { state: r.state, power: r.power };
    }
    case "chargedShot": {
      const r = applyChargedShot(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power };
    }
    case "blinkStrike": {
      const r = applyBlinkStrike(state, power, action.targetTokenId, mover);
      return { state: r.state, power: r.power };
    }
    case "shieldWall": {
      const r = applyShieldWall(state, power, mover);
      return { state: r.state, power: r.power };
    }
    case "bulwark": {
      const r = applyBulwark(state, power, action.tokenId, mover);
      return { state: r.state, power: r.power };
    }
  }
}

function playOne(p1Class: PlayerClass, p2Class: PlayerClass): void {
  let state: GameState = initialState();
  let power: PowerState = { ...initialPowerState(), classes: { p1: p1Class, p2: p2Class } };
  let turns = 0;
  const rand = Math.random;

  while (state.winner === null && turns < MAX_TURNS_PER_GAME) {
    turns++;
    const r = takeTurn(state, power, rand);
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

console.log(`Fuzzing Push invariant — ${GAMES_PER_MATCHUP} games per matchup.`);
for (const [a, b] of matchups) {
  for (let i = 0; i < GAMES_PER_MATCHUP; i++) {
    playOne(a, b);
    playOne(b, a);
    if (failures > 0 && failures > 20) break;
  }
  console.log(`${a} vs ${b}: done (pushChecks so far=${pushChecks}, failures so far=${failures})`);
  if (failures > 20) break;
}

console.log(`\nTotal push actions checked: ${pushChecks}`);
console.log(`Total invariant violations: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
