// Smoke test: full Master Killer CPU game driven through POST /api/room on a
// running referee (the polling transport). Replaces the deleted WS lobby
// tests. Run: PORT=8093 npx tsx referee.ts &  then  node tools/smoke/poll-cpu-game.cjs
const BASE = process.env.SMOKE_URL || "http://localhost:8093";
const API = `${BASE}/api/room`;

let seatToken = null, room = null, seat = null;
let since = 0;
let polls = 0, actions = 0, powerUsed = 0, errors = [];
let lastSeqSeen = 0;

async function post(body) {
  const r = await fetch(API, { method: "POST", body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

function ingest(view, label) {
  if (view.error && view.error !== "Busy — try again") errors.push(`${label}: ${view.error}`);
  if (view.resync) { since = view.latestSeq; return; }
  for (const ev of view.events ?? []) {
    if (ev.seq <= since) continue; // dedupe (action replies + polls overlap by design)
    if (ev.seq !== since + 1 && since > 0) errors.push(`seq gap: had ${since}, got ${ev.seq}`);
    since = ev.seq;
    lastSeqSeen = ev.seq;
  }
}

async function act(body, label) {
  actions++;
  const { body: view } = await post({ ...body, room, seat, seatToken, since });
  ingest(view, label);
  return view;
}

async function poll() {
  polls++;
  const { body: view } = await post({ op: "poll", room, seat, seatToken, since, wait: true });
  ingest(view, "poll");
  return view;
}

(async () => {
  // Health probe
  const g = await fetch(API);
  if (g.status !== 200) throw new Error(`GET /api/room -> ${g.status}`);

  // Join a CPU Master Killer room
  const { status, body: join } = await post({ op: "join", mode: "cpu", variant: "masterKiller" });
  if (status !== 200 || !join.seatToken) throw new Error(`join failed: ${JSON.stringify(join)}`);
  ({ seatToken, room, player: seat } = join);
  ingest(join.view, "join");
  console.log(`joined room ${room} as ${seat} (vsCpu=${join.vsCpu}, variant=${join.variant})`);

  // Bad-token probe must 403
  const bad = await post({ op: "poll", room, seat, seatToken: "nope", since: 0, wait: false });
  if (bad.status !== 403) errors.push(`bad token accepted: ${bad.status}`);

  // Pick a class
  let v = await act({ op: "pickClass", class: "archer" }, "pickClass");

  // Chat round-trip
  v = await act({ op: "chat", text: "  smoke <b>test</b> hello  " }, "chat");
  const chatBack = (v.chat ?? []).find((m) => m.seat === seat);
  if (!chatBack || chatBack.text !== "smoke <b>test</b> hello")
    errors.push(`chat did not round-trip: ${JSON.stringify(v.chat)}`);

  const deadline = Date.now() + 180_000;
  let flippedOpeningAt = -1;
  while (Date.now() < deadline) {
    if (v.gameOver) break;
    if (v.phase === "opening" && v.openingFlips[seat] === null && lastSeqSeen !== flippedOpeningAt) {
      flippedOpeningAt = lastSeqSeen;
      v = await act({ op: "openingFlip" }, "openingFlip");
      continue;
    }
    if (v.phase === "play" && v.yourTurn && v.flip !== null && v.powerMoves) {
      // Exercise one Push over the wire when the server says it's legal.
      const p = v.power;
      if (p && powerUsed === 0 && (p.charges[seat] ?? 0) >= 1 && p.pushTargets.length > 0) {
        powerUsed++;
        v = await act({ op: "usePower", action: { kind: "push", targetTokenId: p.pushTargets[0] } }, "push");
        continue;
      }
      if (v.powerMoves.length > 0) {
        v = await act({ op: "chooseMove", moveIndex: 0 }, "chooseMove");
        continue;
      }
      // no moves -> server auto-skips on its own clock; fall through to poll
    }
    v = await poll();
  }

  if (!v.gameOver) throw new Error("game did not finish within 3 minutes");
  console.log(`game over: winner=${v.gameOver.winner} turns=${v.gameOver.stats.turns} captures=${JSON.stringify(v.gameOver.stats.captures)}`);
  console.log(`polls=${polls} actions=${actions} pushesUsed=${powerUsed} finalSeq=${since}`);

  // Rematch path
  v = await act({ op: "newMatch" }, "newMatch");
  if (v.phase !== "classPick") errors.push(`newMatch did not reset to classPick (got ${v.phase})`);

  if (errors.length) {
    console.error("ERRORS:\n  " + errors.join("\n  "));
    process.exit(1);
  }
  console.log("SMOKE PASS: full MK CPU game + chat + push + rematch over /api/room, no seq gaps, bad token rejected.");
})().catch((e) => { console.error("SMOKE FAIL:", e.message); process.exit(1); });
