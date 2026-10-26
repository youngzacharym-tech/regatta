# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Master Killer: a browser-based 2-player race-and-war board game. Each side
picks one of ten classes (Archer, Mage, Warrior, Necromancer, Cleric, Rogue,
Warlock, Hunter, Barbarian, Bard), then races four stones around a 15-tile
board while class powers capture, wall, shove and curse, paid for with mana.
Coin flips instead of dice. Three.js/Vite client + authoritative server (HTTP
long-polling) sharing pure TypeScript rules. Live at
https://masterkiller.vercel.app, installable as a PWA.

It began as the class-powers variant of **Regatta** (a *Soulframe* minigame
take). The classic ruleset was cut from this branch on 2026-10-25; it lives
on in `master`.

## Repo + deploy

- Git remote `origin` = `youngzacharym-tech/regatta`. Master Killer lives on
  branch **`standalone`**. `master` is classic Regatta, `master-killer-mode`
  is the old two-ruleset build. Remotes `kasen` and `myrm` are collaborator
  forks — don't push there unless asked.
- Deploy target: Vercel project **`masterkiller`** (masterkiller.vercel.app).
  `npm run deploy` pins `--project masterkiller`. This folder's `.vercel/` is
  still LINKED to the old `regatta` project, so a bare `vercel deploy` ships
  to the wrong place — never use it.
- Redis (Upstash) is shared with other games; `api/room.ts` prefixes every
  key `mk:`.

## Setup

Two independent npm projects — install both before doing anything:

```bash
npm install              # root: server (tsx, ioredis, esbuild)
cd stage && npm install  # client: three, vite
```

Node >=20 required (`engines` in package.json).

## Commands

Rules gates (no server needed):
```bash
npx tsx test-master-killer.ts                # rules scenario suite (npm test)
npx tsx test-master-killer-drift.ts          # class rules never change the base race's move gen
npx tsx batch-random-master-killer-games.ts  # every class matchup, balance stats (npm run batch)
npx tsx batch-bot-difficulty.ts              # CPU tier separation gate (exits 1 on failure)
```

Local dev server (polling referee + static host in one process):
```bash
npm run referee             # or: npm start — port 8080 (PORT env overrides)
cd stage && npm run dev     # Vite dev on :5173 with HMR, talks to :8080
```
Client API URL resolution is `resolveApiURL()` in `stage/src/main.ts`
(`?referee=<url>` overrides).

Engine/transport tests:
```bash
npm run test-engine                  # full games through room-engine's applyAction/tick
node tools/smoke/poll-transport-smoke.mjs <url>   # live smoke: CPU game, PvP + chat, lobby
```
Known: `test-engine-drive.ts` is stale — its Bulwark display block reads a
field the 2026-09-17 wall rework removed, and it crashes there.

Build & deploy:
```bash
npm run build:stage   # vite build → stage/dist (+ sw.js cache stamp)
npm run build:api     # esbuild-bundles api/room.ts → api/room.js (COMMITTED, pre-bundled)
npm run deploy        # build:api + vercel deploy --prod --project masterkiller
```
`api/room.js` is committed on purpose (git-based Vercel deploys need the
pre-bundle; Vercel's per-file compiler can't resolve the shared root-level
imports — see `.vercelignore`). Regenerate it whenever `api/room.ts`,
`room-engine.ts`, `rulebook.ts`, `master-killer.ts`, or the bot change.

There is no lint config; correctness rides on the test scripts above.
`cd stage && npx tsc --noEmit -p .` has 44 known errors, all a pre-existing
`RoomActionInput` union gap in `room-engine.ts`.

## Architecture

**Shared rules core, two server transports, one client.** The invariant:
rules modules are pure, side-effect-free TypeScript imported *verbatim* by
the client bundle and both server implementations, so client and server can
never disagree about legality.

- **`rulebook.ts`** — the base race: the 15-tile board (`BOARD_LAYOUT`),
  immutable `GameState`, coin flips passed in. Its locked Q&A block (Q1-Q7)
  records the race rules. `master-killer.ts` and the drift test build on it.
- **`master-killer.ts`** — the class rules. Its own move generator
  (`getLegalPowerMoves`) layers class powers on the race. Mana (charges)
  comes from captures, shield landings, zero flips and escapes, capped at
  `CHARGE_CAP`. Ultimates bank after three shield landings in a row. Every
  tunable is a named constant at the top with its simulation-derived
  rationale — re-run `batch-random-master-killer-games.ts` after touching
  any of them.
- **`master-killer-bot.ts`** — the CPU (easy / standard / hard;
  `bot-difficulty.ts` holds the shared tier vocabulary).
- **`protocol.ts`** — wire types. The Master Killer fields are still typed
  optional from the two-ruleset days but are always populated. `variant`
  stays on the wire as `"masterKiller"` because clients cached from before
  the cut branch their UI on it.
- **`room-engine.ts`** — THE turn engine, pure over a `RoomDoc` value:
  `applyAction` (player did something), `tick` (fire due absolute deadlines
  — replaces every setTimeout), `viewFor` (seat-gated view + replayable
  event log). Both transports share it verbatim, so they cannot drift.
- **`referee.ts`** — local server: static files + POST /api/room over an
  in-memory Map. **`api/room.ts`** — the identical endpoint on Vercel over
  Upstash Redis (version CAS via Lua), long-poll holds (~20s). Ships
  pre-bundled as `api/room.js` (see above). Clients resume by polling with
  their seat token; there is no rejoin handshake.
- **`stage/`** — Three.js + Vite client. `src/main.ts` covers the scene,
  stones and tap-to-move raycasting, coin and mug animations, the avatar
  plates + ability dock, the coached tutorial, the rulebook, and PWA install.
  `src/faceoff.ts` (+ `faceoff3d.ts`) is the class pick, `src/gamepad.ts`
  the controller support. `src/layout.ts` maps tile indices to measured 3D
  coordinates — re-tune it if the board mesh changes.
- **`tools/`** — headless Blender build scripts for the art:
  `build_board_mk.py` → `stage/public/board.glb`, `build_pieces_mk.py` →
  `figures.glb` + `pieces-core.glb`, sharing `mkgeo.py`.

### Client-server trust model

Only the current player receives `powerMoves`; clients send INDEXES into
that list (or target token ids / tiles for powers), never move data. The
server recomputes and re-validates everything. Keep new UI affordances on
that model — never trust client-supplied move shapes.
