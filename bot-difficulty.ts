// ============================================================================
// bot-difficulty.ts — the CPU difficulty vocabulary, shared by both bots
// (bot.ts / master-killer-bot.ts), the room engine, and the client menu.
//
// A SEPARATE file on purpose: master-killer-bot.ts deliberately does not
// import bot.ts (classic's bot stays untouched by MK work), and protocol.ts/
// room-engine.ts need the type without pulling any picker code into the
// bundle. Wire values are the neutral easy/standard/hard — display names
// (Tipsy / Barkeep / Champion) are presentation only and live in the client,
// so a rename never touches the protocol.
// ============================================================================

export type BotDifficulty = "easy" | "standard" | "hard";

export const BOT_DIFFICULTIES: BotDifficulty[] = ["easy", "standard", "hard"];

/** P(flip = k) · 16 for k = 0..4 — four fair coins, C(4,k). The whole reason
 *  the hard tier can afford exact expectimax: the flip distribution is fully
 *  enumerable (five outcomes), so "average over what the coins might do" is
 *  a 5-term sum, not a rollout. */
export const FLIP_WEIGHTS = [1, 4, 6, 4, 1] as const;
/** Denominator for FLIP_WEIGHTS (2^4 outcomes of four fair coins). */
export const FLIP_WEIGHT_TOTAL = 16;

/** Easy tier: probability it plays the standard heuristic instead of a
 *  uniform-random pick. Lives here (not bot.ts) because both bots share the
 *  one knob and master-killer-bot.ts deliberately never imports bot.ts.
 *  0.35 keeps easy visibly sloppy — roughly two of three decisions are
 *  coin-toss picks — while still occasionally punishing a blunder, so a new
 *  player learns the threats exist without being farmed. Raise toward 1 and
 *  easy converges on standard; batch-bot-difficulty.ts asserts the gap
 *  stays real (standard-vs-easy >= 55% in both rulesets). */
export const EASY_HEED_P = 0.35;

/** Whitelist anything off the wire down to a real tier. Defaults to
 *  "standard" — the pre-difficulty behavior — so old clients, absent fields,
 *  and garbage all land exactly where live rooms already were. */
export function normalizeDifficulty(d: unknown): BotDifficulty {
  return d === "easy" || d === "hard" ? d : "standard";
}
