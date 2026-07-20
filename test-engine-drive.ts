// ============================================================================
// test-engine-drive.ts — drives full games through room-engine.ts EXACTLY the
// way a polling transport would: applyAction() for the "human" seat, tick()
// with an advancing fake clock for everything timed (bot turns, auto-skips,
// opening resolution). The p1 seat plays the same bot policy as p2, so the
// aggregate stats must reproduce batch-random-master-killer-games.ts within
// noise — that harness is the oracle this one is checked against.
//
// Also asserts transport invariants the batch harness can't see:
//   - seq strictly increasing, events bounded to EVENT_WINDOW
//   - the doc survives a JSON round-trip every step (Redis does this for
//     real; a Set/undefined smuggled into the doc would corrupt silently)
//   - games terminate (no deadline deadlocks)
//
// Run:  npx tsx test-engine-drive.ts [gamesPerMatchup]
// ============================================================================

import { getLegalMoves, type PlayerId } from "./rulebook";
import { pickBotMove } from "./bot";
import { pickBotPowerAction } from "./master-killer-bot";
import type { PlayerClass } from "./master-killer";
import type { BotDifficulty } from "./bot-difficulty";
import {
  createRoomDoc,
  applyAction,
  tick,
  viewFor,
  fromWirePower,
  publicPower,
  EVENT_WINDOW,
  type RoomDoc,
  type RoomActionInput,
  type WirePowerState,
} from "./room-engine";

const GAMES = Number(process.argv[2] ?? 400);
const MAX_STEPS = 5000;

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`ASSERT FAILED: ${msg}`);
  }
}

/** Simulate the Redis round-trip every store performs. */
function roundTrip(doc: RoomDoc): RoomDoc {
  return JSON.parse(JSON.stringify(doc)) as RoomDoc;
}

interface GameResult {
  winner: PlayerId | null;
  turns: number;
  steps: number;
}

