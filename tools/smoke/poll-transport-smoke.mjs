// Diagnostic-only smoke for the HTTP long-polling transport (room-engine.ts
// via referee.ts's POST /api/room). Drives REAL games end-to-end over the
// wire — no engine imports, everything through the public contract:
//   A. full Master Killer game vs CPU (class pick -> opening -> play -> win)
//   B. two-seat PvP Master Killer game with power actions + a chat exchange
//   C. listRooms sanity (a created listed room shows up; unlisted doesn't)
//
// Run: node tools/smoke/poll-transport-smoke.mjs [baseUrl]
//      (default http://localhost:8093 — start `PORT=8093 npm run referee`)

const BASE = process.argv[2] ?? "http://localhost:8093";
const API = `${BASE}/api/room`;
const MAX_TURN_STEPS = 3000; // poll iterations per game before declaring a stall

let failures = 0;
function fail(msg) {
  failures++;
  console.error(`!!! SMOKE FAILURE: ${msg}`);
}

async function post(body, retried = false) {
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for op=${body.op}`);
    return await res.json();
  } catch (e) {
    // Transient keepalive resets are expected across thousands of localhost
    // requests — retry once. Actions are safe: a duplicate lands against the
    // already-advanced doc and comes back as an error reply + fresh view,
    // which the drivers already tolerate.
    if (retried) throw e;
    await new Promise((r) => setTimeout(r, 150));
    return post(body, true);
  }
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** One driver step for a seat: advance whatever the view says is pending.
 *  Returns true if it sent an action (vs just needing another poll). */
async function stepSeat(client, view, cls) {
  const { room, seat, seatToken } = client;
  const send = (action) => post({ room, seat, seatToken, since: view.latestSeq, ...action });

  if (view.gameOver) return { done: true };

  if (view.classPick && !view.classPick.classes[seat]) {
    await send({ op: "pickClass", class: cls });
    return { acted: true };
  }
  if (view.phase === "opening" && view.openingFlips[seat] === null) {
    await send({ op: "openingFlip" });
    return { acted: true };
  }
  if (view.phase === "play" && view.yourTurn) {
    const p = view.power;
    // Occasionally exercise a power action when one is legal.
    if (p && Math.random() < 0.3) {
      const myCls = p.classes[seat];
      const opts = [];
      if (myCls === "archer" && p.pushTargets.length) opts.push({ op: "usePower", action: { kind: "push", targetTokenId: pickRandom(p.pushTargets) } });
      if (myCls === "archer" && p.chargedShotTargets.length) opts.push({ op: "usePower", action: { kind: "chargedShot", targetTokenId: pickRandom(p.chargedShotTargets) } });
      if (myCls === "warrior" && p.bulwarkTargets.length) opts.push({ op: "usePower", action: { kind: "bulwark", tokenId: pickRandom(p.bulwarkTargets) } });
      if (myCls === "mage" && p.blinkStrikeTargets.length) opts.push({ op: "usePower", action: { kind: "blinkStrike", targetTokenId: pickRandom(p.blinkStrikeTargets) } });
      if (myCls === "warrior" && p.shieldWallTargets?.length) opts.push({ op: "usePower", action: { kind: "shieldWall" } });
      if (myCls === "rogue" && p.pickpocketTargets?.length) opts.push({ op: "usePower", action: { kind: "pickpocket", targetTokenId: pickRandom(p.pickpocketTargets) } });
      // Vanish, not Backstab — that ability was retired on 2026-07-22 and
      // this line still named it, so the rogue's second active was never
      // actually exercised over the wire.
      if (myCls === "rogue" && p.vanishTargets?.length) opts.push({ op: "usePower", action: { kind: "vanish", tokenId: pickRandom(p.vanishTargets) } });
      if (myCls === "rogue" && p.grandHeistTargets?.length) opts.push({ op: "usePower", action: { kind: "grandHeist", targetTokenId: pickRandom(p.grandHeistTargets) } });
      if (myCls === "hunter" && p.snareTiles?.length) opts.push({ op: "usePower", action: { kind: "snare", tile: pickRandom(p.snareTiles) } });
      if (myCls === "hunter" && p.piercingShotTargets?.length) opts.push({ op: "usePower", action: { kind: "piercingShot" } });
      if (myCls === "hunter" && p.wildHuntTargets?.length) opts.push({ op: "usePower", action: { kind: "wildHunt" } });
      if (myCls === "barbarian" && p.recklessSwingTargets?.length) opts.push({ op: "usePower", action: { kind: "recklessSwing", targetTokenId: pickRandom(p.recklessSwingTargets) } });
      if (myCls === "barbarian" && p.whirlwindTargets?.length) opts.push({ op: "usePower", action: { kind: "whirlwind" } });
      if (myCls === "barbarian" && p.bloodbathTargets?.length) opts.push({ op: "usePower", action: { kind: "bloodbath" } });
      if (myCls === "bard" && p.inspireTargets?.length) opts.push({ op: "usePower", action: { kind: "inspire", targetTokenId: pickRandom(p.inspireTargets) } });
      if (myCls === "bard" && p.songOfHasteTargets?.length) opts.push({ op: "usePower", action: { kind: "songOfHaste" } });
      if (myCls === "bard" && p.crescendoTargets?.length) opts.push({ op: "usePower", action: { kind: "crescendo" } });
      if (myCls === "warlock" && p.curseTargets?.length) opts.push({ op: "usePower", action: { kind: "curse", targetTokenId: pickRandom(p.curseTargets) } });
      if (myCls === "warlock" && p.sacrificeTargets?.length) opts.push({ op: "usePower", action: { kind: "sacrifice", targetTokenId: pickRandom(p.sacrificeTargets) } });
      if (myCls === "warlock" && p.felStormTargets?.length) opts.push({ op: "usePower", action: { kind: "felStorm" } });
      if (opts.length) {
        const r = await send(pickRandom(opts));
        if (r.error) client.powerErrors.push(r.error); // legal races (auto-skip) are fine — count, don't fail
        else client.powersUsed++;
        return { acted: true };
      }
    }
    const moves = view.powerMoves ?? view.legalMoves;
    if (moves && moves.length > 0) {
      const idx = Math.floor(Math.random() * moves.length);
      const r = await send({ op: "chooseMove", moveIndex: idx });
      if (r.error) client.moveErrors.push(r.error);
      else client.movesMade++;
      return { acted: true };
    }
    // Dead flip — the engine's tick auto-skips it; just poll again.
  }
  return { acted: false };
}

async function pollView(client, wait = false) {
  const { room, seat, seatToken } = client;
  const v = await post({ room, seat, seatToken, op: "poll", since: client.since, wait });
  if (v.latestSeq < client.since && !v.resync) fail(`seq went backwards for ${seat}: ${client.since} -> ${v.latestSeq}`);
  client.since = v.latestSeq;
  return v;
}

function newClient(joinResp) {
  return {
    room: joinResp.room,
    seat: joinResp.player,
    seatToken: joinResp.seatToken,
    since: joinResp.view.latestSeq,
    movesMade: 0,
    powersUsed: 0,
    moveErrors: [],
    powerErrors: [],
  };
}

async function gameVsCpu() {
  console.log("--- A: Master Killer vs CPU ---");
  const j = await post({ op: "join", mode: "cpu", variant: "masterKiller" });
  if (!j.seatToken || !j.view) return fail("cpu join: malformed RoomJoinResponse");
  if (!j.vsCpu) fail("cpu join: vsCpu flag not set");
  const me = newClient(j);
  const cls = pickRandom(["bard"]);
  console.log(`joined room ${me.room} as ${me.seat}, class ${cls}`);

  let idlePolls = 0;
  for (let step = 0; step < MAX_TURN_STEPS; step++) {
    // Long-poll (server holds until news) once we're just waiting on the CPU;
    // fast-poll while we have something pending to send.
    const view = await pollView(me, idlePolls > 0);
    const r = await stepSeat(me, view, cls);
    if (r.done) {
      console.log(
        `game over — winner=${view.gameOver.winner} turns=${view.gameOver.stats.turns} myMoves=${me.movesMade} powers=${me.powersUsed} rejections=${me.moveErrors.length + me.powerErrors.length}`,
      );
      if (me.movesMade === 0) fail("cpu game: human seat never made a move");
      return;
    }
    idlePolls = r.acted ? 0 : idlePolls + 1;
    if (!r.acted) await new Promise((res) => setTimeout(res, 100));
  }
  fail(`cpu game: no winner after ${MAX_TURN_STEPS} steps (stall)`);
}

async function gamePvp() {
  console.log("--- B: Master Killer PvP (two seats) + chat ---");
  const j1 = await post({ op: "join", mode: "create", variant: "masterKiller" });
  const c1 = newClient(j1);
  const j2 = await post({ op: "join", mode: "join", room: c1.room });
  if (j2.player === c1.seat) fail("pvp: second join got the same seat");
  const c2 = newClient(j2);
  console.log(`room ${c1.room}: seats ${c1.seat} + ${c2.seat}`);

  // Chat round-trip before play starts.
  await post({ room: c1.room, seat: c1.seat, seatToken: c1.seatToken, op: "chat", text: "  gl hf   <b>not html</b>  " });
  const v2 = await pollView(c2);
  const line = v2.chat[v2.chat.length - 1];
  if (!line || line.seat !== c1.seat) fail("pvp chat: line did not reach the other seat");
  else if (line.text !== "gl hf <b>not html</b>") fail(`pvp chat: sanitize mismatch: "${line.text}"`);
  else console.log(`chat ok: [${line.seat}] "${line.text}"`);

  const classes = { [c1.seat]: "bard", [c2.seat]: "barbarian" };
  for (let step = 0; step < MAX_TURN_STEPS; step++) {
    for (const c of [c1, c2]) {
      const view = await pollView(c);
      const r = await stepSeat(c, view, classes[c.seat]);
      if (r.done) {
        console.log(
          `game over — winner=${view.gameOver.winner} turns=${view.gameOver.stats.turns} ` +
            `moves p1/p2=${c1.movesMade}/${c2.movesMade} powers=${c1.powersUsed + c2.powersUsed} rejections=${
              c1.moveErrors.length + c1.powerErrors.length + c2.moveErrors.length + c2.powerErrors.length
            }`,
        );
        if (c1.movesMade === 0 || c2.movesMade === 0) fail("pvp: a seat never moved");
        return;
      }
    }
    await new Promise((res) => setTimeout(res, 40));
  }
  fail(`pvp game: no winner after ${MAX_TURN_STEPS} steps (stall)`);
}

async function lobbyList() {
  console.log("--- C: listRooms ---");
  const listed = await post({ op: "join", mode: "create", variant: "classic" });
  const unlisted = await post({ op: "join", mode: "create", variant: "classic", unlisted: true });
  const l = await post({ op: "listRooms" });
  const codes = l.rooms.map((r) => r.code);
  if (!codes.includes(listed.room)) fail(`listRooms: listed room ${listed.room} missing from lobby`);
  if (codes.includes(unlisted.room)) fail(`listRooms: unlisted room ${unlisted.room} LEAKED into lobby`);
  if (failures === 0) console.log(`lobby ok: ${listed.room} visible, ${unlisted.room} hidden (${l.rooms.length} open rooms)`);
}

try {
  await gameVsCpu();
  await gamePvp();
  await lobbyList();
} catch (e) {
  fail(`unhandled: ${e.message}`);
}

console.log(failures === 0 ? "\nALL TRANSPORT SMOKE CHECKS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures > 0 ? 1 : 0);
