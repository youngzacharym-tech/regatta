// ============================================================================
// master-killer.ts — rulebook for "Master Killer" mode, a class-powers
// variant of Regatta.
//
// SEPARATE from rulebook.ts on purpose. rulebook.ts stays the untouched
// classic game; this file layers class abilities on top by reimplementing
// its own move generator (see the note above getLegalPowerMoves for why a
// wrapper isn't possible) and importing only rulebook's plain data types.
//
// Same design principles as rulebook.ts:
//   - Pure functions. No I/O, no randomness (flipCoins is passed in/reused).
//   - GameState/PowerState are immutable — every function returns new ones.
//   - Tunable numbers are named constants at the top, not buried in logic.
// ============================================================================

import {
  BOARD_LAYOUT,
  PATH_LENGTH_PER_PLAYER,
  type GameState,
  type TokenState,
  type PlayerId,
} from "./rulebook.ts";

// rulebook.ts's otherPlayer() is a private helper, not exported — kept that
// way on purpose (Phase 1 promise: zero changes to existing files), so this
// file carries its own trivial copy instead of touching rulebook.ts.
function otherPlayerId(p: PlayerId): PlayerId {
  return p === "p1" ? "p2" : "p1";
}

// ============================================================================
// TUNABLES — adjust these, re-run batch-random-master-killer-games.ts, done.
// ============================================================================

/** Charges bank up to this many; further income while at the cap is a no-op. */
export const CHARGE_CAP = 2;

/** Archer's Push: how many tiles back along the TARGET's own path.
 *  (Was 2 — simulation showed Archer mirrors grinding to ~270 turns via a
 *  push-enables-snipe-grants-charge-fuels-more-push loop; 1 breaks the loop
 *  without making Push useless.) */
export const PUSH_DISTANCE = 1;

/** Warrior's Charge sweep: how many EXTRA enemies it can capture beyond the
 *  primary landing tile, in a single move. Matches Snipe's own bonus-capture
 *  ceiling (1) on principle — no class's single move should out-capture the
 *  others by more than one extra. (Was uncapped — a bot-quality bug meant
 *  Warriors almost never spent Charge on a real multi-capture sweep, so the
 *  ceiling never mattered in practice; once that bug was fixed, an uncapped
 *  sweep made Charge worth far more per use than anything in Archer's kit,
 *  flipping archer-vs-warrior from 51.6/48.4 to 43.5/56.5 warrior-favored.) */
export const CHARGE_SWEEP_CAP = 1;

/** Mage's Ward: "all" = every one of the mage's tokens is warded while at
 *  CHARGE_CAP. "most-advanced" = only their furthest-along token is warded.
 *  (Was "all" — simulation showed Archer vs Mage at 29.5/70.5, since only
 *  Warriors can pierce a ward at all; "most-advanced" narrows the shield to
 *  one token so non-Warriors have more to work with.)
 *  (Revisited post-CHARGED_SHOT_DISTANCE=4 while chasing the same
 *  archer-vs-mage regression PUSH_WARD_DISTANCE's doc covers (archer-vs-mage
 *  flipped from mage-favored 48.7/51.3 to archer-favored ~53.6-54.2/45.8-
 *  46.4 once Charged Shot could hit any of Mage's 3 non-Warded tokens at
 *  full strength). Root-cause read at the time: Charged Shot was built to
 *  bypass isWarded entirely in getChargedShotTargets — Mage had NO defense
 *  against it at all, unlike Warrior's Bulwark. Two candidates tested, in
 *  order, 2500 games/matchup against the CHARGED_SHOT_DISTANCE=4 baseline:
 *  TRIED "all" (this constant, alone, Charged Shot still bypassing Ward):
 *  overshot HARD past parity into mage-favor — 44.7/55.3 (5.3pt margin from
 *  even, wrong direction) — worse than doing nothing. archer-vs-warrior held
 *  fine (49.8/50.2, the locked fix intact) and archer/warrior mirrors stayed
 *  flat, but mage-vs-warrior drifted too (49.6/50.4 baseline -> 47.1/52.9),
 *  confirming broader Ward scope leaks into Ward Breaker's matchup as
 *  expected. Rejected alone: "all" only helps Mage against Push/Snipe, and
 *  Charged Shot — the actual thing that broke this matchup — still ignores
 *  Ward completely regardless of scope, so widening scope alone can't touch
 *  the root cause and just overcorrects on the tools it DOES affect.
 *  TRIED instead: giving Charged Shot its own isWarded exclusion (see
 *  getChargedShotTargets — a Warded target is now fully immune to Charged
 *  Shot, no PUSH_WARD_COST-style affordability escape hatch, same as a
 *  shield tile) while leaving WARD_SCOPE at "most-advanced". This is the
 *  actual root-cause fix, not a compensating lever: 50.8/49.2 at 2500 games,
 *  confirmed 52.3-52.6/47.4-47.9 across two independent 6000-game runs
 *  (archer-favored by a 4.6-5.2pt margin) — a large, stable improvement over
 *  the 7.2-8.4pt baseline margin, though not quite all the way to parity or
 *  Mage-favored. archer-vs-warrior held at 49.5-50.8/49.2-50.4 across both
 *  runs (the locked CHARGED_SHOT_DISTANCE=4 fix intact), and every other
 *  matchup stayed within run-to-run noise of baseline. KEPT: WARD_SCOPE
 *  stays "most-advanced" (unchanged); the fix lives entirely in
 *  getChargedShotTargets's isWarded filter instead. Also tried the two
 *  changes COMBINED ("all" + Charged-Shot-respects-Ward): overshot even
 *  further than "all" alone — 43.9/56.1 (6.1pt margin, wrong direction) —
 *  confirming the two candidates aren't complementary the way
 *  PUSH_WARD_DISTANCE/CHARGED_SHOT_DISTANCE turned out to be; stacking two
 *  independent buffs to the same defensive tool (Ward) just double-counts.
 *  Widening WARD_SCOPE further is NOT recommended without also reopening
 *  Charged Shot's own economy (cost/distance) to compensate — out of scope
 *  for this pass.)
 *  (SUPERSEDED 2026-07-16: the "Charged Shot's own isWarded exclusion"
 *  mechanism this entry describes as the kept fix no longer exists — Kasen's
 *  requested strength ordering required Ward to become a legal-but-weaker
 *  Charged Shot target instead of an illegal one. See
 *  CHARGED_SHOT_WARD_DISTANCE's doc for the replacement mechanism and its
 *  own, worse-than-this-baseline archer-vs-mage numbers. This whole entry is
 *  kept as-is for the historical trace — WARD_SCOPE itself is untouched.) */
export type WardScope = "all" | "most-advanced";
export const WARD_SCOPE: WardScope = "most-advanced";

/** Archer's Push can target a warded token (previously impossible — Push
 *  used to treat Ward as full immunity, same as everyone else). This is the
 *  charge cost for pushing a WARDED target specifically; a normal push still
 *  costs 1.
 *  (Was 2 — the "base reposition (1) + piercing Ward (1 more)" framing, on
 *  the theory that draining the whole CHARGE_CAP bank in one shot suits
 *  bypassing the game's strongest defensive ability. Simulation showed 2
 *  brought Archer vs Mage from 30.6/69.3 to 37.6/62.4 — a real improvement,
 *  but still the widest margin of the three matchups (24.8 pts, vs ~17-21
 *  for the other two edges). Dropping to 1 instead brought it to 40.2/59.8
 *  (19.6 pts) — landing right in line with archer-vs-warrior (19.8) and
 *  mage-vs-warrior (15.0), the most even the whole RPS triangle has been.
 *  Kept at 1: same cost as a normal push, still gated on `charges >=
 *  PUSH_WARD_COST` so it scales cleanly if ever retuned back up.) */
export const PUSH_WARD_COST = 1;

