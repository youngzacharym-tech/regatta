// Production smoke test for Master Killer mode (mirrors test-lobby-prod.cjs's
// shape/target). Joins a masterKiller CPU room on the live Redis/CAS-backed
// deployment, picks a class, plays through class-pick -> opening -> several
// turns (using a power action whenever one comes up), and confirms the
// power/powerMoves fields are actually present on the wire in production.
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
  const c = client("mk-prod");
  await c.open();
  c.send({ type: "join", mode: "cpu", variant: "masterKiller" });

  const role = await waitFor(c, (m) => m.type === "role");
  if (role.variant !== "masterKiller") throw new Error("expected masterKiller variant, got " + role.variant);
  console.log(`ROLE OK: seat=${role.player} room=${role.room} variant=${role.variant}`);

  const pick = await waitFor(c, (m) => m.type === "classPick");
  if (pick.classes[role.player] !== null) throw new Error("expected an unpicked class");
  c.send({ type: "pickClass", class: "archer" });
  await waitFor(c, (m) => m.type === "classPick" && m.ready);
  console.log("CLASS PICK OK: archer picked, both sides ready");

  // Opening flip-off — flip whenever prompted, including tie re-flips.
  let openings = 0;
  for (;;) {
    const msg = await waitFor(
      c,
      (m) => (m.type === "opening" && m.first === null) || m.type === "state",
      20000,
    );
    if (msg.type === "state") break; // resolved — normal play has started
    if (!msg.tie && msg.flips[role.player] === null) {
      openings++;
      c.send({ type: "openingFlip" });
    }
  }
  if (openings < 1) throw new Error("never flipped in the opening round");
  console.log(`OPENING OK: ${openings} flip(s) sent`);

  // Play up to 10 turns, using a power action whenever one's available.
  let sawPowerField = false, moves = 0, powerActions = 0, winner = null;
  const deadline = Date.now() + 60000;
  while (!winner && moves + powerActions < 10 && Date.now() < deadline) {
    const msg = await c.next(15000);
    if (msg.type === "state") {
      if (!msg.power) throw new Error("prod state broadcast missing power field");
      sawPowerField = true;
      if (msg.powerMoves && msg.powerMoves.length) {
        const m = msg.powerMoves[0];
        if (m.chargeAvailable && msg.power.charges[role.player] >= 1) {
          c.send({ type: "usePower", action: { kind: "charge", moveIndex: 0 } });
          powerActions++;
        } else {
          c.send({ type: "chooseMove", moveIndex: 0 });
          moves++;
        }
      } else if (msg.power.pushTargets && msg.power.pushTargets.length && msg.power.charges[role.player] >= 1) {
        c.send({ type: "usePower", action: { kind: "push", targetTokenId: msg.power.pushTargets[0] } });
        powerActions++;
      }
      // Otherwise: nothing legal this turn — the server's own auto-skip handles it.
    } else if (msg.type === "gameOver") {
      winner = msg.winner;
    }
  }
  if (!sawPowerField) throw new Error("never saw a power field on a prod state broadcast");
  if (moves + powerActions === 0) throw new Error("never got to act at all");
  console.log(`PLAY OK: moves=${moves} powerActions=${powerActions}${winner ? ` winner=${winner}` : " (turn budget reached, not required to finish)"}`);

  c.ws.close();
  console.log("ALL MASTER KILLER PROD SMOKE TESTS PASSED");
  process.exitCode = 0;
})().catch((e) => {
  console.error("TEST FAILED:", e.message);
  process.exitCode = 1;
});