function playOne(
  variant: "classic" | "masterKiller",
  p1Class: PlayerClass,
  p2Class: PlayerClass,
  difficulty: BotDifficulty = "standard",
): GameResult {
  let now = 1_000_000;
  let doc = createRoomDoc("TEST", true, variant, "p1tok", now, false, difficulty);
  let lastSeq = 0;
  let steps = 0;

  const step = (): void => {
    steps++;
    // Advance far enough that every pending deadline is due (mirrors a
    // room resuming after idle — deadlines are absolute).
    now += 5000;
    doc = roundTrip(tick(doc, now));

    assert(doc.seq >= lastSeq, `seq went backwards ${lastSeq} -> ${doc.seq}`);
    assert(doc.events.length <= EVENT_WINDOW, `events overflow: ${doc.events.length}`);
    for (let i = 1; i < doc.events.length; i++) {
      assert(doc.events[i].seq === doc.events[i - 1].seq + 1, "event seq gap inside window");
    }
    lastSeq = doc.seq;

    // Force the matchup: the harness pokes the bot's class the moment the
    // tick picks one (test-only; a client can't do this).
    if (variant === "masterKiller" && doc.mk && doc.classesPicked.p2 && doc.mk.classes.p2 !== p2Class) {
      doc = { ...doc, mk: { ...doc.mk, classes: { ...doc.mk.classes, p2: p2Class } } };
    }

    const act = (action: RoomActionInput) => {
      const r = applyAction(doc, "p1", action, now);
      assert(!r.error, `p1 action rejected: ${r.error} (${JSON.stringify(action).slice(0, 80)})`);
      doc = roundTrip(r.doc);
    };

    // p1 ("human" seat) plays the same policy as the bot.
    if (doc.phase === "classPick" && !doc.classesPicked.p1) {
      act({ op: "pickClass", class: p1Class });
      return;
    }
    if (doc.phase === "opening" && doc.openingFlips.p1 === null) {
      act({ op: "openingFlip" });
      return;
    }
    if (doc.phase === "play" && !doc.state.winner && doc.state.currentPlayer === "p1" && doc.currentFlip !== null) {
      if (variant === "masterKiller" && doc.mk) {
        const moves = doc.currentPowerMoves ?? [];
        const action = pickBotPowerAction(doc.state, fromWirePower(doc.mk), moves, doc.currentFlip, Math.random, difficulty);
        if (!action) return; // dead flip, no rescue — tick auto-skips
        if (action.kind === "move") {
          act({ op: "chooseMove", moveIndex: moves.indexOf(action.move) });
        } else if (action.kind === "charge") {
          act({ op: "usePower", action: { kind: "charge", moveIndex: moves.indexOf(action.move) } });
        } else {
          act({ op: "usePower", action } as RoomActionInput);
          if (action.kind === "reflip") {
            // The re-flip commit must announce itself even when the charge
            // math nets to zero (cost refunded by a zero replacement flip) —
            // the client's Reroll! proc keys on this field, not the delta.
            const newest = doc.events[doc.events.length - 1];
            assert(
              newest?.kind === "state" && newest.lastReflip?.player === "p1",
              "reflip commit missing lastReflip",
            );
          }
          if (action.kind === "revive") {
            // Same contract for the Necromancer's turn-keeping act: the
            // revive commit must announce itself (the client's Revive!
            // proc and the rise animation key on this field) and keep the
            // flip alive for the recomputed move list.
            const newest = doc.events[doc.events.length - 1];
            assert(
              newest?.kind === "state" && newest.lastRevive != null,
              "revive commit missing lastRevive",
            );
            assert(doc.currentFlip !== null, "revive commit dropped the flip");
          }
        }
        return;
      }
      const moves = getLegalMoves(doc.state, doc.currentFlip);
      if (moves.length === 0) return; // tick auto-skips
      act({ op: "chooseMove", moveIndex: pickBotMove(doc.state, moves, Math.random, difficulty) });
    }
  };

  while (steps < MAX_STEPS) {
    step();
    if (doc.state.winner) break;
  }

  // Exercise viewFor from both seats at game end (leak/shape sanity).
  for (const seat of ["p1", "p2"] as PlayerId[]) {
    const v = viewFor(doc, seat, 0, now);
    assert(v.latestSeq === doc.seq, "view latestSeq mismatch");
    if (doc.state.winner) assert(v.gameOver !== null, "gameOver missing from view");
    if (seat !== doc.state.currentPlayer) {
      assert(v.legalMoves === null && v.powerMoves === null, "moves leaked to non-current seat");
    }
  }

  return { winner: doc.state.winner, turns: doc.turns, steps };
}

function runMatchup(
  label: string,
  variant: "classic" | "masterKiller",
  a: PlayerClass,
  b: PlayerClass,
  difficulty: BotDifficulty = "standard",
  games = GAMES,
) {
  let aWins = 0;
  let stale = 0;
  let turnsSum = 0;
  for (let i = 0; i < games; i++) {
    // Alternate seatings so first-mover luck cancels out, like the oracle.
    const flip = i % 2 === 1;
    const r = playOne(variant, flip ? b : a, flip ? a : b, difficulty);
    if (r.winner === null) stale++;
    else if ((r.winner === "p1") !== flip) aWins++;
    turnsSum += r.turns;
  }
  const aPct = ((aWins / (games - stale)) * 100).toFixed(1);
  console.log(
    `${label.padEnd(20)} ${a}=${aPct}%  turns/g=${(turnsSum / games).toFixed(1)}  stalemates=${stale}`,
  );
}

