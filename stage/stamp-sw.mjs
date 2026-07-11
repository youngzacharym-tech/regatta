// Stamp the service worker cache name with a unique build id, so each deploy
// activates a fresh cache and deletes the previous one (see public/sw.js).
// Runs as part of `npm run build` after vite writes dist/.
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "dist", "sw.js");
const stamp = Date.now().toString(36);
const src = readFileSync(dist, "utf8");
if (!src.includes("__BUILD__")) {
  throw new Error("sw.js has no __BUILD__ placeholder — cache stamping broken");
}
writeFileSync(dist, src.replaceAll("__BUILD__", stamp));
console.log(`sw.js cache stamped: regatta-${stamp}`);
