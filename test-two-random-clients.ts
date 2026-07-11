// ============================================================================
// test-two-random-clients.ts
//
// Spawns two dummy WebSocket clients that connect to the Referee and play
// random legal moves. Confirms the full end-to-end loop:
//   client A -> ws -> Referee -> ws -> client A/B -> chooseMove -> ...
//
// Run (after `npm run referee` in another terminal):
//   npm run test-referee
// ============================================================================

import WebSocket from "ws";
import type { ServerMessage, ClientMessage } from "./protocol.ts";
import type { PlayerId } from "./rulebook.ts";

const URL = process.env.REFEREE_URL ?? "ws://localhost:8080";
const MOVE_THINK_MS = 30; // artificial "thinking" delay so logs are readable

function spawnClient(nickname: string): Promise<PlayerId | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    let role: PlayerId | null = null;

    ws.on("open", () => {
      console.log(`[${nickname}] connected`);
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;

      switch (msg.type) {
        case "role":
          role = msg.player;
          console.log(`[${nickname}] assigned ${role}`);
          break;

        case "waiting":
          console.log(`[${nickname}] waiting — ${msg.reason}`);
          break;

        case "state": {
          const mine = msg.state.currentPlayer === role;
          const marker = mine ? "*" : " ";
          const legalCount = msg.legalMoves?.length ?? 0;
          console.log(
            `[${nickname}] ${marker} turn=${msg.state.currentPlayer} flip=${msg.flip} legal=${legalCount}`,
          );
          if (mine && msg.legalMoves && msg.legalMoves.length > 0) {
            const pick = Math.floor(Math.random() * msg.legalMoves.length);
            const choose: ClientMessage = { type: "chooseMove", moveIndex: pick };
            setTimeout(() => ws.send(JSON.stringify(choose)), MOVE_THINK_MS);
          }
          break;
        }

        case "gameOver":
          console.log(`[${nickname}] GAME OVER — winner: ${msg.winner}`);
          ws.close();
          resolve(role);
          break;

        case "error":
          console.error(`[${nickname}] ERROR — ${msg.message}`);
          break;
      }
    });

    ws.on("close", () => {
      console.log(`[${nickname}] disconnected`);
      resolve(role);
    });

    ws.on("error", (err) => {
      console.error(`[${nickname}] socket error:`, err.message);
      resolve(null);
    });
  });
}

async function main() {
  const alice = spawnClient("Alice");
  // Slight delay so the referee assigns Alice p1's slot before Bob shows up.
  await new Promise((r) => setTimeout(r, 200));
  const bob = spawnClient("Bob");
  await Promise.all([alice, bob]);
  console.log("Both clients closed. Test finished.");
  process.exit(0);
}

main();
