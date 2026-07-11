// Production lobby test (Vercel deployment). Differences from local:
// rooms survive disconnects (no opponentLeft); instead we verify the REJOIN
// flow — drop a connection mid-game and resume the same seat with the token.
const WebSocket = require("ws");
const URL = "wss://regatta-one.vercel.app/api/ws";

function client(name) {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  return {
    ws,
    name,
    send: (m) => ws.send(JSON.stringify(m)),
    next: (ms = 15000) =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((res, rej) => {
            waiters.push(res);
            setTimeout(() => rej(new Error(`${name}: timed out waiting`)), ms);
          }),
    open: () => new Promise((res) => ws.once("open", res)),
  };
}

async function waitFor(c, pred, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${c.name}: condition timeout`);
    const msg = await c.next(remaining);
    if (pred(msg)) return msg;
  }
}

(async () => {
  // --- Two concurrent PvP rooms ---------------------------------------
  const a1 = client("a1"), b1 = client("b1");
  await a1.open(); await b1.open();
  a1.send({ type: "join", mode: "create" });
  b1.send({ type: "join", mode: "create" });
  const roleA1 = await waitFor(a1, (m) => m.type === "role");
  const roleB1 = await waitFor(b1, (m) => m.type === "role");
  if (roleA1.room === roleB1.room) throw new Error("room code collision");

  const a2 = client("a2"), b2 = client("b2");
  await a2.open(); await b2.open();
  a2.send({ type: "join", mode: "join", room: roleA1.room.toLowerCase() });
  b2.send({ type: "join", mode: "join", room: roleB1.room });
  const roleA2 = await waitFor(a2, (m) => m.type === "role");
  await waitFor(b2, (m) => m.type === "role");

  // Bad code errors.
  const bad = client("bad");
  await bad.open();
  bad.send({ type: "join", mode: "join", room: "ZZZZ" });
  const badMsg = await waitFor(bad, (m) => m.type === "error");
  if (!/not found/i.test(badMsg.message)) throw new Error("bad-code error wrong");
  bad.ws.close();
  console.log("ROOMS OK:", roleA1.room, "+", roleB1.room, "concurrent; bad code rejected");

  // Play 4 moves in each room (whoever gets legalMoves plays index 0).
  async function playMoves(clients, n) {
    let played = 0;
    while (played < n) {
      for (const c of clients) {
        const msg = await Promise.race([
          c.next(30000),
          new Promise((r) => setTimeout(() => r(null), 200)),
        ]);
        if (
          msg && msg.type === "state" && msg.legalMoves &&
          msg.legalMoves.length && msg.state.winner === null
        ) {
          c.send({ type: "chooseMove", moveIndex: 0 });
          played++;
        }
      }
    }
    return played;
  }
  await Promise.all([playMoves([a1, a2], 4), playMoves([b1, b2], 4)]);
  console.log("MOVES OK: both rooms progressing independently");

  // --- Rejoin: drop a1 mid-game, resume with seat token ----------------
  a1.ws.close();
  await new Promise((r) => setTimeout(r, 1000));
  const a1b = client("a1-rejoined");
  await a1b.open();
  a1b.send({
    type: "rejoin",
    room: roleA1.room,
    seat: roleA1.player,
    seatToken: roleA1.seatToken,
  });
  const back = await waitFor(a1b, (m) => m.type === "role");
  if (back.player !== roleA1.player) throw new Error("rejoin seat mismatch");
  const snap = await waitFor(a1b, (m) => m.type === "state");
  if (!snap.state) throw new Error("no state snapshot after rejoin");
  console.log("REJOIN OK: seat resumed with live state after disconnect");

  // Wrong token must be rejected.
  const thief = client("thief");
  await thief.open();
  thief.send({ type: "rejoin", room: roleA1.room, seat: roleA1.player, seatToken: "nope" });
  const denied = await waitFor(thief, (m) => m.type === "error");
  if (!/not found/i.test(denied.message)) throw new Error("token check failed");
  console.log("TOKEN OK: wrong seat token rejected");

  for (const c of [a1b, a2, b1, b2, thief]) c.ws.close();
  console.log("ALL PROD LOBBY TESTS PASSED");
  process.exitCode = 0;
})().catch((e) => {
  console.error("TEST FAILED:", e.message);
  process.exitCode = 1;
});