console.log(`Engine-drive validation — ${GAMES} games per matchup through applyAction()/tick().`);
runMatchup("classic", "classic" as never, "archer", "archer"); // classes ignored in classic
runMatchup("archer mirror", "masterKiller", "archer", "archer");
runMatchup("archer vs mage", "masterKiller", "archer", "mage");
runMatchup("archer vs warrior", "masterKiller", "archer", "warrior");
runMatchup("mage mirror", "masterKiller", "mage", "mage");
runMatchup("mage vs warrior", "masterKiller", "mage", "warrior");
runMatchup("warrior mirror", "masterKiller", "warrior", "warrior");
// Necromancer matchups drive the engine surface no other harness reaches:
// applyMkRaise's act-then-redecide cycle (flip preserved, moves recomputed),
// validateUsePower's raiseDead/exhume branches through the human path, and
// the lastRaise/lastExhume/lastSoulHarvest announcements.
runMatchup("necromancer mirror", "masterKiller", "necromancer", "necromancer");
runMatchup("necro vs warrior", "masterKiller", "necromancer", "warrior");
// Difficulty smoke: small runs at easy and hard so the transport invariants
// (seq monotonic, JSON round-trip — difficulty is a plain string, Redis-safe;
// termination under MAX_STEPS, which also bounds hard-tier think time) cover
// every tier. Default runs above stay standard so the oracle comparison
// against batch-random-master-killer-games.ts is unchanged.
const SMOKE = Math.max(20, Math.floor(GAMES / 5));
runMatchup("classic easy", "classic" as never, "archer", "archer", "easy", SMOKE);
runMatchup("classic hard", "classic" as never, "archer", "archer", "hard", SMOKE);
runMatchup("mk mirror easy", "masterKiller", "warrior", "warrior", "easy", SMOKE);
runMatchup("mk mirror hard", "masterKiller", "mage", "mage", "hard", SMOKE);

// ---------------------------------------------------------------------------
// Bulwark display window: a Bulwark that blocked THIS flip is consumed by
// tickBulwarkForNewTurn before the broadcast, but it is still doing its job
// for the rest of the turn (the served move list was computed with it up) —
// so publicPower must keep it VISIBLE until the turn resolves and
// CLEAR_SLOTS wipes lastBulwarkBlock. Regression for Kasen's 2026-07-19
// "the glow wore off but it's still activating" report.
// ---------------------------------------------------------------------------
{
  const base = createRoomDoc("BWTEST", true, "masterKiller", "tok", 0, false);
  const mk: WirePowerState & { classes: Record<PlayerId, PlayerClass> } = {
    classes: { p1: "warrior", p2: "archer" },
    charges: { p1: 0, p2: 0 },
    reflipsUsedThisTurn: 0,
    shieldStreak: { p1: 0, p2: 1 },
    ultimateReady: { p1: false, p2: false },
    bulwarked: { 2: 3 }, // one live Bulwark elsewhere on the table
    bulwarkSaves: { 2: 2 },
    corpse: { p1: null, p2: null },
    thrall: { p1: null, p2: null },
  };
  const blockedDoc: RoomDoc = {
    ...base,
    phase: "play",
    mk,
    lastBulwarkBlock: { tokenIds: [5] }, // consumed this flip — gone from mk.bulwarked
  };
  const pp = publicPower(blockedDoc)!;
  assert(pp.bulwarkedTokenIds.includes(5), "blocked-this-flip Bulwark stays in the visible list");
  assert(pp.bulwarkedTokenIds.includes(2), "live Bulwark stays in the visible list");
  const ppAfter = publicPower({ ...blockedDoc, lastBulwarkBlock: null })!;
  assert(!ppAfter.bulwarkedTokenIds.includes(5), "consumed Bulwark leaves the list once the turn resolves");
  assert(ppAfter.bulwarkedTokenIds.includes(2), "live Bulwark unaffected by the slot clearing");
  // The activity-log debug fields mirror the raw lifecycle numbers.
  assert(pp.bulwarkTurns?.[2] === 3 && pp.bulwarkSavesLeft?.[2] === 2, "bulwark lifecycle numbers ride the broadcast");
  assert(pp.shieldStreak?.p2 === 1, "shield streak rides the broadcast");
}

if (failures > 0) {
  console.error(`\n${failures} assertion failure(s).`);
  process.exit(1);
}
console.log("\nAll engine-drive invariants held.");
