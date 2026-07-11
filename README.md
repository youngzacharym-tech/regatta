# Regatta

A two-player race across the board — a fan-made, browser-based take on the
*Soulframe* minigame. Play a friend by room code or link, or play the CPU.

**Live:** https://regatta-one.vercel.app *(installable as an app — "Add to
Home Screen" on a phone)*

- 3D board and pieces sculpted in Nomad Sculpt, prepped in Blender, rendered
  with Three.js (Draco-compressed glTF).
- Tap-to-move: your eligible tokens pulse gold; every flip has exactly one
  destination per token.
- Rooms: unlimited concurrent games; share a 4-letter code or a
  `?room=CODE` link. CPU opponent for solo play.
- Both players see themselves as **Red** on the near row — the seat only
  exists in the protocol.

## How it's built

```
+-------------+       +-------------+       +-------------+
|   STAGE     |<----->|   REFEREE   |<----->|   STAGE     |
| (client A)  |       |  (server)   |       | (client B)  |
+-------------+       +-------------+       +-------------+
        \                   |                   /
         \                  v                  /
          +------->+-------------------+<-----+
                   |      RULEBOOK     |
                   |  (pure TS module) |
                   +-------------------+
```

- **`rulebook.ts`** — pure game logic, no I/O. Both client and server import
  it so they can never disagree on legality. The locked-in rules are
  documented at the top of the file.
- **`referee.ts`** — the local/dev server: WebSocket referee + static file
  host in one Node process. Owns coin flips and validates every move.
- **`api/ws.ts`** — the same referee re-architected for Vercel: rooms live
  in Redis (Upstash), broadcasts go through pub/sub, clients auto-reconnect
  with seat tokens. Deployed as a pre-bundled function (`npm run build:api`).
- **`bot.ts`** — the CPU opponent (ranked heuristic, shared by both servers).
- **`stage/`** — the Three.js client (Vite). `stage/src/layout.ts` maps the
  abstract 15-tile path onto measured positions on the sculpted board.

## Run it locally

```bash
npm install
npm start          # builds nothing — serves stage/dist + WebSocket on :8080
```

If you've changed client code, rebuild the stage first:

```bash
cd stage && npm install && npm run build
```

Then open http://localhost:8080 in two tabs (or a laptop + a phone on the
same Wi-Fi via `http://<laptop-ip>:8080`).

Useful scripts:

- `npm run batch` — 1,000 random games through the rulebook (rules
  regression: terminations, win split, no stalemates).
- `node test-lobby.cjs` — lobby integration test against a local server
  (rooms, CPU game to completion, disconnect handling).

## Deploy

Production runs on Vercel (WebSocket function + Upstash Redis + static PWA):

```bash
npm run deploy     # bundles api/ws.ts, then `vercel deploy --prod`
```

Requires the Vercel CLI to be authenticated and an Upstash Redis integration
providing `REDIS_URL`. Always use `npm run deploy` — a bare `vercel deploy`
ships a stale server bundle.

## Board assets

`stage/public/regatta.glb` (board) and `pieces.glb` (tokens/coin) are
Draco-compressed exports from a Blender scene built out of Nomad Sculpt
meshes. The Blender-side build scripts (vertex painting, game-space
transform, measured tile-coordinate output for `layout.ts`) live alongside
the `.blend` source, outside this repo. `compress-glb.ps1` handles
compression when a new export lands.
