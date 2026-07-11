// ============================================================================
// audio.ts — sound triggers for the game.
//
// Design: a single AudioBank owns one AudioContext + one set of loaded buffers.
// For each named event, SOUND_CONFIG says either:
//   - a URL to load from /public/sounds/, OR
//   - `null` to use the built-in procedural synthesizer as a placeholder.
//
// To swap in real sounds later: drop the file into stage/public/sounds/
// and change the corresponding SOUND_CONFIG entry from `null` to the URL.
// No other code changes needed.
//
// Browser audio must be unlocked by a user gesture — call unlock() from
// a click/tap handler at least once.
// ============================================================================

export type SoundEvent = "coin" | "capture" | "shield" | "escape" | "win";

const SOUND_CONFIG: Record<SoundEvent, string | null> = {
  // Set to "/sounds/coin.mp3" etc. once real files are dropped in stage/public/sounds/.
  coin: null,
  capture: null,
  shield: null,
  escape: null,
  win: null,
};

class AudioBank {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private buffers: Partial<Record<SoundEvent, AudioBuffer>> = {};
  private loadPromises: Partial<Record<SoundEvent, Promise<void>>> = {};
  private unlocked = false;
  private muted = false;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.6;
      this.masterGain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Must be called from a user gesture handler. Idempotent. */
  async unlock(): Promise<void> {
    if (this.unlocked) return;
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume();
    this.unlocked = true;
    // Pre-load any file-based sounds so first plays don't hitch.
    for (const event of Object.keys(SOUND_CONFIG) as SoundEvent[]) {
      const url = SOUND_CONFIG[event];
      if (url) this.loadFile(event, url);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  private async loadFile(event: SoundEvent, url: string): Promise<void> {
    if (this.buffers[event] || this.loadPromises[event]) return this.loadPromises[event]!;
    const ctx = this.ensureCtx();
    this.loadPromises[event] = (async () => {
      try {
        const resp = await fetch(url);
        const arr = await resp.arrayBuffer();
        this.buffers[event] = await ctx.decodeAudioData(arr);
      } catch (err) {
        console.warn(`Failed to load sound ${event} from ${url}:`, err);
      }
    })();
    return this.loadPromises[event];
  }

  play(event: SoundEvent): void {
    if (this.muted || !this.unlocked) return;
    const ctx = this.ensureCtx();
    const buffer = this.buffers[event];
    if (buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.masterGain!);
      src.start();
    } else {
      // Fallback: synthesize a procedural placeholder.
      this.playProcedural(event);
    }
  }

  // --------------------------------------------------------------------------
  // Procedural placeholders — small synthesizer routines per event type.
  // Each routine is a mini "instrument" written directly on the audio graph.
  // --------------------------------------------------------------------------

  private playProcedural(event: SoundEvent): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    switch (event) {
      case "coin":
        this.coinClatter(now);
        break;
      case "capture":
        this.captureThump(now);
        break;
      case "shield":
        this.shieldChime(now);
        break;
      case "escape":
        this.escapeDing(now);
        break;
      case "win":
        this.winFanfare(now);
        break;
    }
  }

  /** Four staggered metallic pings — sounds like coins hitting a table. */
  private coinClatter(now: number): void {
    const ctx = this.ctx!;
    for (let i = 0; i < 4; i++) {
      const t = now + i * 0.05 + Math.random() * 0.03;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = 900 + Math.random() * 400;
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(t);
      osc.stop(t + 0.16);
    }
  }

  /** Descending square whoosh — token being knocked away. */
  private captureThump(now: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.28);
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    osc.connect(gain).connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  /** Two-note bell chime — safety / protection. */
  private shieldChime(now: number): void {
    const ctx = this.ctx!;
    for (const [freq, delay, len] of [
      [880, 0, 0.5],
      [1320, 0.08, 0.6],
    ] as const) {
      const t = now + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + len);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(t);
      osc.stop(t + len + 0.02);
    }
  }

  /** Rising two-note ding — small victory. */
  private escapeDing(now: number): void {
    const ctx = this.ctx!;
    for (const [freq, delay] of [
      [660, 0],
      [990, 0.1],
    ] as const) {
      const t = now + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.28, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(t);
      osc.stop(t + 0.37);
    }
  }

  /** Four-note rising arpeggio — game won. */
  private winFanfare(now: number): void {
    const ctx = this.ctx!;
    const notes = [523, 659, 784, 1047]; // C E G C — major triad + octave
    notes.forEach((freq, i) => {
      const t = now + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.28, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc.connect(gain).connect(this.masterGain!);
      osc.start(t);
      osc.stop(t + 0.52);
    });
  }
}

export const audio = new AudioBank();
