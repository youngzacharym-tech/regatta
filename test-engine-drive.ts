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
import {
  createRoomDoc,
  applyAction,
  tick,
  viewFor,
  fromWirePower,
  EVENT_WINDOW,
  type RoomDoc,
  type RoomActionInput,
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

function playOne(variant: "classic" | "masterKiller", p1Class: PlayerClass, p2Class: PlayerClass): GameResult {
  let now = 1_000_000;
  let doc = createRoomDoc("TEST", true, variant, "p1tok", now);
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
        const action = pickBotPowerAction(doc.state, fromWirePower(doc.mk), moves, doc.currentFlip, Math.random);
        if (!action) return; // dead flip, no rescue — tick auto-skips
        if (action.kind === "move") {
          act({ op: "chooseMove", moveIndex: moves.indexOf(action.move) });
        } else if (action.kind === "charge") {
          act({ op: "usePower", action: { kind: "charge", moveIndex: moves.indexOf(action.move) } });
        } else {
          act({ op: "usePower", action } as RoomActionInput);
        }
        return;
      }
      const moves = getLegalMoves(doc.state, doc.currentFlip);
      if (moves.length === 0) return; // tick auto-skips
      act({ op: "chooseMove", moveIndex: pickBotMove(doc.state, moves) });
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

function runMatchup(label: string, variant: "classic" | "masterKiller", a: PlayerClass, b: PlayerClass) {
  let aWins = 0;
  let stale = 0;
  let turnsSum = 0;
  for (let i = 0; i < GAMES; i++) {
    // Alternate seatings so first-mover luck cancels out, like the oracle.
    const flip = i % 2 === 1;
    const r = playOne(variant, flip ? b : a, flip ? a : b);
    if (r.winner === null) stale++;
    else if ((r.winner === "p1") !== flip) aWins++;
    turnsSum += r.turns;
  }
  const aPct = ((aWins / (GAMES - stale)) * 100).toFixed(1);
  console.log(
    `${label.padEnd(20)} ${a}=${aPct}%  turns/g=${(turnsSum / GAMES).toFixed(1)}  stalemates=${stale}`,
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

if (failures > 0) {
  console.error(`\n${failures} assertion failure(s).`);
  process.exit(1);
}
console.log("\nAll engine-drive invariants held.");