/** How far a Push knocks back a WARDED target specifically — a normal push
 *  still uses PUSH_DISTANCE.
 *
 *  RESTRUCTURED 2026-07-16 at Kasen's request: he pointed out the 4
 *  push/charged-shot x warded/unwarded combinations were landing in a
 *  genre-inconsistent strength order — a plain (non-charged) Push against a
 *  WARDED target was hitting harder (3 tiles) than the same Push against an
 *  unwarded one (1 tile), i.e. "putting a shield up" was making the shot
 *  STRONGER, backwards from every other game's convention (charged = harder,
 *  shielded = softer). He asked for a strict order instead: push-vs-ward
 *  (weakest) < push-vs-normal < charged-vs-ward < charged-vs-normal
 *  (strongest) — see CHARGED_SHOT_WARD_DISTANCE for the new counterpart this
 *  introduces.
 *
 *  This is NOT balance-neutral the way it was first pitched, despite "same
 *  abilities, just reordered" framing — this exact value used to be Mage's
 *  main defense against Push (tuned 2/3/4, landed on 3 specifically because
 *  1-2 left Mage too exposed, see the old history this replaces in git
 *  blame). Dropping it below PUSH_DISTANCE reopens that exposure. Deliberately
 *  set to 0 rather than shading PUSH_DISTANCE upward to compensate: raising
 *  PUSH_DISTANCE risks reopening the archer-mirror ~270-turn grind PUSH_DISTANCE=1
 *  was originally chosen to prevent (see that constant's own doc), a totally
 *  different failure mode than anything Ward-related. 0 keeps PUSH_DISTANCE
 *  and CHARGED_SHOT_DISTANCE (both load-bearing for the archer-vs-warrior
 *  fix, and PUSH_DISTANCE for archer-mirror's game length) completely
 *  untouched, and confines the re-tune to the two new Ward-specific values —
 *  both of which only ever apply against a Mage, so archer-vs-warrior and
 *  archer-mirror are structurally unaffected no matter what these two land
 *  on. A push that does 0 tiles is a real, if minimal, action: it still
 *  spends the charge, still strips transient safety, still breaks the
 *  mover's shield streak — same non-distance side effects Push always had —
 *  it just can never itself send a Warded target home. See
 *  batch-random-master-killer-games.ts output for the actual re-tuned
 *  archer-vs-mage numbers under this restructuring. */
export const PUSH_WARD_DISTANCE = 0;

/** Archer's Charged Shot: spends BOTH banked charges at once (requires
 *  charges === CHARGE_CAP) for a flat, fixed knockback distance against an
 *  UNWARDED target. A deliberately SEPARATE mechanic from Ward-piercing:
 *  Ward-piercing solves "how do I touch a Warded target at all," Charged
 *  Shot solves "how do I hit harder in general" — and is the tool meant to
 *  help archer-vs-warrior specifically, since Warriors are never Warded.
 *  Refunds 1 charge on send-home, same mechanism as normal Push — net cost
 *  is -1 charges even on a hit (spend 2, refund 1), vs Push's spend-1/
 *  refund-1 = net 0.
 *
 *  Tuned to 4 specifically to fix archer-vs-warrior (5 failed attempts
 *  across prior sessions before this value landed it at ~49.9/50.1 — see
 *  git blame on this file for the full tuning trace). Since Warrior tokens
 *  are never Warded, this value ALWAYS governs the archer-vs-warrior
 *  matchup regardless of anything Ward-related — kept fixed at 4 through
 *  the 2026-07-16 Ward-order restructuring for exactly that reason. Do not
 *  retune this to fix an archer-vs-mage problem; use
 *  CHARGED_SHOT_WARD_DISTANCE instead, which is scoped to Mage by
 *  construction. */
export const CHARGED_SHOT_DISTANCE = 4;

/** How far a Charged Shot knocks back a WARDED target specifically — a
 *  Charged Shot against an unwarded target still uses CHARGED_SHOT_DISTANCE.
 *  New 2026-07-16, alongside PUSH_WARD_DISTANCE's restructuring (see that
 *  constant's doc for the full context): Charged Shot used to treat a
 *  Warded target as fully immune (excluded from getChargedShotTargets
 *  entirely, no affordability escape hatch) — that exclusion was ITSELF
 *  the prior session's fix for archer-vs-mage overshooting archer-favored.
 *  Kasen's requested order needs Ward to be a legal-but-weaker target
 *  instead of an illegal one, which structurally reopens that exact lever.
 *  Scoped by construction to matchups against a Mage (isWarded is never
 *  true otherwise), so archer-vs-warrior/archer-mirror can't drift from
 *  this — see the isWarded branch in computeChargedShotLanding.
 *
 *  Must land strictly between PUSH_DISTANCE(1) and CHARGED_SHOT_DISTANCE(4)
 *  to satisfy the requested order — since neither endpoint can move (both
 *  load-bearing elsewhere, see their own docs), that leaves exactly two
 *  candidate integers, both tried at 5000 games/matchup against the
 *  PUSH_WARD_DISTANCE=0 baseline (after fixing a real scorePush bot bug
 *  found along the way — see that function's own comment; the flat
 *  "+60 if warded" bonus was tricking the bot into spending charges on a
 *  push that PUSH_WARD_DISTANCE=0 makes a total no-op):
 *  Tried 2: archer-vs-mage 20.5/79.5 — badly mage-favored.
 *  Tried 3 (the ceiling): archer-vs-mage 38.0/62.0 — still badly
 *  mage-favored, but the best available within the ordering constraint.
 *  Neither comes close to the pre-restructuring baseline (53.6/46.4
 *  archer-favored) — this is a structural cost of the reordering itself,
 *  not a tuning miss: PUSH_WARD_DISTANCE used to be Archer's cheap,
 *  frequent, spammable tool against Mage's warded token; forcing it to 0 to
 *  satisfy "weakest" removes that entirely, and Charged Shot — gated behind
 *  banking both charges — fires far less often (chargedShot/g ~1-2 per
 *  player per game vs push/g ~10+ under the old design) so it can't fully
 *  substitute. KEPT AT 3 (the best of the two options) as a deliberate
 *  "ship now, re-open later" call — see project session notes for the plan
 *  to revisit archer-vs-mage as its own thread. archer-vs-warrior (50.3/
 *  49.7), archer mirror (50.3/49.7), mage mirror (50.5/49.5), and
 *  mage-vs-warrior (50.6/49.4) all held completely flat through this whole
 *  change, exactly as the scoping argument predicted. */
export const CHARGED_SHOT_WARD_DISTANCE = 3;

/** Ultimates: how many CONSECUTIVE shield-tile landings, within one unbroken
 *  turn-chain, it takes to earn a class's ultimate. Shared by all three
 *  classes — Archer's Rain of Arrows fires immediately on the 3rd landing;
 *  Mage's and Warrior's ultimates (not yet built) instead bank an
 *  ultimateReady flag to spend later. Only 3 shield tiles exist on the whole
 *  board, so this is rare by construction even at 3.
 *  (Balance-sim confirmed at 3, 5000 games/matchup against a freshly
 *  captured pre-change baseline: rainOfArrows/g stayed at 0.007-0.016 —
 *  fires in roughly 1-in-100 games, confirming the rarity — while every
 *  matchup's win split moved less than ~1.5 points from baseline, well
 *  inside normal run-to-run sampling noise (warrior mirror, which should be
 *  mathematically untouched since Rain of Arrows never applies there,
 *  settled to an exact 50.0/50.0). Matchups not involving an Archer showed
 *  rainOfArrows/g=0.0000 exactly, confirming Mage/Warrior's banked
 *  ultimateReady flag has zero gameplay leakage since nothing consumes it
 *  yet. No retuning needed at 3.) */
export const ULTIMATE_STREAK = 3;

/** Warrior's Bulwark: how many of the BULWARKED PLAYER's own turns pass
 *  before an unconsumed Bulwark expires automatically — a countdown, not
 *  permanent insurance (see PowerState.bulwarked for why). Ticked once per
 *  the bulwarked player's own fresh flip (tickBulwarkExpiry), independent of
 *  early consumption (see getBulwarkBlockedIds/consumeBulwarkBlocks), which
 *  clears it the instant it actually saves a token — whichever happens
 *  first.
 *  (Balance-sim tried 2/3/4, 2500 games/matchup, holding the bot's
 *  scoreBulwark heuristic fixed across all three (see master-killer-bot.ts
 *  for why that heuristic itself needed a negative floor — an earlier,
 *  more generous version caused wild over-tuning noise that would have
 *  swamped this comparison). Every value kept the three matchups WITHOUT a
 *  Warrior within ~2 points of the pre-Bulwark baseline, as expected
 *  (Bulwark is fully gated behind classes[x]==="warrior"). But archer-vs-
 *  warrior (baseline ~43.3/56.7 warrior-favored) moved FURTHER from parity
 *  at every value tried — 42.8/57.2 at N=2, 40.2/59.8 at N=3, 38.5/61.5 at
 *  N=4 — the opposite of this ability's hoped-for effect on that matchup;
 *  a defensive tool that never misfires just makes the already-favored
 *  class win more, and longer-lived Bulwark (higher N) only compounds
 *  that (bulwarkBlock/g climbed 1.54 -> 2.43 -> 2.93 across the same
 *  sweep). mage-vs-warrior told the same story (baseline 50.8/49.2 mage-
 *  favored, swinging to 48.2/51.8, 47.2/52.8, 48.0/52.0 warrior-favored at
 *  N=2/3/4 respectively). Landed on 2: it moves archer-vs-warrior the
 *  LEAST (-0.5pt vs -3.1 and -4.8 at N=3/N=4) while still giving Bulwark
 *  real presence (bulwark/g ~9.4, bulwarkBlock/g ~1.5) — the most
 *  conservative value is the healthiest one here, not the default 3. */
