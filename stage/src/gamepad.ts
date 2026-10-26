// ============================================================================
// gamepad.ts — full controller support (Xbox, PlayStation, Switch Pro, Steam
// Deck: anything the browser reports with the "standard" mapping). Polls the
// Gamepad API on its own frame loop and drives the game three ways:
//
//   table  — the D-pad / left stick walks a gold ring over whatever the
//            current step can act on (stones to move, ability targets,
//            Blink tiles; every stone when it isn't your turn), A does the
//            step (flip the opening coin, roll, move, fire), Y swigs or
//            explains the ringed stone, B cancels an armed ability.
//   dock   — X: walk the ability gems (each one shows its card), A casts.
//   ui     — every menu and dialog: the D-pad moves a focus outline between
//            the controls that are actually on top (hit-tested, so whichever
//            overlay is open owns the pad), A presses, B backs out, LB / RB
//            turn pages, the right stick scrolls. Select opens this over the
//            in-game HUD too (rail, dock, log), so every button is reachable.
//
// The room-code box is typed arcade-style (up/down picks the letter). Button
// prompts run along the bottom while a pad is in use, in that pad's own
// glyphs; touching the mouse or keyboard hands control back and hides them.
// main.ts owns the game: it answers TableHooks and calls rumble() on the
// moments worth feeling.
// ============================================================================

import "./gamepad.css";

/** Something on the table the ring can sit on: `key` is main.ts's own id
 *  ("t3" a stone, "tile9" a tile), x / y its screen position in CSS px. */
export interface TableTarget {
  key: string;
  x: number;
  y: number;
}

export type TableStep =
  | { kind: "flip" | "roll"; label: string }
  | { kind: "move" | "aim" | "look"; label: string; targets: TableTarget[] };

export interface TableHooks {
  /** A modal screen is up (menu, face-off, dialogs): the pad drives the DOM. */
  overlay(): boolean;
  /** What the table is waiting on now, or null when there's nothing to do. */
  step(): TableStep | null;
  /** Put the ring on a target (null hides it). */
  ring(t: TableTarget | null): void;
  /** A: do the step — flip / roll ignore the target. */
  act(t: TableTarget | null): void;
  /** Y: a waiting swig, else the ringed stone's card. Returns the prompt label. */
  alt(t: TableTarget | null): void;
  altLabel(): string | null;
  /** B: leave targeting. True if anything was cancelled. */
  cancel(): boolean;
  /** Start: the pause / leave dialog. */
  pause(): void;
  /** Dock focus moved to a gem (show its card) or left the dock (null). */
  dockFocus(el: HTMLElement | null): void;
}

export interface PadConfig {
  /** Back buttons, tried in order — the first one on top gets the B press. */
  back: string[];
  /** LB / RB in the UI: page turners. */
  prev: string[];
  next: string[];
  /** Where focus lands first when a screen opens. */
  defaults: string[];
  /** The screens themselves: the topmost one showing owns the pad (focus
   *  can't wander onto the HUD around a dialog), and when the set showing
   *  changes, focus starts over from `defaults`. */
  overlays: string[];
  /** Controls outside a screen that stay reachable while it's up. */
  extra: Record<string, string[]>;
  /** Arcade-typed inputs: input selector -> the button that submits it. */
  submit: Record<string, string>;
}

type Mode = "table" | "dock" | "ui";

const FOCUSABLE =
  'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"]';
const REPEAT_DELAY = 360;
const REPEAT_EVERY = 125;
const STICK = 0.55;

// Standard mapping button indices.
const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, SELECT = 8, START = 9, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;

let activePad: Gamepad | null = null;

