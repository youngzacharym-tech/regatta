// ============================================================================
// faceoff.ts — the class pick as a face-off (Master Killer 2D's, brought to
// the table): you on the left, them on the right, VS between, each champion's
// painted medallion on a turning rune seal in their colour, and a roster of
// heraldic shields under each side.
//
// CPU rooms choose both sides (the CPU's class rides pickClass as `foe`);
// online rooms choose only yours, and the opponent stays sealed until both
// have locked in. The tutorial sets both (`fixed`): the rosters stand
// greyed and only Lock In is live. When both classes settle, the reveal
// plays and the screen lifts off the flip-off underneath.
//
// It owns #classpick's contents and nothing else: main.ts feeds it the
// classPick broadcasts (sync), the settled classes (settle) and resets (hide).
// ============================================================================

import "./faceoff.css";

export interface FaceoffKitSlot {
  /** Trusted static SVG markup (proc-icons.ts). */
  icon: string;
  name: string;
  tip: string;
  passive?: boolean;
  ult?: boolean;
}
export interface FaceoffClass {
  id: string;
  name: string;
  /** CSS colour, the class's own (DOCK_RING_TINTS). */
  color: string;
  line: string;
  kit: FaceoffKitSlot[];
}
export interface FaceoffSync {
  mode: "cpu" | "online";
  /** Who sits on the right: "The CPU · Barkeep", "Opponent". */
  foeLabel: string;
  /** My class once the server has it (a reload mid-pick lands locked). */
  mine: string | null;
  /** Online: the opponent has locked in (their class stays hidden). */
  theirsLocked: boolean;
  /** Both sides decided for the player (the tutorial): rosters disabled,
   *  `note` in the status line, Lock In still the player's own tap. */
  fixed?: { you: string; foe: string; note: string } | null;
}
export interface Faceoff {
  sync(s: FaceoffSync): void;
  /** Both classes are settled: play the reveal, then lift the screen. */
  settle(mine: string | null, theirs: string | null): void;
  hide(): void;
  readonly open: boolean;
}

const RANDOM = "random";
const REVEAL_HOLD_MS = 1900;
const FADE_MS = 450;
const store = {
  get(k: string, d: string): string {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  },
};

// Elder-futhark strokes on a 10×16 cell, walked round the seal.
const RUNES = [
  "M3 0V16M3 3L9 0M3 8L9 5",
  "M2 16V0L8 5V16",
  "M2 0V16M2 4L8 8L2 12",
  "M3 0V16M3 0L9 4M3 5L9 9",
  "M2 16V0L8 4L2 8L8 16",
  "M8 2L2 8L8 14",
  "M5 0V16M5 6L1 1M5 6L9 1",
  "M5 0V16M5 0L1 5M5 0L9 5",
  "M1 16L9 6L5 1L1 6L9 16",
  "M1 2V14L9 2V14L1 2",
  "M5 0V16M1 4L9 12",
  "M2 0V16M8 0V16M2 5L8 11",
];
function sealSVG(): string {
  const n = 24;
  let marks = "";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 360;
    marks +=
      `<g transform="rotate(${a} 100 100) translate(95 7)"><path d="${RUNES[i % RUNES.length]}" transform="scale(.62)"/></g>` +
      `<g transform="rotate(${a + 7.5} 100 100)"><path d="M100 9.5v3"/></g>`;
  }
  return (
    `<svg viewBox="0 0 200 200" aria-hidden="true">` +
    `<circle cx="100" cy="100" r="97" class="r1"/><circle cx="100" cy="100" r="85.5" class="r2"/>` +
    `<g class="runes">${marks}</g></svg>`
  );
}
const SEAL = sealSVG();