export const BULWARK_TURNS = 2;

// ============================================================================
// TYPES
// ============================================================================

export type PlayerClass = "archer" | "mage" | "warrior";

export interface PowerState {
  classes: Record<PlayerId, PlayerClass>;
  /** Banked charges, 0..CHARGE_CAP, per player. */
  charges: Record<PlayerId, number>;
  /** Token ids granted Warrior Ward Breaker's transient safety — cleared
   *  the moment that specific token next moves (its own, or captured). */
  safeTokens: Set<number>;
  /** Guards Mage's Re-flip to once per turn. Reset whenever a fresh flip
   *  is dealt (a new turn, or after auto-skip). */
  reflipUsedThisTurn: boolean;
  /** Consecutive shield-tile landings within one unbroken turn-chain, 0-2
   *  (fires/banks and resets to 0 the instant it would become
   *  ULTIMATE_STREAK). Shared by all three classes. Deliberately NOT reset
   *  by resetTurnFlags — that fires on every resolved turn, including the
   *  shield landing's own extra turn, which is exactly the turn this streak
   *  has to survive. Only cleared by resolveShieldStreak (a non-landing
   *  move/charge that ends the turn), applyPush (never lands the mover on a
   *  shield), or breakShieldStreak (called directly by the server's
   *  auto-skip paths, which resolve a turn-end without going through
   *  resolveTurn at all — same shape of problem zeroFlipChargeBefore in
   *  referee.ts/api/ws.ts already solves for the charge economy). */
  shieldStreak: Record<PlayerId, number>;
  /** True once a Mage or Warrior has completed the shield-streak combo —
   *  their ultimate (not yet built) is banked and spendable on a future
   *  turn of their choosing, unlike Archer's, which resolves immediately
   *  and never sets this. Persists indefinitely until spent: never touched
   *  by resetTurnFlags, and not yet consumed by anything (no ultimate
   *  action exists yet), so it just sits true once earned. */
  ultimateReady: Record<PlayerId, boolean>;
  /** Warrior's Bulwark: token id -> turns remaining before it expires
   *  unconsumed. Presence in the map (any value > 0) means the token is
   *  fully immune to a normal capture, Charge sweep, Blink Strike, or
   *  Warpath (folded into isProtected/isBulwarked — see those), and to a
   *  Push that would send it home specifically (see getPushTargets).
   *  Deliberately NOT reset by resetTurnFlags — same reasoning as
   *  shieldStreak/ultimateReady: resetTurnFlags fires on every resolved
   *  turn, including a shield-landing's own extra turn, and Bulwark has to
   *  survive those without ticking down. Ticked down once per the
   *  BULWARKED player's own fresh flip (tickBulwarkExpiry) and cleared
   *  early the instant it actually blocks something for the opponent
   *  (getBulwarkBlockedIds/consumeBulwarkBlocks) — whichever comes first. */
  bulwarked: Record<number, number>;
}

/** Superset of rulebook.Move — same fields, plus power-derived ones. */
export interface PowerMove {
  tokenId: number;
  from: number;
  to: number;
  captures: number[];
  /** Archer Snipe: 0 or 1 extra captured token id, free of charge. */
  bonusCaptures: number[];
  landsOnShield: boolean;
  causesWin: boolean;
  /** True if the mover is a Warrior and this move's landing tile is a
   *  Mage-warded (non-shield) enemy — Ward Breaker triggers automatically
   *  as part of taking this move, no separate action needed. */
  breaksWard: boolean;
  /** True if a Warrior could spend a charge to Charge through this move
   *  (from >= 0, clear lane of own tokens, at least implicitly meaningful
   *  even if chargeSweepCaptures ends up empty). */
  chargeAvailable: boolean;
  /** Precomputed: enemies on contested tiles strictly between from and to
   *  that a Charge would additionally capture. Only meaningful when
   *  chargeAvailable is true. */
  chargeSweepCaptures: number[];
}

export type PowerAction =
  | { kind: "move"; move: PowerMove }
  | { kind: "push"; targetTokenId: number }
  | { kind: "chargedShot"; targetTokenId: number }
  | { kind: "reflip" }
  | { kind: "charge"; move: PowerMove }
  | { kind: "blinkStrike"; targetTokenId: number }
  | { kind: "warpath"; targetTokenId: number }
  | { kind: "bulwark"; tokenId: number };

// ============================================================================
// STATE
// ============================================================================

export function initialPowerState(): PowerState {
  return {
    classes: { p1: "archer", p2: "archer" }, // placeholder until picked
    charges: { p1: 0, p2: 0 },
    safeTokens: new Set(),
    reflipUsedThisTurn: false,
    shieldStreak: { p1: 0, p2: 0 },
    ultimateReady: { p1: false, p2: false },
    bulwarked: {},
  };
}

/** Called once each turn a fresh flip is dealt (new turn or post-skip). */
export function resetTurnFlags(power: PowerState): PowerState {
  return { ...power, reflipUsedThisTurn: false };
}

/** On-board only (0 <= position < PATH_LENGTH_PER_PLAYER) — escaped tokens
 *  sit at position 15, which would otherwise always outrank real board
 *  positions and permanently (and pointlessly — an escaped token can't be
 *  captured) hog "most advanced", including multiple escaped tokens tying
 *  and warding simultaneously once more than one has come home. */
function isMostAdvanced(state: GameState, token: TokenState): boolean {
  if (token.position < 0 || token.position >= PATH_LENGTH_PER_PLAYER) return false;
  const mine = state.tokens.filter(
    (t) => t.owner === token.owner && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return false;
  const best = Math.max(...mine.map((t) => t.position));
  return token.position === best;
}

/** Mage's Blink Strike ultimate always moves the mover's most-advanced
 *  on-board token (the same one Ward would protect) — null if they have no
 *  on-board tokens at all. */
function findMostAdvancedToken(state: GameState, mover: PlayerId): TokenState | null {
  const mine = state.tokens.filter(
    (t) => t.owner === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => (t.position > best.position ? t : best));
}

/** Warrior's Warpath ultimate always moves the mover's LEAST-advanced
 *  on-board token — the one that benefits most from an instant reposition —
 *  null if they have no on-board tokens at all. */
function findLeastAdvancedToken(state: GameState, mover: PlayerId): TokenState | null {
  const mine = state.tokens.filter(
    (t) => t.owner === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER,
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, t) => (t.position < best.position ? t : best));
}

/** Is this token currently protected by its owner's Ward? Derived, not
 *  stored — see the Mage kit note in the plan for why it's gated at the
 *  full charge cap rather than any-charge. */
export function isWarded(
  state: GameState,
  power: PowerState,
  token: TokenState,
): boolean {
  if (power.classes[token.owner] !== "mage") return false;
  if (power.charges[token.owner] < CHARGE_CAP) return false;
  if (WARD_SCOPE === "most-advanced") return isMostAdvanced(state, token);
  return true;
}

/** Is this token currently protected by a real shield TILE (base-game rule,
 *  same as rulebook's Q5a — every class respects this, including Warriors). */
function onShieldTile(token: TokenState): boolean {
  if (token.position < 0 || token.position >= PATH_LENGTH_PER_PLAYER) return false;
  return BOARD_LAYOUT[token.position].type === "shield";
}

/** Is this token currently protected by Warrior Ward Breaker's transient
 *  "safe until it next moves" grant? Unlike Ward, nothing pierces this —
 *  not even another Warrior's Ward Breaker — it's a simple temporary
 *  shield, not a re-breakable one. */
