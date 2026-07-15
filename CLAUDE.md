# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Regatta: a fan-made, browser-based 2-player race-and-capture board game (a
digital take on a *Soulframe* minigame), played with coin flips instead of
dice. Three.js/Vite client + authoritative Node WebSocket server sharing a
pure TypeScript rulebook. Live at https://regatta-one.vercel.app, installable
as a PWA. **Master Killer** is the class-powers variant (Archer / Mage /
Warrior, charge economy) selectable from the menu — this is the project's
active focus (the repo is literally named for it).

## Repo genealogy — read this before hunting for code

- This repo (`w3t-wr3/master-killer-myrm`) is a FORK of
  `youngzacharym-tech/regatta` (Zach's repo, added as git remote `upstream`).
- **The Master Killer implementation lives on `upstream`'s
  `master-killer-mode` branch** — `master` on both repos is classic-only.
  Work here happens on the local `master-killer-mode` branch tracking
  upstream's.
- The live `regatta-one.vercel.app` deploys from Zach's own Vercel account —
  NOT reachable from the `wetwarelabs` Vercel team this machine's CLI is
  logged into. Kasen cannot deploy there; coordinate with Zach or stand up a
  separate deployment.
- Related but distinct: `w3t-wr3/regatta-wetware-fork` (Kasen's tavern-build
  fork, local clone at `~/regatta`) feeds the `wetwarelabs` Vercel project
  `regatta` → `regatta.games`. Don't confuse the two deploy targets.

## Setup

Two independent npm projects — install both before doing anything:

```bash
npm install              # root: server (ws, tsx, ioredis, esbuild)
cd stage && npm install  # client: three, vite
```

Node >=20 required (`engines` in package.json).

## Commands

Rulebook regression/smoke tests (no server needed):
```bash
npx tsx play-random-game.ts               # one random classic game
npx tsx batch-random-games.ts             # 1000 random classic games, balance stats
npx tsx batch-random-master-killer-games.ts  # same for Master Killer (all class matchups)
npx tsx test-master-killer.ts             # Master Killer rules unit suite
npx tsx test-master-killer-drift.ts       # referee-vs-rulebook drift check
```

Local dev server (WebSocket referee + static host in one process):
```bash
npm run referee             # or: npm start — port 8080 (PORT env overrides)
cd stage && npm run dev     # Vite dev on :5173 with HMR, talks to :8080
```
GOTCHA on Kasen's Mac: Docker squats on port 8080 — run `PORT=8090 npm run
referee` and browse http://localhost:8090 instead. Client WS URL resolution
is `resolveRefereeURL()` in `stage/src/main.ts` (`?referee=ws://...`
overrides).

Integration tests against a running referee:
```bash
npm run test-referee                 # 2 dummy WS clients vs ws://localhost:8080 (REFEREE_URL overrides)
PORT=8092 npm run referee            # test-lobby*.cjs are hardcoded to :8092
node test-lobby.cjs                  # classic lobby: CPU game, concurrent rooms, disconnects
node test-lobby-master-killer.cjs    # Master Killer lobby: class pick, powers, charges
node test-lobby-prod.cjs             # against live Vercel deploy (rejoin flow)
node test-lobby-master-killer-prod.cjs
```

Build & deploy:
```bash
npm run build:stage   # vite build → stage/dist (+ sw.js cache stamp)
npm run build:api     # esbuild-bundles api/ws.ts → api/ws.js (COMMITTED, pre-bundled)
npm run deploy        # build:api + `npx vercel deploy --prod` — never bare `vercel deploy`
```
`api/ws.js` is committed on purpose (git-based Vercel deploys need the
pre-bundle; Vercel's per-file compiler can't resolve the shared root-level
imports — see `.vercelignore`). Regenerate it whenever `api/ws.ts`,
`rulebook.ts`, `master-killer.ts`, `bot.ts`, or `master-killer-bot.ts`
change.

There is no lint config; correctness rides on the test scripts above.

## Architecture

**Shared rules core, two server transports, one client.** The invariant:
rules modules are pure, side-effect-free TypeScript imported *verbatim* by
the client bundle and both server implementations, so client and server can
never disagree about legality.

- **`rulebook.ts`** — classic rules, the untouched base game. Immutable
  GameState; coin flips passed in. Design decisions recorded inline as a
  locked Q&A block (Q1-Q7) — update that block when changing a rule.
- **`master-killer.ts`** — the variant rulebook, SEPARATE from rulebook.ts
  on purpose (classic stays byte-identical). Reimplements its own move
  generator (`getLegalPowerMoves`), layering class powers on top: Archer
  (Snipe passive / Push active), Mage (Ward passive / Re-flip active),
  Warrior (Shieldbreaker passive / Charge-sweep active). Charge economy:
  captures, zero flips, and shield landings each bank a charge, capped at
  CHARGE_CAP (2). Every tunable is a named constant at the top with the
  simulation-derived balance rationale in its comment — re-run
  `batch-random-master-killer-games.ts` after touching any of them.
- **`bot.ts` / `master-killer-bot.ts`** — CPU move pickers for each ruleset.
- **`protocol.ts`** — wire types. Master Killer fields are ADDITIVE ONLY
  (optional, populated only in masterKiller rooms): `variant` on role,
  `classPick` phase, `powerMoves`/`power`/`lastPush`/`lastChargeEvent` on
  state broadcasts. `lastChargeEvent` is the server-computed charge diff —
  clients display it, never re-derive it.
- **`referee.ts`** — local/Render server; rooms in process memory.
- **`api/ws.ts`** — same referee re-architected for Vercel: room docs in
  Upstash Redis (compare-and-set via Lua), pub/sub broadcasts, seat-token
  rejoin. Ships pre-bundled as `api/ws.js` (see above).
- **`stage/`** — Three.js + Vite client. `src/main.ts` (~2100 lines) covers
  scene, board/token rendering, tap-to-move raycasting, coin-flip and mug
  animations, PWA install, app mode, and the **avatar plates**: Hearthstone
  style class frames (bottom-left = you + charge gems + power rune + utility
  rail; top-right = opponent). Plates are driven entirely by the `power`
  broadcast + `lastChargeEvent` (gem flare/spend), and the rune arms the
  same pushArmed/sweepArmed targeting flows the board taps consume.
  `src/layout.ts` maps abstract tile indices to measured 3D coordinates —
  the one file to re-tune if the board mesh changes. Class portrait art:
  shipped as `stage/public/avatars/*.webp` (512px); 1254px PNG originals in
  `art/avatars/` (kept out of stage/public so they don't deploy).
- **`tools/build_assets.py`** — Blender headless pipeline for the .glb
  assets; only needed when the sculpts change.

### Client-server trust model

Only the current player receives `legalMoves`/`powerMoves`; clients send
INDEXES into those lists (or target token ids for Push), never move data.
The server recomputes and re-validates everything. Keep new UI affordances
on that model — never trust client-supplied move shapes.
