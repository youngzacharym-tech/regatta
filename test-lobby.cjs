// Exercise the lobby over raw WebSockets (no browser needed):
//  1. CPU game: join, then auto-play random legal moves for the human until
//     someone wins — proves the bot takes its turns and games terminate.
//  2. Two concurrent PvP rooms: create+join twice, play a few moves in each,
//     verify the rooms don't bleed into each other. Then one client leaves
//     and the other must receive opponentLeft.
const WebSocket = require("ws");
const URL = "ws://localhost:8092";

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
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((res) => waiters.push(res)),
    open: () => new Promise((res) => ws.once("open", res)),
  };
}

async function cpuGame() {
  const c = client("solo");
  await c.open();
  c.send({ type: "join", mode: "cpu" });
  let role = null, room = null, winner = null, myMoves = 0;
  const deadline = Date.now() + 90_000;
  while (!winner && Date.now() < deadline) {
    const msg = await c.next();
    if (msg.type === "role") { role = msg.player; room = msg.room;
      if (!msg.vsCpu) throw new Error("expected vsCpu room");
    }
    if (msg.type === "state" && msg.legalMoves && msg.legalMoves.length) {
      myMoves++;
      c.send({ type: "chooseMove", moveIndex: Math.floor(Math.random() * msg.legalMoves.length) });
    }
    if (msg.type === "gameOver") winner = msg.winner;
  }
  c.ws.close();
  if (!winner) throw new Error("cpu game did not finish in time");
  console.log(`CPU GAME OK: room=${room} me=${role} winner=${winner} myMoves=${myMoves}`);
}

async function pvpRooms() {
  // Room A
  const a1 = client("a1"), a2 = client("a2");
  await a1.open(); await a2.open();
  a1.send({ type: "join", mode: "create" });
  let m = await a1.next();
  if (m.type !== "role") throw new Error("a1 expected role, got " + m.type);
  const codeA = m.room;
  // Room B
  const b1 = client("b1"), b2 = client("b2");
  await b1.open(); await b2.open();
  b1.send({ type: "join", mode: "create" });
  m = await b1.next();
  const codeB = m.room;
  if (codeA === codeB) throw new Error("room codes collided");

  a2.send({ type: "join", mode: "join", room: codeA.toLowerCase() }); // case-insensitive
  b2.send({ type: "join", mode: "join", room: codeB });

  // Bad code must error.
  const bad = client("bad");
  await bad.open();
  bad.send({ type: "join", mode: "join", room: "XXXX" });
  const badMsg = await bad.next();
  if (badMsg.type !== "error") throw new Error("expected error for bad code");
  bad.ws.close();

  // Play 6 moves in each room concurrently (random legal moves as they come).
  async function playSome(...clients) {
    let moves = 0;
    const deadline = Date.now() + 30_000;
    while (moves < 6 && Date.now() < deadline) {
      for (const c of clients) {
        // Drain without blocking: peek with a short race.
        const msg = await Promise.race([c.next(), new Promise((r) => setTimeout(() => r(null), 150))]);
        if (!msg) continue;
        if (msg.type === "state" && msg.legalMoves && msg.legalMoves.length && msg.state.winner === null) {
          c.send({ type: "chooseMove", moveIndex: 0 });
          moves++;
        }
        if (msg.type === "gameOver") return moves;
      }
    }
    return moves;
  }
  const [movesA, movesB] = await Promise.all([playSome(a1, a2), playSome(b1, b2)]);
  if (movesA < 3 || movesB < 3) throw new Error(`too few moves: A=${movesA} B=${movesB}`);
  console.log(`PVP ROOMS OK: ${codeA} (${movesA} moves) + ${codeB} (${movesB} moves) ran concurrently`);

  // Disconnect a1 — a2 must get opponentLeft.
  a1.ws.close();
  const deadline = Date.now() + 5000;
  let gotLeft = false;
  while (Date.now() < deadline && !gotLeft) {
    const msg = await Promise.race([a2.next(), new Promise((r) => setTimeout(() => r(null), 300))]);
    if (msg && msg.type === "opponentLeft") gotLeft = true;
  }
  if (!gotLeft) throw new Error("a2 never received opponentLeft");
  console.log("DISCONNECT OK: opponentLeft delivered");
  a2.ws.close(); b1.ws.close(); b2.ws.close();
}

(async () => {
  await cpuGame();
  await pvpRooms();
  console.log("ALL LOBBY TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("TEST FAILED:", e.message);
  process.exit(1);
});