function hasTransientSafety(power: PowerState, token: TokenState): boolean {
  return power.safeTokens.has(token.id);
}

/** Is this token currently protected by Warrior Bulwark? Live map lookup —
 *  presence in power.bulwarked (any positive turns-remaining count) means
 *  "still active." Like a shield tile or transient safety (and unlike
 *  Ward), nothing pierces this for normal captures/Charge — see isProtected.
 *  TWO exceptions: a soft (non-home) Push, which Bulwark deliberately does
 *  not block (see getPushTargets's own Bulwark-aware filter, not this
 *  function); and Rain of Arrows, which — by the same "punches through
 *  everything" identity that lets it ignore shield tiles and Ward — also
 *  ignores Bulwark (see excludeBulwarked's doc; resolveTurn clears a
 *  captured token's bulwarked entry so this doesn't leak free protection
 *  across a reserve trip). Blink Strike and Warpath, unlike Rain of Arrows,
 *  DO respect Bulwark. */
export function isBulwarked(power: PowerState, token: TokenState): boolean {
  return power.bulwarked[token.id] !== undefined;
}

/** Universal "is this token capturable/pushable/sweepable AT ALL right
 *  now" check, used everywhere EXCEPT the main landing-capture path (which
 *  needs to distinguish ward-protection specifically, since that's the one
 *  case a Warrior's landing can pierce via Ward Breaker) and Push (which
 *  can also pierce Ward, at a price, and only partially pierces Bulwark —
 *  see getPushTargets/pushCost). Shield tiles, transient safety, and
 *  Bulwark block every class with no exception. */
function isProtected(state: GameState, power: PowerState, token: TokenState): boolean {
  return (
    onShieldTile(token) ||
    hasTransientSafety(power, token) ||
    isWarded(state, power, token) ||
    isBulwarked(power, token)
  );
}

/** What a Push against this specific target will cost: PUSH_WARD_COST if
 *  it's currently warded, 1 otherwise. Evaluated against the pre-push
 *  state/target, since isWarded is derived from live board position. */
function pushCost(state: GameState, power: PowerState, target: TokenState): number {
  return isWarded(state, power, target) ? PUSH_WARD_COST : 1;
}

/** How far a Push against this specific target knocks it back:
 *  PUSH_WARD_DISTANCE if it's currently warded, PUSH_DISTANCE otherwise. */
function pushDistance(state: GameState, power: PowerState, target: TokenState): number {
  return isWarded(state, power, target) ? PUSH_WARD_DISTANCE : PUSH_DISTANCE;
}

function addCharge(power: PowerState, player: PlayerId): PowerState {
  const current = power.charges[player];
  if (current >= CHARGE_CAP) return power;
  return { ...power, charges: { ...power.charges, [player]: current + 1 } };
}

export function grantZeroFlipCharge(power: PowerState, mover: PlayerId): PowerState {
  return addCharge(power, mover);
}

// ============================================================================
// MOVE GENERATION
//
// Reimplements rulebook.getLegalMoves()'s from/to/occupancy walk rather than
// wrapping it — Ward changes LEGALITY (a warded-but-non-shield landing must
// flip from "legal capture" to "illegal" for non-Warriors), which a wrapper
// around the classic function can't express without changing its signature.
// Kept intentionally close in shape/order to the original so a side-by-side
// diff stays readable; see the anti-drift regression test for the safety
// net this duplication needs.
// ============================================================================

export function getLegalPowerMoves(
  state: GameState,
  power: PowerState,
  flip: number,
): PowerMove[] {
  if (state.winner !== null) return [];
  if (flip <= 0) return [];

  const player = state.currentPlayer;
  const cls = power.classes[player];
  const moves: PowerMove[] = [];

  for (const token of state.tokens) {
    if (token.owner !== player) continue;
    if (token.position >= PATH_LENGTH_PER_PLAYER) continue; // already escaped

    const from = token.position;
    const to = from === -1 ? flip - 1 : from + flip;

    // Escape — identical to the classic rule, no power interacts with it.
    if (to >= PATH_LENGTH_PER_PLAYER - 1) {
      if (to !== PATH_LENGTH_PER_PLAYER - 1) continue;
      const remaining = state.tokens.filter(
        (t) => t.owner === player && t.id !== token.id && t.position < PATH_LENGTH_PER_PLAYER,
      );
      moves.push({
        tokenId: token.id,
        from,
        to: PATH_LENGTH_PER_PLAYER,
        captures: [],
        bonusCaptures: [],
        landsOnShield: false,
        causesWin: remaining.length === 0,
        breaksWard: false,
        chargeAvailable: false,
        chargeSweepCaptures: [],
      });
      continue;
    }

    const destTile = BOARD_LAYOUT[to];
    const occupants = state.tokens.filter(
      (t) => t.position === to && t.id !== token.id && (destTile.isContested || t.owner === player),
    );
    const self = occupants.find((t) => t.owner === player);
    const enemy = occupants.find((t) => t.owner !== player);

    if (self) continue; // own-token blocks, same as classic

    let captures: number[] = [];
    let breaksWard = false;

    if (enemy) {
      // Shield tiles, transient safety, and Bulwark block EVERY class, no
      // exception — Bulwark isn't something even a Warrior's Ward Breaker
      // pierces, unlike Ward.
      if (onShieldTile(enemy) || hasTransientSafety(power, enemy) || isBulwarked(power, enemy)) continue;
      if (isWarded(state, power, enemy)) {
        if (cls !== "warrior") continue; // blocked for everyone but a Warrior
        breaksWard = true; // Ward Breaker: legal, captures, grants safety below
        captures = [enemy.id];
      } else {
        captures = [enemy.id]; // normal contested capture
      }
    }

    // Archer Snipe (passive, free): a second unprotected enemy exactly one
    // tile further along the shared contested row. MUST check that to+1 is
    // itself a contested tile, not just "<= 11" — tiles 0-3 and 12-14 are
    // each player's own private lane, where the SAME index numbers a
    // completely different physical square for each owner (this is what
    // makes "home base" safe at all). Without this check, an Archer sitting
    // in their own private lane could snipe an enemy token that merely
    // shares a numeric index in ITS OWN separate private lane — a real bug
    // found via playtest confusion ("why are we attacking tokens on the
    // home base?"), confirmed with a repro: archer enters at to=0, enemy
    // sits at their own private position 1, Snipe fired anyway.
    const bonusCaptures: number[] = [];
    if (cls === "archer" && BOARD_LAYOUT[to + 1].isContested) {
      const sniped = state.tokens.find(
        (t) => t.position === to + 1 && t.owner !== player && t.id !== enemy?.id,
      );
      if (sniped && !isProtected(state, power, sniped)) {
        bonusCaptures.push(sniped.id);
      }
    }

    // Warrior Charge availability: from must be on-board and every
    // intermediate contested tile must be clear of the Warrior's own
    // tokens. The sweep itself only touches contested tiles strictly
    // between from and to, and — like a normal move — never crosses a
    // shield tile or a token under Warrior Ward Breaker's own transient
    // safety. A WARDED token in the sweep IS captured, same as a direct
    // landing — Ward Breaker's whole identity is "Warriors pierce Ward,"
    // so the sweep shouldn't quietly disagree with that just because the
    // token is in the middle of the lane instead of the landing tile. A
    // BULWARKED token, unlike a warded one, is NOT captured by the sweep —
    // Bulwark isn't something Ward Breaker was ever meant to pierce.
    let chargeAvailable = false;
    const chargeSweepCaptures: number[] = [];
    if (cls === "warrior" && from >= 0) {
      let laneClear = true;
      for (let i = from + 1; i < to; i++) {
        const tile = BOARD_LAYOUT[i];
        if (!tile.isContested) continue; // sweep only matters on shared tiles
        const occ = state.tokens.filter((t) => t.position === i && t.id !== token.id);
        if (occ.some((t) => t.owner === player)) {
          laneClear = false;
          break;
        }
        const foe = occ.find((t) => t.owner !== player);
        if (
          foe &&
          chargeSweepCaptures.length < CHARGE_SWEEP_CAP &&
          !onShieldTile(foe) &&
          !hasTransientSafety(power, foe) &&
          !isBulwarked(power, foe)
        ) {
          chargeSweepCaptures.push(foe.id);
        }
        // Keep scanning past the cap anyway — laneClear still needs the
        // WHOLE lane checked for the Warrior's own blocking tokens, even
        // once no more captures will be recorded.
      }
      chargeAvailable = laneClear;
    }

    moves.push({
      tokenId: token.id,
      from,
      to,
      captures,
      bonusCaptures,
      landsOnShield: destTile.type === "shield",
      causesWin: false,
      breaksWard,
      chargeAvailable,
      chargeSweepCaptures,
    });
  }

  return moves;
}