export function createFaceoff(
  root: HTMLElement,
  classes: FaceoffClass[],
  cb: {
    lockIn(cls: string, foe: string | null): void;
    leave(): void;
    /** A side now shows this class (null: random or sealed); spin = a fresh pick. */
    figure?(side: "L" | "R", cls: string | null, color: string, spin: boolean): void;
    opened?(): void;
    closed?(): void;
  },
): Faceoff {
  const byId = new Map(classes.map((c) => [c.id, c]));
  const ids = classes.map((c) => c.id);
  const valid = (id: string) => id === RANDOM || byId.has(id);
  let selL = store.get("mk-faceoff-you", "warrior");
  let selR = store.get("mk-faceoff-foe", RANDOM);
  if (!valid(selL)) selL = "warrior";
  if (!valid(selR)) selR = RANDOM;

  let isOpen = false;
  let mode: FaceoffSync["mode"] = "cpu";
  let locked = false;
  let theirsLocked = false;
  let fixed: FaceoffSync["fixed"] = null;
  let revealing = false;
  let timers: number[] = [];
  let emberStop: (() => void) | null = null;
  let lastKey = "";

  // ---- markup -------------------------------------------------------------
  const crest = (id: string, side: "L" | "R", i: number) => {
    const c = byId.get(id);
    const name = c ? c.name : "Random";
    const face = c
      ? `<span class="fo-face" style="background-image:url(/avatars/${id}.webp)"></span>`
      : `<span class="fo-face fo-die">${DIE_SVG}</span>`;
    return (
      `<button class="fo-crest${c ? "" : " rand"}" type="button" data-cls="${id}" data-side="${side}"` +
      ` style="--i:${i};${c ? `--c:${c.color}` : ""}" aria-label="${name}" aria-pressed="false">` +
      `<span class="fo-shield">${face}</span><span class="fo-cn">${name}</span></button>`
    );
  };
  const roster = (side: "L" | "R") =>
    `<div class="fo-roster" data-side="${side}" role="group" aria-label="${side === "L" ? "Your class" : "Their class"}">` +
    [RANDOM, ...ids].map((id, i) => crest(id, side, i)).join("") +
    `</div>`;
  const sideHTML = (side: "L" | "R") =>
    `<section class="fo-side" data-side="${side}">` +
    `<div class="fo-who"></div>` +
    `<div class="fo-stage"><div class="fo-aura"></div><div class="fo-seal">${SEAL}</div>` +
    `<div class="fo-medal"><img alt="" draggable="false"><span class="fo-q"></span></div>` +
    `<div class="fo-disc"></div><div class="fo-stamp"></div></div>` +
    `<h2 class="fo-name"></h2><p class="fo-line"></p><div class="fo-kit"></div>` +
    `<div class="fo-pick">${roster(side)}<p class="fo-wait"></p></div>` +
    `</section>`;

  root.innerHTML =
    `<canvas class="fo-embers" aria-hidden="true"></canvas>` +
    `<div class="fo-in">` +
    `<header class="fo-head"><h1 class="fo-logo"><span>Master</span> <span>Killer</span></h1>` +
    `<p class="fo-sub">Choose your champion</p></header>` +
    `<div class="fo-vs">${sideHTML("L")}<div class="fo-mark" aria-hidden="true"><i></i><b>VS</b><i></i></div>${sideHTML("R")}</div>` +
    `<footer class="fo-foot"><button class="fo-go" type="button" data-go>Lock In</button>` +
    `<p class="fo-status" aria-live="polite"></p>` +
    `<div class="fo-keys" aria-hidden="true"><span><kbd>←→↑↓</kbd>choose</span><span><kbd>Enter</kbd>lock in</span>` +
    `<span class="fo-leave" data-leave><kbd>Esc</kbd>leave</span></div></footer>` +
    `</div>`;

  const sideEl = (s: "L" | "R") => root.querySelector<HTMLElement>(`.fo-side[data-side="${s}"]`)!;
  const goBtn = root.querySelector<HTMLButtonElement>("[data-go]")!;
  const statusEl = root.querySelector<HTMLElement>(".fo-status")!;

  // Preload the big medallions the first time the screen opens.
  let preloaded = false;
  const preload = () => {
    if (preloaded) return;
    preloaded = true;
    for (const id of ids) new Image().src = `/avatars/hero/${id}.webp`;
  };

  // ---- one side's stage: medallion, name, line, kit -----------------------
  /** What a side's stage shows: a class, the die (random), or sealed (hidden). */
  function paint(s: "L" | "R", id: string | "sealed", swap: boolean) {
    const el = sideEl(s);
    const c = id === "sealed" ? undefined : byId.get(id);
    const stage = el.querySelector<HTMLElement>(".fo-stage")!;
    const medal = el.querySelector<HTMLElement>(".fo-medal")!;
    const img = medal.querySelector("img")!;
    const q = el.querySelector<HTMLElement>(".fo-q")!;
    el.style.setProperty("--c", c ? c.color : "#c9a35c");
    root.style.setProperty(s === "L" ? "--cl" : "--cr", c ? c.color : "#7a5cff");
    el.classList.toggle("unknown", !c);
    if (c) {
      // the small portrait (the roster shields already loaded it) shows until
      // the sharp one is in
      medal.style.backgroundImage = `url(/avatars/${c.id}.webp)`;
      const src = `/avatars/hero/${c.id}.webp`;
      if (!img.src.endsWith(src)) img.src = src;
      q.innerHTML = "";
    } else {
      medal.style.backgroundImage = "";
      img.removeAttribute("src");
      q.innerHTML = id === "sealed" ? "?" : DIE_SVG;
    }
    el.querySelector(".fo-name")!.textContent = c ? c.name : id === "sealed" ? "Unrevealed" : "Random";
    el.querySelector(".fo-line")!.textContent = c
      ? c.line
      : id === "sealed"
        ? "Revealed when you both lock in."
        : "Any of the ten, chosen at the lock-in.";
    el.querySelector(".fo-kit")!.innerHTML = c
      ? c.kit
          .map(
            (k) =>
              `<span class="fo-mv${k.ult ? " ult" : ""}${k.passive ? " pas" : ""}" title="${escAttr(k.name + " — " + k.tip)}">` +
              `<i>${k.icon}</i>${k.name}</span>`,
          )
          .join("")
      : "";
    cb.figure?.(s, c ? c.id : null, c ? c.color : "#c9a35c", swap);
    if (swap) {
      for (const e of [stage, el.querySelector(".fo-name")!]) {
        e.classList.remove("swap");
        void (e as HTMLElement).offsetWidth;
        e.classList.add("swap");
      }
    }
  }
  const shown: Record<"L" | "R", string> = { L: "", R: "" };
  function show(s: "L" | "R", id: string, swap = true) {
    if (shown[s] === id) return;
    shown[s] = id;
    paint(s, id, swap);
  }
  function setPressed() {
    root.querySelectorAll<HTMLButtonElement>(".fo-crest").forEach((b) => {
      const sel = b.dataset.side === "L" ? selL : selR;
      b.setAttribute("aria-pressed", String(b.dataset.cls === sel));
    });
  }

  // ---- state → screen -------------------------------------------------------
  function render() {
    const L = sideEl("L"), R = sideEl("R");
    L.querySelector(".fo-who")!.textContent = "You";
    root.classList.toggle("online", mode === "online");
    root.classList.toggle("locked", locked);
    R.classList.toggle("ready", mode === "online" && theirsLocked);
    R.querySelector(".fo-wait")!.textContent = mode === "online" && !theirsLocked && !revealing ? "Choosing" : "";
    root.classList.toggle("fixed", !!fixed);
    root.querySelector(".fo-sub")!.textContent = fixed ? "Your first table" : "Choose your champion";
    root.querySelectorAll<HTMLButtonElement>(".fo-crest").forEach((b) => {
      b.disabled = locked || revealing || !!fixed || (b.dataset.side === "R" && mode === "online");
    });
    goBtn.disabled = locked || revealing;
    goBtn.textContent = locked ? "Locked In" : "Lock In";
    L.querySelector(".fo-stamp")!.textContent = locked ? "Locked in" : "";
    R.querySelector(".fo-stamp")!.textContent = mode === "online" && theirsLocked ? "Locked in" : "";
    statusEl.textContent = revealing
      ? ""
      : locked
        ? mode === "online"
          ? theirsLocked
            ? "Both locked in…"
            : "Waiting for your opponent to lock in…"
          : "To the table…"
        : fixed
          ? fixed.note
          : mode === "online"
            ? theirsLocked
              ? "Your opponent has chosen. Your move."
              : "Pick your champion. Neither of you sees the other's until both lock in."
            : "Pick your champion, and the CPU's.";
    // their side stays sealed until the reveal turns it face up
    if (mode === "online" && !revealing) show("R", "sealed", false);
  }

  function lockIn() {
    if (locked || revealing) return;
    const you = selL === RANDOM ? ids[Math.floor(Math.random() * ids.length)] : selL;
    const foe = mode === "cpu" ? (selR === RANDOM ? null : selR) : null;
    locked = true;
    show("L", you);
    root.classList.add("lockflash");
    timers.push(window.setTimeout(() => root.classList.remove("lockflash"), 700));
    render();
    cb.lockIn(you, foe);
  }

  // ---- input ----------------------------------------------------------------
  root.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("button,[data-leave]");
    if (!t || !isOpen) return;
    if (t.hasAttribute("data-leave")) return cb.leave();
    if (t === goBtn) return lockIn();
    const id = t.dataset.cls;
    if (!id || (t as HTMLButtonElement).disabled) return;
    const s = t.dataset.side as "L" | "R";
    if (s === "L") {
      selL = id;
      store.set("mk-faceoff-you", id);
    } else {
      selR = id;
      store.set("mk-faceoff-foe", id);
    }
    setPressed();
    show(s, id);
    // A champion chosen, the CPU's roster is next; the CPU's chosen, Lock In is.
    const next =
      s === "L" && mode === "cpu"
        ? root.querySelector<HTMLButtonElement>(`.fo-roster[data-side="R"] [aria-pressed="true"]`)
        : goBtn;
    next?.focus({ preventScroll: true });
  });
  // Hover previews a shield; leaving the roster puts the chosen one back.
  root.addEventListener("pointerover", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>(".fo-crest");
    if (!t || t.disabled || !isOpen) return;
    show(t.dataset.side as "L" | "R", t.dataset.cls!);
  });
  root.addEventListener("pointerout", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".fo-roster");
    if (!r || r.contains(e.relatedTarget as Node) || locked || revealing) return;
    const s = r.dataset.side as "L" | "R";
    if (s === "R" && mode === "online") return;
    show(s, s === "L" ? selL : selR);
  });
  // Keyboard focus previews too (arrows walk the shields the way a pad would).
  root.addEventListener("focusin", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>(".fo-crest");
    if (t && !t.disabled) show(t.dataset.side as "L" | "R", t.dataset.cls!);
  });
  root.addEventListener("keydown", (e) => {
    if (!isOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      return cb.leave();
    }
    const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
    if (!d) return;
    e.preventDefault();
    const els = [...root.querySelectorAll<HTMLButtonElement>("button")].filter((b) => !b.disabled && b.offsetParent !== null);
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !els.includes(cur as HTMLButtonElement)) {
      (root.querySelector<HTMLButtonElement>(`.fo-roster[data-side="L"] [aria-pressed="true"]`) ?? els[0])?.focus();
      return;
    }
    const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best: HTMLButtonElement | null = null, bs = 1e9;
    for (const b of els) {
      if (b === cur) continue;
      const r = b.getBoundingClientRect(), vx = r.left + r.width / 2 - ax, vy = r.top + r.height / 2 - ay;
      const along = d[0] ? vx * d[0] : vy * d[1];
      if (along <= 2) continue;
      const score = along + (d[0] ? Math.abs(vy) : Math.abs(vx)) * 2.2;
      if (score < bs) { bs = score; best = b; }
    }
    best?.focus({ preventScroll: true });
  });

  // ---- open / settle / hide -------------------------------------------------
  function clearTimers() {
    timers.forEach((t) => clearTimeout(t));
    timers = [];
  }
  function openScreen() {
    isOpen = true;
    revealing = false;
    shown.L = shown.R = "";
    root.classList.remove("reveal", "out", "lockflash", "redraw");
    root.classList.add("show");
    preload();
    setPressed();
    show("L", selL, false);
    show("R", mode === "online" ? "sealed" : selR, false);
    emberStop?.();
    emberStop = embers(root.querySelector<HTMLCanvasElement>(".fo-embers")!);
    cb.opened?.();
    // A beat for the entrance, then the chosen shield takes focus (a fixed
    // match has nothing to choose: Lock In does).
    timers.push(
      window.setTimeout(() => {
        if (!isOpen || locked) return;
        const first = fixed ? goBtn : root.querySelector<HTMLButtonElement>(`.fo-roster[data-side="L"] [aria-pressed="true"]`);
        first?.focus({ preventScroll: true });
      }, 450),
    );
  }

  function hide() {
    clearTimers();
    emberStop?.();
    emberStop = null;
    cb.closed?.();
    isOpen = false;
    revealing = false;
    locked = false;
    theirsLocked = false;
    lastKey = "";
    if (fixed) {
      // Back to the player's own remembered picks for the next real match.
      fixed = null;
      selL = store.get("mk-faceoff-you", "warrior");
      selR = store.get("mk-faceoff-foe", RANDOM);
      if (!valid(selL)) selL = "warrior";
      if (!valid(selR)) selR = RANDOM;
    }
    root.classList.remove("show", "reveal", "out", "lockflash", "online", "locked", "fixed");
  }

  return {
    get open() {
      return isOpen;
    },
    sync(s) {
      const key = `${s.mode}|${s.foeLabel}|${s.mine}|${s.theirsLocked}|${s.fixed?.you}|${s.fixed?.foe}`;
      if (isOpen && key === lastKey) return;
      lastKey = key;
      mode = s.mode;
      theirsLocked = s.theirsLocked;
      fixed = s.fixed ?? null;
      if (fixed) {
        // Not stored: the player's own remembered picks survive the tutorial.
        selL = fixed.you;
        selR = fixed.foe;
        if (isOpen) {
          setPressed();
          show("R", selR);
        }
      }
      if (s.mine) {
        locked = true;
        selL = s.mine;
      }
      sideEl("R").querySelector(".fo-who")!.textContent = s.foeLabel;
      if (!isOpen) openScreen();
      if (locked) show("L", selL);
      render();
    },
    settle(mine, theirs) {
      if (!isOpen || revealing) return;
      revealing = true;
      locked = true;
      if (mine) show("L", mine);
      if (theirs) show("R", theirs);
      sideEl("R").classList.add("revealed");
      root.classList.add("reveal");
      render();
      timers.push(window.setTimeout(() => root.classList.add("out"), REVEAL_HOLD_MS));
      timers.push(window.setTimeout(hide, REVEAL_HOLD_MS + FADE_MS));
    },
    hide,
  };
}

