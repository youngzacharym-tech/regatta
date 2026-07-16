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
//     arrow constructs; mage icons share circle/rune geometry. Silhouettes
//     stay distinct at size (plain shield / double-rim / shield+burst).
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
  | "bulwarkBlock";

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
};