// ============================================================================
// APPLYING MOVES / ACTIONS
// ============================================================================

/** Rain of Arrows' target pool (Archer's ultimate only): enemy tokens,
 *  on-board, anywhere in the contested zone — deliberately skipping
 *  onShieldTile/isWarded, since punching through both is the whole point.
 *  Only hasTransientSafety still guards against it. */
export function getRainOfArrowsTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => t.owner === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => !hasTransientSafety(power, t))
    .map((t) => t.id);
}

/** Breaks a player's shield-streak combo — called both from applyPush
 *  (which never lands the mover on a shield, so it always ends any live
 *  streak) and directly by the server's auto-skip paths (referee.ts/
 *  api/ws.ts resolve a turn-end without ever going through resolveTurn,
 *  same shape of problem grantZeroFlipCharge already solves for the charge
 *  economy). No class gate needed — every class tracks this now. */
export function breakShieldStreak(power: PowerState, player: PlayerId): PowerState {
  if (power.shieldStreak[player] === 0) return power;
  return { ...power, shieldStreak: { ...power.shieldStreak, [player]: 0 } };
}

/** Advances or breaks the mover's shield-streak for this resolving action,
 *  and resolves whatever completing it means for their class. Archer's
 *  ultimate (Rain of Arrows) fires immediately; Mage/Warrior instead bank
 *  ultimateReady for a not-yet-built active ability to spend later. */
function resolveShieldStreak(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
  landsOnShield: boolean,
  allCaptures: number[],
  rand: () => number,
): { power: PowerState; rainOfArrows: { targetTokenId: number | null } | null } {
  if (!landsOnShield) return { power: breakShieldStreak(power, mover), rainOfArrows: null };

  const next = power.shieldStreak[mover] + 1;
  if (next < ULTIMATE_STREAK) {
    return { power: { ...power, shieldStreak: { ...power.shieldStreak, [mover]: next } }, rainOfArrows: null };
  }

  // Completed the combo — consumed either way, regardless of class or target availability.
  const reset: PowerState = { ...power, shieldStreak: { ...power.shieldStreak, [mover]: 0 } };
  const cls = power.classes[mover];
  if (cls !== "archer") {
    return { power: { ...reset, ultimateReady: { ...reset.ultimateReady, [mover]: true } }, rainOfArrows: null };
  }

  const pool = getRainOfArrowsTargets(state, reset, mover).filter((id) => !allCaptures.includes(id));
  if (pool.length === 0) return { power: reset, rainOfArrows: { targetTokenId: null } };
  const picked = pool[Math.floor(rand() * pool.length)];
  return { power: reset, rainOfArrows: { targetTokenId: picked } };
}

/** Shared plumbing: send a set of token ids to reserve, advance the mover,
 *  clear any of their SPENT (stale, prior-turn) Ward Breaker safety, grant
 *  fresh safety if THIS move just broke a ward, grant a charge for a
 *  capturing/shield-landing move, hand the turn to the opponent (or keep it
 *  on a shield landing), and reset per-turn flags for the next flip.
 *
 *  Ordering matters: stale safety is cleared BEFORE a fresh grant is added,
 *  never after — otherwise a same-turn Ward Breaker grant would be wiped
 *  out by its own move's stale-safety cleanup before ever being returned. */
function resolveTurn(
  state: GameState,
  power: PowerState,
  mover: PlayerId,
  tokenId: number,
  to: number,
  allCaptures: number[],
  landsOnShield: boolean,
  causesWin: boolean,
  grantsSafety: boolean,
  rand: () => number = Math.random,
): { state: GameState; power: PowerState; rainOfArrows: { targetTokenId: number | null } | null } {
  const streakResult = resolveShieldStreak(state, power, mover, landsOnShield, allCaptures, rand);
  power = streakResult.power;
  const rainOfArrows = streakResult.rainOfArrows;
  const finalCaptures =
    rainOfArrows?.targetTokenId != null ? [...allCaptures, rainOfArrows.targetTokenId] : allCaptures;

  const tokens = state.tokens.map((t) => {
    if (t.id === tokenId) return { ...t, position: to };
    if (finalCaptures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });

  let safeTokens = power.safeTokens;
  if (safeTokens.has(tokenId) || finalCaptures.some((id) => safeTokens.has(id))) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(tokenId); // this token moved — any OLD safety it carried is spent
    for (const id of finalCaptures) safeTokens.delete(id); // captured tokens carry none forward
  }
  if (grantsSafety) {
    safeTokens = new Set(safeTokens);
    safeTokens.add(tokenId); // fresh grant, added AFTER the stale-clear above
  }

  // A captured token's Bulwark must clear too — Rain of Arrows is the one
  // capture path that deliberately ignores isBulwarked (see excludeBulwarked's
  // doc), so a Bulwarked token CAN be sent home by it. Without this, the
  // stale bulwarked[id] entry survives the trip to reserve and grants free,
  // un-recast protection the instant that token re-enters the board later.
  let bulwarked = power.bulwarked;
  if (finalCaptures.some((id) => bulwarked[id] !== undefined)) {
    bulwarked = { ...bulwarked };
    for (const id of finalCaptures) delete bulwarked[id];
  }

  let nextPower: PowerState = { ...power, safeTokens, bulwarked };
  if (finalCaptures.length > 0 || landsOnShield) {
    nextPower = addCharge(nextPower, mover);
  }

  const extraTurn = landsOnShield;
  const nextState: GameState = {
    tokens,
    currentPlayer: extraTurn ? mover : otherPlayerId(mover),
    lastFlip: null,
    winner: causesWin ? mover : null,
    extraTurn,
  };
  return { state: nextState, power: resetTurnFlags(nextPower), rainOfArrows };
}

export function applyPowerMove(
  state: GameState,
  power: PowerState,
  move: PowerMove,
  mover: PlayerId,
  rand: () => number = Math.random,
): { state: GameState; power: PowerState; rainOfArrows: { targetTokenId: number | null } | null } {
  const allCaptures = [...move.captures, ...move.bonusCaptures];
  return resolveTurn(
    state,
    power,
    mover,
    move.tokenId,
    move.to,
    allCaptures,
    move.landsOnShield,
    move.causesWin,
    move.breaksWard,
    rand,
  );
}

/** Warrior's Charge: same move, but the sweep captures ride along too, and
 *  (like any move) a Ward Breaker landing still grants its safety. */
export function applyCharge(
  state: GameState,
  power: PowerState,
  move: PowerMove,
  mover: PlayerId,
  rand: () => number = Math.random,
): { state: GameState; power: PowerState; rainOfArrows: { targetTokenId: number | null } | null } {
  const allCaptures = [...move.captures, ...move.bonusCaptures, ...move.chargeSweepCaptures];
  const spent: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 },
  };
  // resolveTurn grants a charge back if this capture-laden move qualifies
  // under the normal economy (it almost always will) — that's correct, not
  // a double-spend: the -1 above IS the Charge action's cost, separate from
  // whatever this move's own capture(s) earn.
  return resolveTurn(
    state,
    spent,
    mover,
    move.tokenId,
    move.to,
    allCaptures,
    move.landsOnShield,
    move.causesWin,
    move.breaksWard,
    rand,
  );
}

/** Shared collision math for a hypothetical knockback of `distance` tiles
 *  against `target`: the landing tile it would end up on, or -1 if it
 *  collides/underflows and gets sent all the way home. Read-only —
 *  parameterized by distance so Push (computePushLanding, PUSH_DISTANCE/
 *  PUSH_WARD_DISTANCE via pushDistance()) and Charged Shot
 *  (computeChargedShotLanding, flat CHARGED_SHOT_DISTANCE) can each resolve
 *  their OWN collision math against a single shared source of truth for
 *  what counts as a send-home, without either one having to reimplement it. */
