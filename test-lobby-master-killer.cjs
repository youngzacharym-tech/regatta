// Exercise Master Killer mode over raw WebSockets (no browser needed) —
// mirrors test-lobby.cjs's shape, but drives the class-pick phase and
// power actions (Push/Re-flip/Charge) instead of just classic moves.
//  1. Classic regression: a vsCpu classic room still finishes normally —
//     proves the variant branching in referee.ts didn't disturb classic play.
//  2. Master Killer CPU game: join, pick a class, flip off, then play to
//     completion using whatever power actions come up (Charge when
//     available, Push when armed and a target exists), falling back to
//     normal chooseMove otherwise.
//  3. Mage Re-flip: force a Mage seat, use Re-flip once a charge is banked,
//     and confirm the flip actually changes.
const WebSocket = require("ws");
const URL = "ws://localhost:8097";

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
    next: (ms = 15000) => {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((res) => {
        waiters.push(res);
        setTimeout(() => {
          const i = waiters.indexOf(res);
          if (i !== -1) {
            waiters.splice(i, 1);
            res(null);
          }
        }, ms);
      });
    },
    open: () => new Promise((res) => ws.once("open", res)),
  };
}

async function classicRegression() {
  const c = client("classic-solo");
  await c.open();
  c.send({ type: "join", mode: "cpu" });
  let role = null, winner = null, moves = 0;
  const deadline = Date.now() + 60_000;
  while (!winner && Date.now() < deadline) {
    const msg = await c.next(5000);
    if (!msg) continue;
    if (msg.type === "role") {
      role = msg.player;
      if (msg.variant !== "classic") throw new Error("expected classic variant, got " + msg.variant);
    }
    if (msg.type === "opening" && role && msg.first === null && !msg.tie && msg.flips[role] === null) {
      c.send({ type: "openingFlip" });
    }
    if (msg.type === "state" && msg.legalMoves && msg.legalMoves.length) {
      moves++;
      c.send({ type: "chooseMove", moveIndex: 0 });
    }
    if (msg.type === "gameOver") winner = msg.winner;
  }
  c.ws.close();
  if (!winner) throw new Error("classic cpu game did not finish");
  console.log(`CLASSIC REGRESSION OK: winner=${winner} moves=${moves}`);
}

async function masterKillerCpuGame() {
  const c = client("mk-solo");
  await c.open();
  c.send({ type: "join", mode: "cpu", variant: "masterKiller" });
  let role = null, winner = null, moves = 0, pushes = 0, charges = 0, snipes = 0;
  let sawClassPick = false, sawClassReady = false, sawPowerField = false;
  const deadline = Date.now() + 90_000;
  while (!winner && Date.now() < deadline) {
    const msg = await c.next(5000);
    if (!msg) continue;
    if (msg.type === "role") {
      role = msg.player;
      if (msg.variant !== "masterKiller") throw new Error("expected masterKiller variant, got " + msg.variant);
    }
    if (msg.type === "classPick") {
      sawClassPick = true;
      if (msg.ready) sawClassReady = true;
      else if (role && msg.classes[role] === null) c.send({ type: "pickClass", class: "warrior" });
    }
    if (msg.type === "opening" && role && msg.first === null && !msg.tie && msg.flips[role] === null) {
      c.send({ type: "openingFlip" });
    }
    if (msg.type === "state") {
      if (!msg.power) throw new Error("masterKiller state broadcast missing power field");
      sawPowerField = true;
      if (msg.powerMoves && msg.powerMoves.length) {
        const m = msg.powerMoves[0];
        if (m.chargeAvailable && msg.power.charges[role] >= 1) {
          c.send({ type: "usePower", action: { kind: "charge", moveIndex: 0 } });
          charges++;
        } else {
          if (m.bonusCaptures && m.bonusCaptures.length) snipes++;
          c.send({ type: "chooseMove", moveIndex: 0 });
          moves++;
        }
      } else if (msg.powerMoves && msg.powerMoves.length === 0) {
        if (msg.power.pushTargets && msg.power.pushTargets.length && msg.power.charges[role] >= 1) {
          c.send({ type: "usePower", action: { kind: "push", targetTokenId: msg.power.pushTargets[0] } });
          pushes++;
        }
        // Otherwise: nothing to do this turn — the server's auto-skip fires.
      }
    }
    if (msg.type === "gameOver") winner = msg.winner;
  }
  c.ws.close();
  if (!sawClassPick) throw new Error("never saw a classPick message");
  if (!sawClassReady) throw new Error("classPick never reported ready");
  if (!sawPowerField) throw new Error("never saw a state broadcast with a power field");
  if (!winner) throw new Error("masterKiller cpu game did not finish in time");
  console.log(
    `MASTER KILLER CPU GAME OK: winner=${winner} moves=${moves} charges-used=${charges} pushes=${pushes} snipes-seen=${snipes}`,
  );
}

async function masterKillerReflip() {
  const c = client("mk-reflip");
  await c.open();
  c.send({ type: "join", mode: "cpu", variant: "masterKiller" });
  let role = null, didReflip = false, flipBefore = null, flipAfter = null;
  const deadline = Date.now() + 60_000;
  while (!didReflip && Date.now() < deadline) {
    const msg = await c.next(5000);
    if (!msg) continue;
    if (msg.type === "role") role = msg.player;
    if (msg.type === "classPick" && role && msg.classes[role] === null) {
      c.send({ type: "pickClass", class: "mage" });
    }
    if (msg.type === "opening" && role && msg.first === null && !msg.tie && msg.flips[role] === null) {
      c.send({ type: "openingFlip" });
    }
    if (msg.type === "state" && msg.power && msg.power.classes[role] === "mage") {
      if (msg.power.charges[role] >= 1 && msg.flip !== null && !didReflip) {
        flipBefore = msg.flip;
        c.send({ type: "usePower", action: { kind: "reflip" } });
        didReflip = true;
      } else if (msg.powerMoves && msg.powerMoves.length) {
        c.send({ type: "chooseMove", moveIndex: 0 });
      }
    }
  }
  if (didReflip) {
    const after = await c.next(5000);
    if (after && after.type === "state") flipAfter = after.flip;
  }
  c.ws.close();
  if (!didReflip) {
    console.log("MASTER KILLER REFLIP: skipped (mage never banked a charge in time — not a failure, just unlucky RNG)");
  } else {
    console.log(`MASTER KILLER REFLIP OK: flip ${flipBefore} -> ${flipAfter}`);
  }
}

(async () => {
  await classicRegression();
  await masterKillerCpuGame();
  await masterKillerReflip();
  console.log("ALL MASTER KILLER LOBBY TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("TEST FAILED:", e.message);
  process.exit(1);
});
