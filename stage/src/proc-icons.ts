// ============================================================================
// proc-icons.ts — one ornamental inline-SVG icon per ability proc, rendered
// beneath the proc banner text (see index.html's #proc column + main.ts's
// displayProc). Design rules, so the set reads as one family at 56-76px:
//
//   - 48×48 grid, two stroke weights only (3 primary / 1.75 detail).
//   - Subject strokes ride `currentColor`, so the banner's per-class
//     --proc-color cascade tints every icon for free — no per-class art.
//   - Main closed shape gets a 15% currentColor fill (pure wireframe sinks
//     into the dark tavern felt).
//   - Gold accents are FIXED at the frame gold (var(--gold-text)) for every
//     class — gold is the frame language, class color carries the subject.
//   - Cinzel echo: small rotated-square diamond finials terminate key
//     strokes (the font's diamond tittles).
//   - Warrior icons share one heater-shield base path; archer icons share
//     arrow constructs; mage icons share circle/rune geometry; necromancer
//     icons share grave geometry (one headstone path, ground lines, gold
//     soul-motes). Silhouettes stay distinct at size (plain shield /
//     double-rim / shield+burst; plain stone / crowned stone / open pit).
//
// These strings are static trusted constants — safe for innerHTML, and they
// must NEVER interpolate server-derived text.
// ============================================================================

export type ProcIconId =
  | "push"
  | "chargedShot"
  | "snipe"
  | "rainOfArrows"
  | "reflip"
  | "wardBlock"
  | "wardBreaker"
  | "blinkStrike"
  | "warpath"
  | "charge"
  | "bulwark"
  | "bulwarkReinforced"
  | "bulwarkBlock"
  | "revive"
  | "corpseExplosion"
  | "thrallExpired"
  | "corpseDenied"
  | "exhume"
  | "soulHarvest"
  | "bless"
  | "heal"
  | "benediction"
  | "sanctifiedGround"
  | "wound"
  | "larceny"
  | "pickpocket"
  | "vanish"
  | "grandHeist";

// Fixed frame gold — matches the plate/frame trim, constant across classes.
const GOLD = "var(--gold-text, #e8c87e)";

// Shared attribute shorthands (two weights only, per the family rule).
const MAIN = `stroke="currentColor" stroke-width="3"`;
const DETAIL = `stroke="currentColor" stroke-width="1.75"`;
const GOLD_DETAIL = `stroke="${GOLD}" stroke-width="1.75"`;
const BODY = `fill="currentColor" fill-opacity="0.15"`;

const wrap = (inner: string): string =>
  `<svg viewBox="0 0 48 48" fill="none" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

/** Cinzel-style diamond finial: a small rotated square capping a stroke. */
const diamond = (x: number, y: number, r = 2.2, fill = "currentColor"): string =>
  `<path d="M${x} ${y - r} L${x + r} ${y} L${x} ${y + r} L${x - r} ${y} Z" fill="${fill}"/>`;

// Warrior family: one heater shield, cusped chief, drawn once and reused so
// Bulwark / Reinforced / Blocked! stay siblings instead of three shields.
const SHIELD_PATH = "M13 13 Q24 16.5 35 13 C35 24 33 33 24 41 C15 33 13 24 13 13 Z";
const SHIELD = `<path d="${SHIELD_PATH}" ${MAIN} ${BODY}/>`;

// Cleric family: one floating halo ring over its subject, reused so Bless /
// Heal / Benediction / the break stay siblings (the warrior shield rule) —
// the halo whole while the light holds, broken when it doesn't.
const HALO = (cx: number, cy: number, rx = 9): string =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${rx * 0.34}" ${MAIN}/>`;

// Necromancer family: one rounded headstone on a ground line, reused so
// Raise Dead / Dark Resurrection stay siblings (the warrior shield rule).
const STONE_PATH = "M15 40 L15 20 Q15 11 24 11 Q33 11 33 20 L33 40 Z";
const STONE = `<path d="${STONE_PATH}" ${MAIN} ${BODY}/>`;
const GROUND = `<path d="M6 40 L42 40" ${GOLD_DETAIL}/>` + `<path d="M42 ${40 - 1.8} L${42 + 1.8} 40 L42 ${40 + 1.8} L${42 - 1.8} 40 Z" fill="${GOLD}"/>`;