function computeKnockbackLanding(state: GameState, target: TokenState, distance: number): number {
  const rawTo = target.position - distance;
  // Same-owner tokens share a lane everywhere, so any position match is a
  // real collision. Different-owner tokens only physically share a tile in
  // the contested zone (positions 4-11 are the SAME square for both
  // players' path numbering) — a match outside it is two different tiles
  // that just happen to have the same index, not a collision. Without the
  // contested check here, a push could silently land an enemy token on top
  // of the pusher's own token (both owners, same contested tile), which
  // getLegalPowerMoves's single-token-per-tile assumptions can't handle.
  const contestedLanding = rawTo >= 0 && rawTo < PATH_LENGTH_PER_PLAYER && BOARD_LAYOUT[rawTo].isContested;
  const collides = state.tokens.some(
    (t) =>
      t.id !== target.id &&
      t.position === rawTo &&
      (t.owner === target.owner || contestedLanding),
  );
  return collides || rawTo < 0 ? -1 : rawTo;
}

/** Archer's Push: see computeKnockbackLanding — used both to decide THIS
 *  turn's legal Push targets (see getPushTargets's Bulwark-aware filter
 *  below — the one case Bulwark blocks a Push) and to actually resolve a
 *  chosen push (applyPush). */
function computePushLanding(state: GameState, power: PowerState, target: TokenState): number {
  return computeKnockbackLanding(state, target, pushDistance(state, power, target));
}

/** Archer's Charged Shot: same idea as computePushLanding — CHARGED_SHOT_DISTANCE
 *  against an unwarded target, CHARGED_SHOT_WARD_DISTANCE against a Warded
 *  one (added 2026-07-16; previously flat regardless of Ward, back when a
 *  Warded target was fully excluded from getChargedShotTargets instead — see
 *  CHARGED_SHOT_WARD_DISTANCE's doc for why that changed). This is Charged
 *  Shot's own collision math, deliberately not reusing pushDistance()'s
 *  PUSH_DISTANCE/PUSH_WARD_DISTANCE values (the two abilities' Ward-tiers are
 *  independently tunable, per Kasen's requested strict ordering). Used by
 *  both getChargedShotTargets's Bulwark-aware filter and applyChargedShot. */
function computeChargedShotLanding(state: GameState, power: PowerState, target: TokenState): number {
  const distance = isWarded(state, power, target) ? CHARGED_SHOT_WARD_DISTANCE : CHARGED_SHOT_DISTANCE;
  return computeKnockbackLanding(state, target, distance);
}

/** Archer's Push: valid targets are enemy tokens on a contested tile that
 *  aren't shield/transient-safety blocked. A warded token is ALSO a valid
 *  target, but only if the Archer can afford PUSH_WARD_COST — baking
 *  affordability into the target list itself (rather than a separate
 *  legality branch at the call site) so the UI's target highlights and the
 *  server's legality check can never drift apart. Ends the turn — no token
 *  of the pusher's moves (see applyPush's history note for why granting an
 *  extra turn here was tried and reverted).
 *
 *  A Bulwarked token is ALSO a valid target — Bulwark deliberately does NOT
 *  give full Push immunity, since Push usually just knocks a token back a
 *  few tiles while it stays on the board (a "soft" effect the game already
 *  allows against Bulwarked tokens). Bulwark only blocks the cases where
 *  THIS SPECIFIC push would send the target all the way home (the same
 *  collision math computePushLanding/applyPush use) — a live per-target
 *  check, not a blanket exclusion, mirroring exactly how the isWarded
 *  filter above gates on affordability rather than excluding warded targets
 *  outright.
 *
 *  Refunds its charge (see applyPush) specifically when it sends the target
 *  all the way home to reserve — that outcome is functionally a capture
 *  (the token is off the board, back to square one), so it earns the same
 *  refund any other capturing action gets under the shared charge economy.
 *  A partial shove that leaves the target on the board is NOT a capture and
 *  never refunds. */
export function getPushTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => t.owner === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => !onShieldTile(t) && !hasTransientSafety(power, t))
    .filter((t) => !isWarded(state, power, t) || power.charges[mover] >= PUSH_WARD_COST)
    .filter((t) => !isBulwarked(power, t) || computePushLanding(state, power, t) !== -1)
    .map((t) => t.id);
}

export function applyPush(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const cost = pushCost(state, power, target);
  const landing = computePushLanding(state, power, target);
  const sendsHome = landing === -1; // functionally a capture — refund below

  const tokens = state.tokens.map((t) => (t.id === targetTokenId ? { ...t, position: landing } : t));
  let safeTokens = power.safeTokens;
  if (safeTokens.has(targetTokenId)) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(targetTokenId);
  }
  let spentPower: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - cost },
    safeTokens,
  };
  if (sendsHome) spentPower = addCharge(spentPower, mover);
  spentPower = breakShieldStreak(spentPower, mover); // Push never lands the mover on a shield
  // TRIED AND REVERTED: granting Push an extra turn (same mechanism as a
  // shield-tile landing — currentPlayer stays the mover) was meant to stop
  // Push from costing the Archer's own board progress, matching how
  // Warrior's Charge advances-while-capturing and Mage's Re-flip doesn't
  // end the turn at all. It compounds instead of just offsetting: a fully
  // charged Archer could chain 2 free pushes (CHARGE_CAP) THEN still make a
  // real move, 3 actions against the opponent's 1, every single round.
  // Result: archer-vs-mage 95.3/4.7, archer-vs-warrior 91.8/8.2 — nowhere
  // close to a fix, a total blowout. Reverted to ending the turn normally.
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(spentPower) };
}

/** Archer's Charged Shot: same target pool shape as Push (contested-zone
 *  enemy, shield-tile/transient-safety/Bulwark-vs-would-this-specific-shot-
 *  send-home protections all mirrored exactly), but with one deliberate
 *  difference from getPushTargets:
 *
 *  Gated on `power.charges[mover] === CHARGE_CAP` right here in the pure
 *  target-getter, unlike getPushTargets/getBulwarkTargets (whose baseline
 *  "at least 1 charge" gate is dispatch-layer/UI-only). Charged Shot's
 *  affordability isn't per-target the way PUSH_WARD_COST is (some targets
 *  cost more than others) — it's a single uniform "has the mover banked
 *  the full cap at all" check, identical for every target, so baking it
 *  in here means the server dispatch, the bot, and the client's target
 *  highlights can never drift on it independently — an empty pool below
 *  the cap is the whole answer, everywhere this is called.
 *
 *  A Warded token IS a legal target (changed 2026-07-16 — see
 *  CHARGED_SHOT_WARD_DISTANCE's doc): previously excluded outright with no
 *  affordability escape hatch, same as a shield tile. Now Ward only
 *  determines WHICH distance applies (CHARGED_SHOT_WARD_DISTANCE vs
 *  CHARGED_SHOT_DISTANCE, both handled inside computeChargedShotLanding),
 *  not whether the shot is legal at all.
 *
 *  The Bulwark filter uses computeChargedShotLanding — THIS ability's own
 *  distance/collision math — not computePushLanding's, so a Bulwarked token
 *  is excluded here only if Charged Shot's OWN distance (Ward-aware) would
 *  send it home, independent of whether a normal Push would. */
export function getChargedShotTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (power.charges[mover] !== CHARGE_CAP) return [];
  const foe = otherPlayerId(mover);
  return state.tokens
    .filter((t) => t.owner === foe && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => BOARD_LAYOUT[t.position].isContested)
    .filter((t) => !onShieldTile(t) && !hasTransientSafety(power, t))
    .filter((t) => !isBulwarked(power, t) || computeChargedShotLanding(state, power, t) !== -1)
    .map((t) => t.id);
}

/** Archer's Charged Shot: spends BOTH banked charges (CHARGE_CAP) at once —
 *  like every other power action's pure apply* function, this doesn't
 *  self-guard on `power.charges[mover] === CHARGE_CAP`; the caller (see
 *  getChargedShotTargets's doc) already verified it. Refunds 1 charge via
 *  the exact same mechanism applyPush uses when it sends the target all the
 *  way home — reusing addCharge, not a reimplementation — so a hit nets -1
 *  charges (spend 2, refund 1) rather than Push's net 0 (spend 1, refund 1).
 *  Ends the turn, same as Push (no token of the Archer's own moves), and
 *  breaks any live shield streak for the same reason. */
