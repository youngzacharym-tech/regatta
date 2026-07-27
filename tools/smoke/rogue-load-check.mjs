import * as mk from "../../master-killer.ts";
import * as re from "../../room-engine.ts";
import * as bot from "../../master-killer-bot.ts";

console.log(
  "master-killer.ts OK. Rogue exports:",
  Object.keys(mk).filter((k) => /backstab|pickpocket|heist|rogue/i.test(k)),
);
console.log("room-engine.ts OK. MK_CLASSES:", re.MK_CLASSES);
console.log("master-killer-bot.ts OK. pickBotPowerAction is a function:", typeof bot.pickBotPowerAction === "function");