/** A shake in the hands — the moments worth feeling. */
export function rumble(kind: "tap" | "flip" | "hit" | "hurt" | "win" | "lose"): void {
  const act = (activePad as (Gamepad & { vibrationActuator?: GamepadHapticActuator }) | null)?.vibrationActuator;
  if (!act || !document.body.classList.contains("gp-active")) return;
  const fx = {
    tap: [40, 0.0, 0.35],
    flip: [140, 0.15, 0.55],
    hit: [180, 0.55, 0.6],
    hurt: [320, 0.9, 0.4],
    win: [700, 0.5, 0.9],
    lose: [500, 0.8, 0.2],
  }[kind];
  void (act as unknown as { playEffect(t: string, p: object): Promise<unknown> })
    .playEffect("dual-rumble", { duration: fx[0], strongMagnitude: fx[1], weakMagnitude: fx[2] })
    .catch(() => {});
}

export function createGamepadControls(hooks: TableHooks, cfg: PadConfig): void {
  let mode: Mode = "table";
  let hud = false; // Select's UI-over-the-HUD
  let active = false;
  let prevButtons: boolean[] = [];
  const held = new Map<string, number>(); // direction -> next repeat time
  let tableFocus: string | null = null;
  let uiFocus: HTMLElement | null = null;
  let lastStepSig = "";
  let editing: HTMLInputElement | null = null;
  let editAt = 0;
  let screenSig = "";
  let lastActive: Element | null = null;
  let settleUntil = 0; // a screen just opened: keep re-picking its default while it animates in

  // ---- prompts ---------------------------------------------------------------
  const bar = document.createElement("div");
  bar.id = "gp-prompts";
  bar.setAttribute("aria-hidden", "true");
  document.body.appendChild(bar);
  let barSig = "";
  function glyph(b: string): string {
    const id = activePad?.id ?? "";   // Sony pads report as "Wireless Controller (... Vendor: 054c ...)"
    const ps = /054c|playstation|dualsense|dualshock/i.test(id) || /^wireless controller/i.test(id);
    const map: Record<string, [string, string]> = ps
      ? { A: ["✕", "gp-a"], B: ["○", "gp-b"], X: ["□", "gp-x"], Y: ["△", "gp-y"], LB: ["L1", "gp-sh"], RB: ["R1", "gp-sh"],
          START: ["☰", "gp-sh"], SELECT: ["⧉", "gp-sh"], DPAD: ["✥", "gp-sh"] }
      : { A: ["A", "gp-a"], B: ["B", "gp-b"], X: ["X", "gp-x"], Y: ["Y", "gp-y"], LB: ["LB", "gp-sh"], RB: ["RB", "gp-sh"],
          START: ["☰", "gp-sh"], SELECT: ["⧉", "gp-sh"], DPAD: ["✥", "gp-sh"] };
    const [t, c] = map[b];
    return `<i class="gp-g ${c}${ps ? " gp-ps" : ""}">${t}</i>`;
  }
  function prompts(list: [string, string][]) {
    const sig = list.map((p) => p.join(":")).join("|") + (activePad?.id ?? "");
    if (sig === barSig) return;
    barSig = sig;
    bar.innerHTML = list.map(([b, label]) => `<span>${glyph(b)}${label}</span>`).join("");
  }

  // ---- activity: the pad vs the mouse / keyboard --------------------------------
  function setActive(on: boolean) {
    if (active === on) return;
    active = on;
    document.body.classList.toggle("gp-active", on);
    if (!on) {
      hooks.ring(null);
      uiFocus?.classList.remove("gp-focus");
      if (mode === "dock") leaveDock();
      hud = false;
      stopEditing();
    }
  }
  const handBack = () => setActive(false);
  window.addEventListener("pointerdown", handBack, true);
  window.addEventListener("mousemove", (e) => {
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) handBack();
  });
  window.addEventListener("keydown", (e) => {
    if (e.isTrusted) handBack();
  }, true);

  // ---- DOM focus ------------------------------------------------------------------
  function isShown(el: Element): boolean {
    if (!(el instanceof HTMLElement) || el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.05;
  }
  function scrollParent(el: HTMLElement): HTMLElement | null {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 2) return p;
    }
    return null;
  }
  /** On top and pressable: whatever the topmost layer is, it owns the pad. */
  function onTop(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    let x = r.left + r.width / 2, y = r.top + r.height / 2;
    let host: HTMLElement = el;
    const sp = scrollParent(el);
    if (sp) {
      const s = sp.getBoundingClientRect();
      if (y < s.top || y > s.bottom) { // scrolled out of its list: judge the list
        x = s.left + s.width / 2;
        y = s.top + Math.min(s.height / 2, 30);
        host = sp;
      }
    }
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return !!hit && (host === hit || host.contains(hit) || hit.contains(host));
  }
  function candidates(scope?: string | (Element | null)[]): HTMLElement[] {
    const roots = Array.isArray(scope) ? scope : [scope ? document.querySelector(scope) : document];
    return roots.flatMap((root) => (root ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)] : [])).filter(
      (el) =>
        el.id !== "canvas" &&
        !(el as HTMLButtonElement).disabled &&
        !el.closest('[aria-hidden="true"], #gp-prompts') &&
        isShown(el) &&
        onTop(el),
    );
  }
  function focusEl(el: HTMLElement | null, announce = true) {
    if (uiFocus === el) {
      el?.classList.add("gp-focus");
      return;
    }
    uiFocus?.classList.remove("gp-focus");
    uiFocus = el;
    if (!el) return;
    el.classList.add("gp-focus");
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (announce) rumble("tap");
  }
  /** The nearest control in a direction, scored along the axis plus a
   *  penalty for drifting off it (the face-off's own shield walk does the
   *  same). Nothing that way: no move. */
  function nearest<T>(items: T[], from: { x: number; y: number }, dx: number, dy: number, at: (t: T) => { x: number; y: number }): T | null {
    let best: T | null = null, bs = 1e9;
    for (const it of items) {
      const p = at(it), vx = p.x - from.x, vy = p.y - from.y;
      const along = dx ? vx * dx : vy * dy;
      if (along <= 4) continue;
      const score = along + (dx ? Math.abs(vy) : Math.abs(vx)) * 2.2;
      if (score < bs) { bs = score; best = it; }
    }
    return best;
  }
  const centre = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  function defaultOf(list: HTMLElement[]): HTMLElement | null {
    for (const sel of cfg.defaults) {
      const el = list.find((e) => e.matches(sel));
      if (el) return el;
    }
    const pressed = list.find((e) => e.getAttribute("aria-pressed") === "true" || e.classList.contains("active"));
    return pressed ?? [...list].sort((a, b) => centre(a).y - centre(b).y || centre(a).x - centre(b).x)[0] ?? null;
  }
  /** The highest screen showing, if any. */
  function topScreen(): HTMLElement | null {
    let best: HTMLElement | null = null, bz = -Infinity;
    for (const sel of cfg.overlays) {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el || !isShown(el)) continue;
      const z = parseInt(getComputedStyle(el).zIndex) || 0;
      if (z >= bz) { bz = z; best = el; }
    }
    return best;
  }
  function firstOnTop(sels: string[]): HTMLElement | null {
    for (const sel of sels) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && isShown(el) && onTop(el)) return el;
    }
    return null;
  }

  // ---- arcade typing (the room code) ------------------------------------------------
  function startEditing(el: HTMLInputElement) {
    editing = el;
    const max = el.maxLength > 0 ? el.maxLength : 8;
    if (!el.value) el.value = (el.dataset.gpAlphabet ?? "A")[0];
    editAt = Math.min(el.value.length - 1, max - 1);
    el.classList.add("gp-editing");
    showEdit();
  }
  function stopEditing() {
    editing?.classList.remove("gp-editing");
    editing = null;
  }
  function showEdit() {
    if (!editing) return;
    editing.focus({ preventScroll: true });
    editing.setSelectionRange(editAt, editAt + 1);
    editing.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function editKey(k: "up" | "down" | "left" | "right" | "a" | "b") {
    const el = editing!;
    const abc = el.dataset.gpAlphabet ?? "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const max = el.maxLength > 0 ? el.maxLength : 8;
    const chars = el.value.toUpperCase().split("");
    if (k === "up" || k === "down") {
      const i = Math.max(0, abc.indexOf(chars[editAt] ?? abc[0]));
      chars[editAt] = abc[(i + (k === "down" ? 1 : -1) + abc.length) % abc.length];
      el.value = chars.join("");
    } else if (k === "left") {
      editAt = Math.max(0, editAt - 1);
    } else if (k === "right" || k === "a") {
      if (editAt < max - 1) {
        editAt++;
        if (chars.length <= editAt) el.value = chars.join("") + abc[0];
      } else if (k === "a") {
        stopEditing();
        const sub = Object.entries(cfg.submit).find(([sel]) => el.matches(sel));
        if (sub) document.querySelector<HTMLElement>(sub[1])?.click();
        return;
      }
    } else if (k === "b") {
      stopEditing();
      focusEl(el, false);
      return;
    }
    rumble("tap");
    showEdit();
  }

  // ---- modes ---------------------------------------------------------------------------
  function leaveDock() {
    mode = "table";
    hooks.dockFocus(null);
    if (uiFocus?.matches(".dock-btn")) uiFocus.blur();
  }
  function uiPress(el: HTMLElement) {
    if (el instanceof HTMLInputElement && el.dataset.gpAlphabet) return startEditing(el);
    if (el instanceof HTMLInputElement && (el.type === "text" || el.type === "search")) {
      el.focus(); // the OS keyboard on a Deck / console browser
      return;
    }
    rumble("tap");
    el.click();
  }

  function pressed(i: number, now: boolean[]) {
    return now[i] && !prevButtons[i];
  }

  function frame() {
    requestAnimationFrame(frame);
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p): p is Gamepad => !!p && p.connected) : [];
    if (!pads.length) {
      prevButtons = [];
      return;
    }
    // The pad being used is the one that last moved.
    const pad = pads.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
    activePad = pad;
    const now = pad.buttons.map((b) => b.pressed || b.value > 0.5);
    const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0, ry = pad.axes[3] ?? 0;
    const dirs = {
      up: now[UP] || ay < -STICK,
      down: now[DOWN] || ay > STICK,
      left: now[LEFT] || ax < -STICK,
      right: now[RIGHT] || ax > STICK,
    };
    const anything = now.some(Boolean) || Math.abs(ax) > STICK || Math.abs(ay) > STICK || Math.abs(ry) > STICK;
    if (anything && !active) {
      setActive(true);
      prevButtons = now; // the waking press only wakes
      for (const d of Object.keys(dirs)) if (dirs[d as keyof typeof dirs]) held.set(d, performance.now() + REPEAT_DELAY);
      return;
    }
    if (!active) {
      prevButtons = now;
      return;
    }
    const t = performance.now();
    const fired: string[] = [];
    for (const [d, on] of Object.entries(dirs)) {
      if (!on) { held.delete(d); continue; }
      const next = held.get(d);
      if (next === undefined) { fired.push(d); held.set(d, t + REPEAT_DELAY); }
      else if (t >= next) { fired.push(d); held.set(d, t + REPEAT_EVERY); }
    }

    // Which world owns the pad this frame.
    const overlay = hooks.overlay();
    if (overlay) hud = false;
    const uiMode = overlay || hud;
    if (uiMode && mode === "dock") leaveDock();
    if (uiMode) mode = "ui";
    else if (mode === "ui") mode = "table";

    if (mode === "ui") runUi(now, fired, ry);
    else if (mode === "dock") runDock(now, fired);
    else runTable(now, fired);
    prevButtons = now;
  }

  function runUi(now: boolean[], fired: string[], ry: number) {
    hooks.ring(null);
    if (editing) {
      if (!document.contains(editing) || !isShown(editing)) stopEditing();
      else {
        for (const d of fired) editKey(d as "up");
        if (pressed(A, now)) editKey("a");
        if (pressed(B, now)) editKey("b");
        if (pressed(START, now)) { editAt = (editing.maxLength || 1) - 1; editKey("a"); }
        prompts([["DPAD", "Letter"], ["A", "Next"], ["B", "Done"]]);
        return;
      }
    }
    const top = hud ? null : topScreen();
    const list = candidates(top ? [top, ...(cfg.extra["#" + top.id] ?? []).map((q) => document.querySelector(q))] : undefined);
    const sig = cfg.overlays.filter((sel) => {
      const el = document.querySelector(sel);
      return !!el && isShown(el);
    }).join(",") + (hud ? "+hud" : "");
    if (sig !== screenSig) {
      screenSig = sig;
      settleUntil = performance.now() + 900;
      uiFocus?.classList.remove("gp-focus");
      uiFocus = null;
    }
    const act = document.activeElement as HTMLElement | null;
    const moved = act !== lastActive;
    lastActive = act;
    if (moved && act && act !== uiFocus && act !== document.body && list.includes(act)) {
      focusEl(act, false); // the page moved focus itself (the face-off does, after a pick)
    } else if (!uiFocus || !list.includes(uiFocus) || (performance.now() < settleUntil && !fired.length)) {
      focusEl(defaultOf(list), false);
    } else uiFocus.classList.add("gp-focus");
    if (fired.length || pressed(A, now)) settleUntil = 0; // the player has taken over
    for (const d of fired) {
      if (!uiFocus) break;
      if (uiFocus instanceof HTMLInputElement && uiFocus.type === "range" && (d === "left" || d === "right")) {
        const r = uiFocus;
        r.value = String(+r.value + (d === "right" ? 1 : -1) * (+r.step || 5));
        r.dispatchEvent(new Event("input", { bubbles: true }));
        r.dispatchEvent(new Event("change", { bubbles: true }));
        continue;
      }
      const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[d as "up"];
      const to = nearest(list.filter((e) => e !== uiFocus), centre(uiFocus), dx, dy, centre);
      if (to) focusEl(to);
    }
    if (Math.abs(ry) > 0.25 && uiFocus) {
      const sp = scrollParent(uiFocus) ?? candidates().map(scrollParent).find(Boolean) ?? null;
      sp?.scrollBy(0, ry * 16);
    }
    if (pressed(A, now) && uiFocus) uiPress(uiFocus);
    if (pressed(B, now)) {
      if (hud) {
        hud = false;
        uiFocus?.classList.remove("gp-focus");
        uiFocus = null;
      } else {
        const back = firstOnTop(cfg.back);
        if (back) back.click();
        else (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    }
    if (pressed(LB, now)) firstOnTop(cfg.prev)?.click();
    if (pressed(RB, now)) firstOnTop(cfg.next)?.click();
    if (pressed(SELECT, now) && hud) {
      hud = false;
      uiFocus?.classList.remove("gp-focus");
      uiFocus = null;
    }
    if (pressed(START, now) && hud) {
      hud = false;
      hooks.pause();
    }
    const list2: [string, string][] = [["DPAD", "Move"], ["A", "Select"], ["B", hud ? "Back to table" : "Back"]];
    if (firstOnTop(cfg.next)) list2.push(["RB", "Next page"]);
    prompts(list2);
  }

  function runDock(now: boolean[], fired: string[]) {
    hooks.ring(null);
    const gems = candidates("#dock").filter((e) => e.matches(".dock-btn"));
    if (!gems.length) { leaveDock(); return; }
    if (!uiFocus || !gems.includes(uiFocus)) {
      focusEl(gems.find((g) => g.dataset.state === "ready" && !g.classList.contains("passive")) ?? gems[0], false);
      hooks.dockFocus(uiFocus);
    }
    for (const d of fired) {
      const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[d as "up"];
      const to = nearest(gems.filter((e) => e !== uiFocus), centre(uiFocus!), dx, dy, centre) ??
        // the gems ring the portrait: any direction steps round the arc
        gems[(gems.indexOf(uiFocus!) + (dx + dy > 0 ? 1 : gems.length - 1)) % gems.length];
      if (to && to !== uiFocus) {
        focusEl(to);
        hooks.dockFocus(to);
      }
    }
    if (pressed(A, now) && uiFocus) {
      const passive = uiFocus.classList.contains("passive");
      uiFocus.click();
      if (!passive) {
        uiFocus.classList.remove("gp-focus");
        uiFocus = null;
        leaveDock();
      }
    } else if (pressed(B, now) || pressed(X, now)) {
      uiFocus?.classList.remove("gp-focus");
      uiFocus = null;
      leaveDock();
    } else if (pressed(START, now)) {
      leaveDock();
      hooks.pause();
    }
    prompts([["DPAD", "Choose"], ["A", "Cast"], ["B", "Back"]]);
  }

  function runTable(now: boolean[], fired: string[]) {
    if (uiFocus) {
      uiFocus.classList.remove("gp-focus");
      uiFocus = null;
    }
    const step = hooks.step();
    const targets = step && "targets" in step ? step.targets : [];
    const sig = step ? step.kind + ":" + targets.map((tg) => tg.key).join(",") : "";
    if (sig !== lastStepSig) {
      // A new step: keep the ring where it was if that target still counts,
      // else start from the leftmost (screen order reads like the board).
      lastStepSig = sig;
      if (!targets.some((tg) => tg.key === tableFocus)) {
        const lead = [...targets].sort((a, b) => a.x - b.x || a.y - b.y)[0];
        tableFocus = lead?.key ?? null;
      }
    }
    const cur = targets.find((tg) => tg.key === tableFocus) ?? null;
    for (const d of fired) {
      if (!cur) break;
      const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[d as "up"];
      const to = nearest(targets.filter((tg) => tg !== cur), cur, dx, dy, (tg) => tg);
      if (to) {
        tableFocus = to.key;
        rumble("tap");
      }
    }
    const step1 = (dir: number) => {
      if (!targets.length) return;
      const order = [...targets].sort((a, b) => a.x - b.x || a.y - b.y);
      const i = order.findIndex((tg) => tg.key === tableFocus);
      tableFocus = order[(i + dir + order.length) % order.length].key;
      rumble("tap");
    };
    if (pressed(LB, now)) step1(-1);
    if (pressed(RB, now)) step1(1);
    const focus = targets.find((tg) => tg.key === tableFocus) ?? null;
    hooks.ring(step?.kind === "look" && !focus ? null : focus);

    if (pressed(A, now) && step) {
      hooks.act(focus);
      lastStepSig = ""; // the step is about to change
    }
    if (pressed(Y, now)) hooks.alt(focus);
    if (pressed(B, now)) hooks.cancel();
    if (pressed(X, now)) {
      if (candidates("#dock").some((e) => e.matches(".dock-btn"))) {
        mode = "dock";
        hooks.ring(null);
      }
    }
    if (pressed(START, now)) hooks.pause();
    if (pressed(SELECT, now)) {
      hud = true;
      hooks.ring(null);
    }

    const list: [string, string][] = [];
    if (step?.kind === "flip") list.push(["A", step.label]);
    else if (step?.kind === "roll") list.push(["A", step.label]);
    else if (step?.kind === "move") list.push(["DPAD", "Choose stone"], ["A", step.label]);
    else if (step?.kind === "aim") list.push(["DPAD", "Choose target"], ["A", step.label], ["B", "Cancel"]);
    else if (step?.kind === "look" && targets.length) list.push(["DPAD", "Look"], ["A", step.label]);
    if (step?.kind !== "aim" && candidates("#dock").some((e) => e.matches(".dock-btn"))) list.push(["X", "Abilities"]);
    const alt = hooks.altLabel();
    if (alt) list.push(["Y", alt]);
    list.push(["START", "Menu"], ["SELECT", "Buttons"]);
    prompts(list);
  }

  requestAnimationFrame(frame);
}