const DIE_SVG =
  `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4 42 14V34L24 44 6 34V14Z" fill="currentColor" fill-opacity=".14" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>` +
  `<path d="M6 14 24 24 42 14M24 24V44" fill="none" stroke="currentColor" stroke-width="1.75"/>` +
  `<circle cx="24" cy="14" r="2.6" fill="currentColor"/><circle cx="13" cy="25" r="2.4" fill="currentColor"/><circle cx="17" cy="33" r="2.4" fill="currentColor"/>` +
  `<circle cx="31" cy="27" r="2.4" fill="currentColor"/><circle cx="35" cy="35" r="2.4" fill="currentColor"/></svg>`;

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Embers rising behind the face-off (gold, with the arena's violet among
 *  them). Returns a stop function; stops itself for reduced motion. */
function embers(c: HTMLCanvasElement): () => void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  const g = c.getContext("2d");
  if (!g) return () => {};
  type P = { x: number; y: number; vy: number; vx: number; r: number; ph: number; life: number; max: number; hue: number };
  const P: P[] = [];
  let W = 0, H = 0, last = 0, raf = 0;
  const fit = () => {
    const r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
    W = r.width;
    H = r.height;
    c.width = Math.max(1, (W * d) | 0);
    c.height = Math.max(1, (H * d) | 0);
    g.setTransform(d, 0, 0, d, 0, 0);
  };
  const spawn = (y?: number): P => ({
    x: Math.random() * W, y: y ?? H + 8, vy: 14 + Math.random() * 40, vx: (Math.random() - 0.5) * 12,
    r: 0.6 + Math.random() * 1.6, ph: Math.random() * 6.28, life: 0, max: 4 + Math.random() * 6, hue: Math.random(),
  });
  fit();
  for (let i = 0; i < 56; i++) P.push(spawn(Math.random() * H));
  const tick = (t: number) => {
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    if (Math.abs(c.getBoundingClientRect().width - W) > 1) fit();
    g.clearRect(0, 0, W, H);
    g.globalCompositeOperation = "lighter";
    for (const p of P) {
      p.life += dt;
      p.y -= p.vy * dt;
      p.x += (p.vx + Math.sin(p.ph + p.life * 1.6) * 10) * dt;
      const k = p.life / p.max;
      if (k >= 1 || p.y < -10) {
        Object.assign(p, spawn());
        continue;
      }
      const a = Math.max(0, Math.min(1, k * 4, (1 - k) * 1.6)) * (0.55 + 0.45 * Math.sin(p.ph + p.life * 9));
      const col = p.hue < 0.55 ? "255,140,50" : p.hue < 0.8 ? "255,200,110" : "170,110,255";
      g.fillStyle = `rgba(${col},${a * 0.18})`;
      g.beginPath();
      g.arc(p.x, p.y, p.r * 4, 0, 6.283);
      g.fill();
      g.fillStyle = `rgba(${col},${a})`;
      g.beginPath();
      g.arc(p.x, p.y, p.r, 0, 6.283);
      g.fill();
    }
    g.globalCompositeOperation = "source-over";
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