// Rogue family: one dagger held low, reused so Larceny / Pickpocket /
// Vanish / Grand Heist stay siblings (the warrior shield rule) — a coin
// motif carries the theft half of the identity across the same four icons.
const DAGGER =
  `<path d="M24 6 L28.5 23 L24 28 L19.5 23 Z" ${MAIN} ${BODY}/>` +
  `<path d="M15 28 L33 28" ${MAIN}/>` +
  `<path d="M21.5 28 L21.5 38 L26.5 38 L26.5 28" ${MAIN}/>` +
  diamond(24, 40.5);
const COIN = (cx: number, cy: number, r = 6): string =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" ${MAIN} ${BODY}/>` + `<circle cx="${cx}" cy="${cy}" r="${r * 0.45}" ${DETAIL}/>`;

export const PROC_ICONS: Record<ProcIconId, string> = {
  // Archer active: a token shoved sideways by force — a solid wedge of it
  // slamming into the struck rim.
  push: wrap(
    `<circle cx="32" cy="24" r="9" ${MAIN} ${BODY}/>` +
      `<path d="M7 15.5 L18 24 L7 32.5 Z" ${MAIN} ${BODY}/>` +
      `<path d="M2.5 19.5 L6 24 L2.5 28.5" ${DETAIL}/>` +
      // Impact arc skimming the token's struck rim.
      `<path d="M23.5 15.5 A12 12 0 0 0 23.5 32.5" ${GOLD_DETAIL}/>` +
      diamond(23.5, 15.5, 1.8, GOLD),
  ),

  // Archer 2-charge: a heavy arrow at full draw, energy rings round the shaft.
  chargedShot: wrap(
    `<path d="M4 24 L34 24" ${MAIN}/>` +
      `<path d="M34 16.5 L45 24 L34 31.5 L37.5 24 Z" ${MAIN} ${BODY}/>` +
      `<path d="M11 24 L6 18.5" ${DETAIL}/>` +
      `<path d="M11 24 L6 29.5" ${DETAIL}/>` +
      diamond(4, 24) +
      // The banked power: two energy rings threaded round mid-shaft.
      `<ellipse cx="20" cy="24" rx="3.2" ry="9" ${GOLD_DETAIL}/>` +
      `<ellipse cx="27" cy="24" rx="2.6" ry="7" ${GOLD_DETAIL}/>`,
  ),

  // Archer passive: the marksman's reticle, arrow driven to its center.
  snipe: wrap(
    `<circle cx="22" cy="26" r="13" ${MAIN} ${BODY}/>` +
      `<path d="M22 7.5 L22 11.5" ${GOLD_DETAIL}/>` +
      `<path d="M22 40.5 L22 44.5" ${GOLD_DETAIL}/>` +
      `<path d="M3.5 26 L7.5 26" ${GOLD_DETAIL}/>` +
      `<path d="M36.5 26 L40.5 26" ${GOLD_DETAIL}/>` +
      `<path d="M42 6 L27 21" ${MAIN}/>` +
      `<path d="M22 26 L24.5 18.6 L29.4 23.5 Z" fill="currentColor"/>` +
      diamond(42, 6) +
      `<circle cx="22" cy="26" r="1.8" fill="${GOLD}"/>`,
  ),

  // Archer ultimate: the falling volley — three arrows fanned in descent.
  rainOfArrows: wrap(
    `<path d="M5 14 A34 34 0 0 1 41 5" ${GOLD_DETAIL}/>` +
      `<path d="M21 10 L33 36" ${MAIN}/>` +
      `<path d="M33.2 29.3 L33 36 L27.8 31.8" ${MAIN}/>` +
      `<path d="M9 14 L18 33.5" ${MAIN}/>` +
      `<path d="M18.2 26.8 L18 33.5 L12.8 29.3" ${MAIN}/>` +
      `<path d="M33 8 L41 25.5" ${MAIN}/>` +
      `<path d="M41.2 18.8 L41 25.5 L35.8 21.3" ${MAIN}/>` +
      // Gold cores inside each arrowhead.
      `<path d="M30.5 30.7 L33 36" ${GOLD_DETAIL}/>` +
      `<path d="M15.5 28.2 L18 33.5" ${GOLD_DETAIL}/>` +
      `<path d="M38.5 20.2 L41 25.5" ${GOLD_DETAIL}/>`,
  ),

  // Mage active: two mismatched dice mid-tumble — Kasen's requested "you get
  // to roll again" image every gamer already knows, though Regatta flips
  // coins. (Replaces the old ⚁⚄ glyph pair.)
  reflip: wrap(
    `<g transform="rotate(-14 17 15)">` +
      `<rect x="11" y="9" width="12" height="12" rx="2.5" ${MAIN} ${BODY}/>` +
      `<circle cx="14" cy="12" r="1.6" fill="${GOLD}"/>` +
      `<circle cx="20" cy="18" r="1.6" fill="${GOLD}"/>` +
      `</g>` +
      `<g transform="rotate(18 31 31)">` +
      `<rect x="25" y="25" width="12" height="12" rx="2.5" ${MAIN} ${BODY}/>` +
      `<circle cx="28" cy="28" r="1.4" fill="${GOLD}"/>` +
      `<circle cx="34" cy="28" r="1.4" fill="${GOLD}"/>` +
      `<circle cx="31" cy="31" r="1.4" fill="${GOLD}"/>` +
      `<circle cx="28" cy="34" r="1.4" fill="${GOLD}"/>` +
      `<circle cx="34" cy="34" r="1.4" fill="${GOLD}"/>` +
      `</g>` +
      // Tumble swirl beneath the throw.
      `<path d="M7 41 C13 45.5 22 46 28.5 42.5" ${DETAIL}/>`,
  ),

  // Mage passive (reserved: no server event fires this yet — authored so the
  // set is complete when a Ward-save signal lands).
  wardBlock: wrap(
    `<circle cx="25" cy="26" r="13" ${MAIN} ${BODY}/>` +
      `<path d="M25 17 L27.5 23.5 L34 26 L27.5 28.5 L25 35 L22.5 28.5 L16 26 L22.5 23.5 Z" ${DETAIL}/>` +
      // Deflection spark at the 10-o'clock rim: the blow turned away.
      `<path d="M13.5 14 L10 10" ${GOLD_DETAIL}/>` +
      `<path d="M17 11.5 L15 6.5" ${GOLD_DETAIL}/>` +
      `<path d="M11 17.5 L6 15.5" ${GOLD_DETAIL}/>`,
  ),

  // Warrior passive: the ward circle broken — a cleave through the gap.
  wardBreaker: wrap(
    `<path d="M26.4 14.4 A13 13 0 1 0 35.6 23.6" ${MAIN} ${BODY}/>` +
      `<path d="M40 7 L18 33.5" ${MAIN}/>` +
      diamond(40.5, 6.5) +
      // Ward fragments flung from the gap.
      `<path d="M33 9 L36 5" ${GOLD_DETAIL}/>` +
      `<path d="M38.5 13.5 L43 11.5" ${GOLD_DETAIL}/>`,
  ),

  // Mage ultimate: the teleport-strike flash, echo rings trailing the jump.
  blinkStrike: wrap(
    `<path d="M30 7 L33 15 L41 18 L33 21 L30 29 L27 21 L19 18 L27 15 Z" ${MAIN} ${BODY}/>` +
      `<circle cx="14" cy="32" r="4" ${DETAIL}/>` +
      `<circle cx="7" cy="39" r="2.5" ${GOLD_DETAIL}/>` +
      `<circle cx="30" cy="18" r="1.8" fill="${GOLD}"/>`,
  ),

  // Warrior ultimate: the rampaging blade, swept victims in its wake.
  warpath: wrap(
    `<path d="M39 9 L13 35 L18 40 Z" ${MAIN} ${BODY}/>` +
      `<path d="M11.5 33.5 L19.5 41.5" ${MAIN}/>` +
      `<path d="M13 40 L8.5 44.5" ${MAIN}/>` +
      diamond(8, 45, 2) +
      // Trailing sweep arcs behind the swing.
      `<path d="M20 45 A32 32 0 0 0 45 20" ${GOLD_DETAIL}/>` +
      `<path d="M29 46 A30 30 0 0 0 46 29" ${GOLD_DETAIL}/>` +
      // The swept: two slash ticks crossed on the swing path.
      `<path d="M26 26 L30 30" ${DETAIL}/>` +
      `<path d="M33 19 L37 23" ${DETAIL}/>`,
  ),

  // Warrior active: the family heater tipped into a full-speed bash, a token
  // tumbling off its leading corner.
  charge: wrap(
    `<g transform="rotate(18 24 26)"><path d="${SHIELD_PATH}" ${MAIN} ${BODY}/></g>` +
      `<circle cx="41.5" cy="11" r="3.5" ${DETAIL}/>` +
      // Speed lines behind the bash.
      `<path d="M3 18 L13 18" ${GOLD_DETAIL}/>` +
      `<path d="M1.5 25 L11.5 25" ${GOLD_DETAIL}/>` +
      `<path d="M4 32 L14 32" ${GOLD_DETAIL}/>`,
  ),

  // Warrior 1-charge: the planted heater shield, boss and band on the chief.
  bulwark: wrap(
    SHIELD +
      `<path d="M14.5 19.5 L33.5 19.5" ${GOLD_DETAIL}/>` +
      `<circle cx="24" cy="27" r="2.6" fill="${GOLD}"/>` +
      diamond(24, 42.5),
  ),

  // Warrior full-bank: the same shield doubled — second rim, riveted band.
  bulwarkReinforced: wrap(
    SHIELD +
      `<path d="M16.5 16.5 Q24 18.9 31.5 16.5 C31.5 24 30 30.5 24 36.5 C18 30.5 16.5 24 16.5 16.5 Z" ${GOLD_DETAIL}/>` +
      `<path d="M14.5 19.5 L33.5 19.5" ${DETAIL}/>` +
      `<circle cx="19" cy="19.5" r="1.3" fill="${GOLD}"/>` +
      `<circle cx="24" cy="19.5" r="1.3" fill="${GOLD}"/>` +
      `<circle cx="29" cy="19.5" r="1.3" fill="${GOLD}"/>` +
      diamond(24, 27, 2.8, GOLD) +
      diamond(24, 42.5),
  ),

  // Blocked!: the shield takes the hit and holds — burst at the rim, a
  // crack that stops. Tinted by the DEFENDER's class (the shield's owner).
  bulwarkBlock: wrap(
    SHIELD +
      // Six-ray impact starburst at the upper-left rim.
      `<path d="M13.5 11.5 L13.5 7" ${GOLD_DETAIL}/>` +
      `<path d="M10 12.5 L6.8 9.2" ${GOLD_DETAIL}/>` +
      `<path d="M8.5 16 L4 16" ${GOLD_DETAIL}/>` +
      `<path d="M10 20 L6.5 23" ${GOLD_DETAIL}/>` +
      `<path d="M17 11.5 L19.5 8" ${GOLD_DETAIL}/>` +
      `<path d="M7 12.5 L3.5 12" ${GOLD_DETAIL}/>` +
      // The crack that didn't get through.
      `<path d="M15 17.5 L19 21 L17.5 24 L21.5 27.5" ${DETAIL}/>`,
  ),

  // Necromancer full-bank Revive: the grave cracked open, the claimed soul
  // erupting off its crown as a gold star — the thrall rises.
  revive: wrap(
    STONE +
      GROUND +
      // The grave gives — a crack running up the face.
      `<path d="M22 40 L24.5 32 L21 26" ${DETAIL}/>` +
      // The soul erupting: four-point gold star off the stone's crown.
      `<path d="M24 2 L26 6.8 L31 9 L26 11.2 L24 16 L22 11.2 L17 9 L22 6.8 Z" fill="${GOLD}"/>` +
      `<circle cx="34" cy="15" r="1.3" fill="${GOLD}"/>` +
      `<circle cx="13.5" cy="15" r="1.1" fill="${GOLD}"/>`,
  ),

  // Corpse Explosion: the grave blown open — the stone split in two, debris
  // and soul-motes thrown wide. Distinct from revive's clean eruption star:
  // this one is violence, not a rising.
  corpseExplosion: wrap(
    GROUND +
      // The stone, split and leaning apart.
      `<path d="M14 44 L14 24 C14 18 18 14 22 14 L22 44 Z" ${MAIN} ${BODY}/>` +
      `<path d="M27 44 L27 14 C31 14 35 18 35 24 L35 44 Z" ${MAIN} ${BODY}/>` +
      // Debris thrown from the breach.
      `<path d="M24.5 10 L22 4" ${DETAIL}/>` +
      `<path d="M28 9 L32 3" ${DETAIL}/>` +
      `<path d="M20 10 L15 5.5" ${DETAIL}/>` +
      // Soul-motes scattering wide, not rising.
      `<circle cx="8" cy="16" r="1.5" fill="${GOLD}"/>` +
      `<circle cx="41" cy="13" r="1.6" fill="${GOLD}"/>` +
      `<circle cx="44" cy="24" r="1.1" fill="${GOLD}"/>`,
  ),

  // Thrall's crumble: the headstone with a descending chevron — the
  // borrowed body settling back into the grave, its last soul-mote fading.
  thrallExpired: wrap(
    STONE +
      GROUND +
      // Engraved descent chevron on the stone face.
      `<path d="M24 22 L24 34" ${DETAIL}/>` +
      `<path d="M19.5 29.5 L24 34 L28.5 29.5" ${DETAIL}/>` +
      // The spent soul settling off the stone's shoulder.
      `<circle cx="38" cy="14.5" r="1.4" fill="${GOLD}"/>`,
  ),

  // Soul reclaimed: the marked headstone barred — the victim re-entered
  // the body and the claim is broken.
  corpseDenied: wrap(
    STONE +
      GROUND +
      // The claim, crossed out on the stone face.
      `<path d="M18.5 22 L29.5 33" ${DETAIL}/>` +
      `<path d="M29.5 22 L18.5 33" ${DETAIL}/>` +
      // The soul slipping away sideways, out of the necromancer's reach.
      `<circle cx="40" cy="26" r="1.5" fill="${GOLD}"/>` +
      `<circle cx="45" cy="23" r="1.1" fill="${GOLD}"/>`,
  ),

  // Necromancer ultimate: the open pit, an escaped token dragged back down
  // into it — the pull line arcs from the runaway straight into the grave.
  exhume: wrap(
    `<path d="M4 34 L15 34" ${MAIN}/>` +
      `<path d="M33 34 L44 34" ${MAIN}/>` +
      `<path d="M15 34 L15 44 L33 44 L33 34" ${MAIN}/>` +
      `<path d="M15 34 L33 34 L33 44 L15 44 Z" ${BODY} stroke="none"/>` +
      // The escapee, caught at the top of its run.
      `<circle cx="36" cy="10" r="5" ${MAIN} ${BODY}/>` +
      // The drag: down off the token, hauled into the pit mouth.
      `<path d="M33 14 C25.5 19.5 22.5 25 24 31.5" ${MAIN}/>` +
      `<path d="M20.6 27.8 L24 32.5 L27.4 27.6" ${MAIN}/>` +
      diamond(33, 14, 1.8, GOLD) +
      // Its interrupted flight, still hanging in the air behind it.
      `<path d="M40.5 5 L44.5 1.5" ${GOLD_DETAIL}/>` +
      `<path d="M42.5 12 L47 10.5" ${GOLD_DETAIL}/>`,
  ),

  // Cleric active: the halo settling onto a stone — the second life granted.
  bless: wrap(
    HALO(24, 12) +
      // Light descending from the halo onto the stone below.
      `<path d="M17 17 L19.5 22.5" ${GOLD_DETAIL}/>` +
      `<path d="M24 16.5 L24 22.5" ${GOLD_DETAIL}/>` +
      `<path d="M31 17 L28.5 22.5" ${GOLD_DETAIL}/>` +
      `<circle cx="24" cy="33" r="9" ${MAIN} ${BODY}/>` +
      `<circle cx="24" cy="33" r="2" fill="${GOLD}"/>`,
  ),

  // Cleric active: the chalice poured over the scar — the blessing rekindled.
  heal: wrap(
    `<path d="M14 10 L34 10 C34 19 30 24 24 24 C18 24 14 19 14 10 Z" ${MAIN} ${BODY}/>` +
      `<path d="M24 24 L24 33" ${MAIN}/>` +
      `<path d="M16.5 38 C16.5 35 20 33 24 33 C28 33 31.5 35 31.5 38 Z" ${MAIN} ${BODY}/>` +
      diamond(24, 41.5) +
      // The light welling over the rim.
      `<path d="M24 2 L25.6 5.8 L29.5 7 L25.6 8.2 L24 12 L22.4 8.2 L18.5 7 L22.4 5.8 Z" fill="${GOLD}"/>` +
      `<circle cx="35" cy="14" r="1.3" fill="${GOLD}"/>` +
      `<circle cx="12.5" cy="15" r="1.1" fill="${GOLD}"/>`,
  ),

  // Cleric ultimate: one wide dome of light over the whole army at once.
  benediction: wrap(
    `<path d="M6 30 A19 19 0 0 1 42 30" ${MAIN}/>` +
      diamond(6, 30, 2) +
      diamond(42, 30, 2) +
      // The army beneath the dome.
      `<circle cx="14" cy="37" r="4.5" ${DETAIL} ${BODY}/>` +
      `<circle cx="24" cy="39" r="4.5" ${DETAIL} ${BODY}/>` +
      `<circle cx="34" cy="37" r="4.5" ${DETAIL} ${BODY}/>` +
      // Grace falling through the dome.
      `<circle cx="24" cy="17" r="1.6" fill="${GOLD}"/>` +
      `<circle cx="15" cy="21" r="1.2" fill="${GOLD}"/>` +
      `<circle cx="33" cy="21" r="1.2" fill="${GOLD}"/>`,
  ),

  // Cleric passive: the shield tile as holy ground — the halo hovering over
  // the tile's diamond, mending light rising from it.
  sanctifiedGround: wrap(
    `<path d="M24 22 L35 31 L24 40 L13 31 Z" ${MAIN} ${BODY}/>` +
      HALO(24, 12) +
      `<path d="M6 40 L42 40" ${GOLD_DETAIL}/>` +
      // Mending light rising off the sanctified tile.
      `<circle cx="16" cy="20" r="1.2" fill="${GOLD}"/>` +
      `<circle cx="32" cy="20" r="1.2" fill="${GOLD}"/>` +
      `<circle cx="24" cy="31" r="1.8" fill="${GOLD}"/>`,
  ),

  // The blessing BREAKS: the family halo split over the surviving stone —
  // a shard falling, the stone still standing (that's the whole point).
  wound: wrap(
    `<path d="M15.2 10.5 A9 3.06 0 0 1 30 9.5" ${MAIN}/>` +
      `<path d="M32.8 13.5 A9 3.06 0 0 1 18 14.8" ${MAIN}/>` +
      // The falling shard.
      diamond(35, 20, 2.2, GOLD) +
      `<path d="M33.5 24 L31.5 27.5" ${GOLD_DETAIL}/>` +
      // The stone beneath: struck, scarred, alive.
      `<circle cx="24" cy="33" r="9" ${MAIN} ${BODY}/>` +
      `<path d="M20 27.5 L23 31 L21.5 34 L25 37.5" ${DETAIL}/>`,
  ),

  // Necromancer passive: the reaper's scythe, souls gathered under the
  // blade's sweep — the one silhouette that can never read as a moon.
  soulHarvest: wrap(
    // Snath: the long diagonal staff.
    `<path d="M11 45 L30 8.5" ${MAIN}/>` +
      diamond(10.5, 45.8, 2) +
      // Blade hooked off the snath's head, sweeping right and biting down.
      `<path d="M28.5 9.5 C36 5.5 43.5 8.5 46.5 15 C41 13 35.5 13.8 31 17.5 C29.5 15 28.5 12 28.5 9.5 Z" ${MAIN} ${BODY}/>` +
      // Souls drawn up into the harvest sweep.
      `<circle cx="37" cy="24" r="1.7" fill="${GOLD}"/>` +
      `<circle cx="41" cy="30" r="1.4" fill="${GOLD}"/>` +
      `<circle cx="44" cy="36" r="1.1" fill="${GOLD}"/>`,
  ),

  // Rogue passive: the class identity glyph — dagger low, a coin held
  // just behind it, quiet until spent.
  larceny: wrap(
    DAGGER + COIN(35, 14, 6) + `<circle cx="30" cy="10" r="4" ${DETAIL} ${BODY}/>`,
  ),

  // Rogue active (1 mana): the coin lifted clean off an unseen pocket,
  // rising on its own trail.
  pickpocket: wrap(
    DAGGER +
      COIN(33, 13, 6.5) +
      `<path d="M33 21 L33 30" ${GOLD_DETAIL}/>` +
      `<path d="M29 26 L33 30 L37 26" ${GOLD_DETAIL}/>`,
  ),

  // Rogue active (1 mana): the dagger dissolving into shadow — a soft
  // trail of shrinking, dimming motes drifting away, instead of the old
  // Backstab's aggressive strike-burst this icon slot used to carry.
  vanish: wrap(
    DAGGER +
      `<circle cx="10" cy="14" r="1.6" fill="${GOLD}" fill-opacity="0.85"/>` +
      `<circle cx="7" cy="20" r="1.2" fill="${GOLD}" fill-opacity="0.55"/>` +
      `<circle cx="6" cy="27" r="0.8" fill="${GOLD}" fill-opacity="0.3"/>`,
  ),

  // Rogue ultimate: the dagger at the center of the whole haul — every
  // coin in reach, taken at once.
  grandHeist: wrap(
    DAGGER +
      COIN(9, 12, 5) +
      COIN(39, 10, 5.5) +
      COIN(37, 25, 4) +
      COIN(7, 27, 4) +
      `<path d="M19 22 A24 24 0 0 0 4 8" ${GOLD_DETAIL}/>` +
      `<path d="M29 22 A24 24 0 0 1 44 8" ${GOLD_DETAIL}/>`,
  ),
};