export function applyChargedShot(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const landing = computeChargedShotLanding(state, power, target);
  const sendsHome = landing === -1; // functionally a capture — refund below

  const tokens = state.tokens.map((t) => (t.id === targetTokenId ? { ...t, position: landing } : t));
  let safeTokens = power.safeTokens;
  if (safeTokens.has(targetTokenId)) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(targetTokenId);
  }
  let spentPower: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - CHARGE_CAP },
    safeTokens,
  };
  if (sendsHome) spentPower = addCharge(spentPower, mover);
  spentPower = breakShieldStreak(spentPower, mover); // Charged Shot never lands the mover on a shield
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(spentPower) };
}

/** Mage's Re-flip: spends a charge, does NOT end the turn — the caller
 *  re-rolls with flipCoins() and recomputes legal moves against the same
 *  (unmoved) GameState. Guarded to once per turn by reflipUsedThisTurn. */
export function applyReflip(power: PowerState, mover: PlayerId): PowerState {
  return {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 },
    reflipUsedThisTurn: true,
  };
}

// ============================================================================
// ULTIMATES — see ULTIMATE_STREAK. Archer's Rain of Arrows (above) is
// passive and fully automatic; Mage's Blink Strike and Warrior's Warpath
// are active — completing the shield-streak combo banks ultimateReady, and
// these two are what a Mage/Warrior spends it on. Both auto-select WHICH of
// the mover's own tokens relocates (Mage: most-advanced/Ward-carrying,
// Warrior: least-advanced — the one that benefits most from a free
// reposition) rather than letting the player choose a source token, keeping
// the target-selection UI identical to Push's "tap one target" flow.
// ============================================================================

/** Filters a target-id pool down to non-Bulwarked tokens. Rain of Arrows
 *  itself does NOT use this (it deliberately punches through shield tiles
 *  and Ward, and — by the same "punches through everything" identity —
 *  Bulwark too); Blink Strike and Warpath DO, since a Bulwarked token is
 *  meant to be fully immune to them (see isProtected/isBulwarked). Kept as
 *  a filter over the SAME pool getRainOfArrowsTargets already computes
 *  rather than a parallel target-eligibility function, so this can't drift
 *  from that rule. */
function excludeBulwarked(state: GameState, power: PowerState, ids: number[]): number[] {
  return ids.filter((id) => {
    const t = state.tokens.find((tok) => tok.id === id)!;
    return !isBulwarked(power, t);
  });
}

/** Mage's Blink Strike ultimate: valid targets are the same as Rain of
 *  Arrows (contested-zone enemies, bypassing shield tiles and Ward, but not
 *  transient safety) minus any Bulwarked token — reused directly since the
 *  underlying "who's vulnerable to a shield/ward-piercing strike" rule is
 *  identical. Empty if the mover has no on-board token to relocate at all. */
export function getBlinkStrikeTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (!findMostAdvancedToken(state, mover)) return [];
  return excludeBulwarked(state, power, getRainOfArrowsTargets(state, power, mover));
}

/** Warrior's Warpath ultimate: same target eligibility as Blink Strike —
 *  the sweep along the way (see applyWarpath) uses the same rule too.
 *  Empty if the mover has no on-board token to relocate at all. */
export function getWarpathTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  if (!findLeastAdvancedToken(state, mover)) return [];
  return excludeBulwarked(state, power, getRainOfArrowsTargets(state, power, mover));
}

/** Mage's Blink Strike: instantly relocates the mover's most-advanced
 *  on-board token onto the target's tile, capturing it — bypassing shield
 *  tiles and Ward, same as Rain of Arrows, but not transient safety (see
 *  getBlinkStrikeTargets). Spends the banked ultimateReady flag, not a
 *  charge — but still grants a charge back on the capture, same as any
 *  other capturing action. Always ends the turn, even if the destination
 *  happens to be a shield tile — deliberately no extra-turn interaction
 *  here, given this codebase's history with extra-turn balance blowups. */
export function applyBlinkStrike(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; sweptTokenIds: number[] } {
  const mine = findMostAdvancedToken(state, mover)!;
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: target.position };
    if (t.id === targetTokenId) return { ...t, position: -1 };
    return t;
  });
  let safeTokens = power.safeTokens;
  if (safeTokens.has(mine.id) || safeTokens.has(targetTokenId)) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(mine.id);
    safeTokens.delete(targetTokenId);
  }
  let nextPower: PowerState = {
    ...power,
    safeTokens,
    ultimateReady: { ...power.ultimateReady, [mover]: false },
  };
  nextPower = addCharge(nextPower, mover);
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  // sweptTokenIds is always empty for Blink Strike — kept in the return
  // shape purely so callers can treat it and applyWarpath's result
  // uniformly, since Blink Strike never sweeps.
  return { state: nextState, power: resetTurnFlags(nextPower), sweptTokenIds: [] };
}

/** Warrior's Warpath: instantly relocates the mover's LEAST-advanced
 *  on-board token onto the target's tile, capturing it, AND sweeps every
 *  unprotected enemy on a contested tile strictly between where that token
 *  started and where it lands (either direction — this is a teleport, not
 *  a real move, so "forward" doesn't matter) — uncapped, unlike Charge's
 *  CHARGE_SWEEP_CAP. Same bypass rules as Blink Strike (shield + Ward, not
 *  transient safety) for every token it hits, primary or swept. If it
 *  breaks a Ward anywhere along the way, the landing token gets
 *  Ward Breaker's usual transient-safety grant — ties this back to
 *  Warrior's core identity instead of being a bare reskin of Blink Strike.
 *  Spends ultimateReady, not a charge; still grants exactly 1 charge back
 *  on a successful capture, matching Charge's own sweep economy (one
 *  capturing move = one charge, regardless of how many tokens it takes
 *  down). Always ends the turn — no extra-turn interaction. */
export function applyWarpath(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState; sweptTokenIds: number[] } {
  const mine = findLeastAdvancedToken(state, mover)!;
  const target = state.tokens.find((t) => t.id === targetTokenId)!;
  const from = mine.position;
  const to = target.position;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);

  const sweepCaptures: number[] = [];
  let brokeWard = isWarded(state, power, target);
  for (let i = lo + 1; i < hi; i++) {
    if (!BOARD_LAYOUT[i].isContested) continue;
    const foe = state.tokens.find(
      (t) => t.position === i && t.owner !== mover && t.id !== mine.id && t.id !== targetTokenId,
    );
    if (foe && !hasTransientSafety(power, foe) && !isBulwarked(power, foe)) {
      sweepCaptures.push(foe.id);
      if (isWarded(state, power, foe)) brokeWard = true;
    }
  }

  const allCaptures = [targetTokenId, ...sweepCaptures];
  const tokens = state.tokens.map((t) => {
    if (t.id === mine.id) return { ...t, position: to };
    if (allCaptures.includes(t.id)) return { ...t, position: -1 };
    return t;
  });

  let safeTokens = power.safeTokens;
  if (safeTokens.has(mine.id) || allCaptures.some((id) => safeTokens.has(id))) {
    safeTokens = new Set(safeTokens);
    safeTokens.delete(mine.id);
    for (const id of allCaptures) safeTokens.delete(id);
  }
  if (brokeWard) {
    safeTokens = new Set(safeTokens);
    safeTokens.add(mine.id);
  }

  let nextPower: PowerState = {
    ...power,
    safeTokens,
    ultimateReady: { ...power.ultimateReady, [mover]: false },
  };
  nextPower = addCharge(nextPower, mover);
  const nextState: GameState = {
    tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(nextPower), sweptTokenIds: sweepCaptures };
}

// ============================================================================
// WARRIOR'S BULWARK — a second charge-spend active for Warrior (alongside
// Charge). The mover taps ONE OF THEIR OWN on-board tokens to flag it
// Bulwarked: full immunity to a normal capture, a Charge sweep, Blink
// Strike, or Warpath (folded into isProtected/isBulwarked, so every
// existing capture-legality check above already respects it for free), and
// immunity to a Push that would send it home specifically (see
// getPushTargets) — but NOT to a soft, on-board Push knockback, which is
// deliberately still allowed. This is the one power action that targets the
// MOVER'S OWN token instead of an enemy's or having no target at all.
// ============================================================================

/** Warrior's Bulwark: valid targets are the mover's own on-board tokens
 *  that aren't already Bulwarked — no point re-flagging one that's already
 *  protected, so it's excluded from the target list entirely. */
export function getBulwarkTargets(state: GameState, power: PowerState, mover: PlayerId): number[] {
  return state.tokens
    .filter((t) => t.owner === mover && t.position >= 0 && t.position < PATH_LENGTH_PER_PLAYER)
    .filter((t) => !isBulwarked(power, t))
    .map((t) => t.id);
}

/** Warrior's Bulwark: spends a charge to flag one of the mover's own
 *  on-board tokens Bulwarked for BULWARK_TURNS of the mover's own turns
 *  (see tickBulwarkExpiry), or until it's consumed by actually blocking a
 *  capture (see getBulwarkBlockedIds/consumeBulwarkBlocks), whichever comes
 *  first. No board movement at all — never lands the mover on a shield, so
 *  (like Push) it always breaks any live shield streak and always ends the
 *  turn, no extra-turn interaction. Doesn't grant a charge back — it
 *  doesn't capture anything itself. */
export function applyBulwark(
  state: GameState,
  power: PowerState,
  targetTokenId: number,
  mover: PlayerId,
): { state: GameState; power: PowerState } {
  const spent: PowerState = {
    ...power,
    charges: { ...power.charges, [mover]: power.charges[mover] - 1 },
    bulwarked: { ...power.bulwarked, [targetTokenId]: BULWARK_TURNS },
  };
  const broken = breakShieldStreak(spent, mover); // Bulwark never lands the mover on a shield
  const nextState: GameState = {
    tokens: state.tokens,
    currentPlayer: otherPlayerId(mover),
    lastFlip: null,
    winner: null,
    extraTurn: false,
  };
  return { state: nextState, power: resetTurnFlags(broken) };
}

/** Ticks down the countdown on every token `mover` currently has
 *  Bulwarked — one of THEIR OWN turns has just started. Any counter that
 *  reaches 0 expires (cleared) automatically — the "don't get free
 *  permanent insurance from a single cast" guard BULWARK_TURNS exists for.
 *  Call once per fresh flip dealt to `mover` at the START of a brand-new
 *  turn (see tickBulwarkForNewTurn) — NOT on a Re-flip's replacement roll,
 *  which is still the same turn and must not double-decrement. */
export function tickBulwarkExpiry(state: GameState, power: PowerState, mover: PlayerId): PowerState {
  const mine = Object.keys(power.bulwarked)
    .map(Number)
    .filter((id) => state.tokens.find((t) => t.id === id)?.owner === mover);
  if (mine.length === 0) return power;
  const bulwarked = { ...power.bulwarked };
  for (const id of mine) {
    const remaining = bulwarked[id] - 1;
    if (remaining <= 0) delete bulwarked[id];
    else bulwarked[id] = remaining;
  }
  return { ...power, bulwarked };
}

/** Ids of the CURRENT mover's opponent's Bulwarked tokens that Bulwark
 *  ACTUALLY blocked THIS flip — would have been captured by a normal move
 *  (including Snipe), a Charge sweep (only if the mover can actually afford
 *  Charge this turn), an available ultimate, or sent home by a Push (only
 *  if the mover can afford one), had Bulwark not protected them.
 *
 *  Computed by diffing the real move/target lists against the SAME lists
 *  with every Bulwark switched off, rather than reimplementing any capture
 *  legality here — so this can never drift from the rules enforced above
 *  (isProtected/isBulwarked, getPushTargets, getBlinkStrikeTargets,
 *  getWarpathTargets). A token surfacing as a NEW capture/target once
 *  Bulwark is switched off, that isn't in the real (Bulwark-respecting)
 *  result, means Bulwark was the thing blocking it. */
export function getBulwarkBlockedIds(state: GameState, power: PowerState, flip: number): number[] {
  if (Object.keys(power.bulwarked).length === 0) return [];
  const mover = state.currentPlayer;
  const unbulwarked: PowerState = { ...power, bulwarked: {} };
  const blocked = new Set<number>();

  const realMoves = getLegalPowerMoves(state, power, flip);
  const openMoves = getLegalPowerMoves(state, unbulwarked, flip);
  for (const om of openMoves) {
    // Charge's sweep is only a live threat if the mover could actually
    // afford AND use it this turn — otherwise the sweep numbers are
    // precomputed-but-unusable, and Bulwark isn't "blocking" anything real.
    const canCharge = power.charges[mover] >= 1 && om.chargeAvailable;
    const openCaptures = [...om.captures, ...om.bonusCaptures, ...(canCharge ? om.chargeSweepCaptures : [])];
    if (openCaptures.length === 0) continue;
    const rm = realMoves.find((m) => m.tokenId === om.tokenId && m.to === om.to);
    const realCaptures = rm
      ? [...rm.captures, ...rm.bonusCaptures, ...(canCharge ? rm.chargeSweepCaptures : [])]
      : [];
    for (const id of openCaptures) {
      if (power.bulwarked[id] !== undefined && !realCaptures.includes(id)) blocked.add(id);
    }
  }

  if (power.classes[mover] === "mage" && power.ultimateReady[mover]) {
    for (const id of getBlinkStrikeTargets(state, unbulwarked, mover)) {
      if (power.bulwarked[id] !== undefined) blocked.add(id);
    }
  }
  if (power.classes[mover] === "warrior" && power.ultimateReady[mover]) {
    for (const id of getWarpathTargets(state, unbulwarked, mover)) {
      if (power.bulwarked[id] !== undefined) blocked.add(id);
    }
  }
  if (power.classes[mover] === "archer" && power.charges[mover] >= 1) {
    const realPush = getPushTargets(state, power, mover);
    for (const id of getPushTargets(state, unbulwarked, mover)) {
      if (power.bulwarked[id] !== undefined && !realPush.includes(id)) blocked.add(id);
    }
  }
  // Charged Shot: same shape as the Push check above (a send-home threat
  // gated on affordability), just at CHARGE_CAP instead of >= 1, and using
  // getChargedShotTargets/its own collision math instead of Push's.
  if (power.classes[mover] === "archer" && power.charges[mover] === CHARGE_CAP) {
    const realChargedShot = getChargedShotTargets(state, power, mover);
    for (const id of getChargedShotTargets(state, unbulwarked, mover)) {
      if (power.bulwarked[id] !== undefined && !realChargedShot.includes(id)) blocked.add(id);
    }
  }

  return [...blocked];
}

/** Clears Bulwark on every token id that just did its job — see
 *  getBulwarkBlockedIds. No-op (same reference back) if nothing blocked. */
export function consumeBulwarkBlocks(power: PowerState, blockedIds: number[]): PowerState {
  if (blockedIds.length === 0) return power;
  const bulwarked = { ...power.bulwarked };
  for (const id of blockedIds) delete bulwarked[id];
  return { ...power, bulwarked };
}

/** Bulwark bookkeeping for the START of a brand-new turn (a fresh flip
 *  dealt to state.currentPlayer, NOT a Re-flip): ticks the CURRENT mover's
 *  own Bulwark countdowns, then consumes any of the opponent's Bulwarks
 *  this exact flip's moves reveal as blocked. Returns the blocked ids too
 *  (empty if none) so callers can announce a block, same idea as
 *  lastRainOfArrows/lastUltimate. Call this once, right after computing
 *  this turn's real move/target lists, from both referee.ts and api/ws.ts
 *  so the two servers can't drift on Bulwark's lifecycle. */
export function tickBulwarkForNewTurn(
  state: GameState,
  power: PowerState,
  flip: number,
): { power: PowerState; blockedIds: number[] } {
  const ticked = tickBulwarkExpiry(state, power, state.currentPlayer);
  const blocked = getBulwarkBlockedIds(state, ticked, flip);
  return { power: blocked.length > 0 ? consumeBulwarkBlocks(ticked, blocked) : ticked, blockedIds: blocked };
}

/** Bulwark bookkeeping for a Re-flip's replacement roll — same turn, no
 *  expiry tick (that already ran once when the turn started), but the new
 *  flip can reveal a fresh Bulwark block that the original flip didn't. */
export function tickBulwarkForReflip(
  state: GameState,
  power: PowerState,
  flip: number,
): { power: PowerState; blockedIds: number[] } {
  const blocked = getBulwarkBlockedIds(state, power, flip);
  return { power: blocked.length > 0 ? consumeBulwarkBlocks(power, blocked) : power, blockedIds: blocked };
}
