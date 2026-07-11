// ============================================================================
// audio.ts — match music only (in-game SFX removed by design).
//
// One AudioContext owns a looping background track, mixed quiet with a
// high-cut so it sits in the room rather than on top of the table. Browsers
// block audio until a user gesture — call unlock() from any first tap/click;
// if startMusic() was already requested it begins right then.
// ============================================================================

// Match music — a rotating playlist, mixed quiet with a high-cut so it sits
// in the background of the room rather than on top of the table. Each page
// load shuffles a fresh order; the same track never plays twice in a row,
// even across the reshuffle boundary.
const MUSIC_URLS = [
  "/music/midvinter.mp3",
  "/music/mother-rune.mp3",
  "/music/rings.mp3",
  "/music/chakaruna.mp3",
  "/music/fish-whale.mp3",
];
const MUSIC_GAIN = 0.2;

class AudioBank {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private unlocked = false;
  private muted = false;
  private musicEl: HTMLAudioElement | null = null;
  private musicGain: GainNode | null = null;
  private musicWanted = false;
  private volume = 0.2; // slider position 0..1 (default 20%)
  private crackleVolume = 0.9; // fire-panel mixer, 0..1
  private crackleGain: GainNode | null = null;
  private playOrder: string[] = [];
  private orderIdx = 0;
  private lastPlayed: string | null = null;

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
    // Music was requested before the unlock gesture — start it now.
    if (this.musicWanted) this.startMusic();
    this.startAmbience();
  }

  private effectiveGain(): number {
    return MUSIC_GAIN * 2 * this.volume;
  }

  private applyGain(): void {
    if (!this.ctx) return;
    if (this.musicGain) {
      this.musicGain.gain.setTargetAtTime(
        this.muted ? 0 : this.effectiveGain(),
        this.ctx.currentTime,
        0.1,
      );
    }
    if (this.crackleGain) {
      this.crackleGain.gain.setTargetAtTime(
        this.muted ? 0 : this.effectiveGain() * 2.6 * this.crackleVolume,
        this.ctx.currentTime,
        0.1,
      );
    }
  }

  /** Fire-panel crackle mixer, 0..1 (0.5 = designed level). */
  setCrackleVolume(v: number): void {
    this.crackleVolume = Math.min(1, Math.max(0, v));
    this.applyGain();
  }

  /** Fireplace crackle — a looped recording, streamed through the same
   *  WebAudio chain so mute and the fire-panel mixer control it. */
  private startAmbience(): void {
    if (this.crackleGain) return;
    const ctx = this.ensureCtx();
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = this.muted ? 0 : this.effectiveGain() * 2.6 * this.crackleVolume;
    this.crackleGain.connect(this.masterGain!);
    const el = new Audio("/sounds/fire-crackle.mp3");
    el.loop = true;
    el.preload = "auto";
    ctx.createMediaElementSource(el).connect(this.crackleGain);
    void el.play().catch(() => {});
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  /** Volume slider position, 0..1 (0.5 = the designed background level). */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyGain();
  }

  /** Start the playlist (begins once audio is unlocked; safe to re-call).
   *  Streams through an <audio> element routed into the WebAudio chain so
   *  long tracks never sit decoded in memory. */
  startMusic(): void {
    this.musicWanted = true;
    if (!this.unlocked) return;
    const ctx = this.ensureCtx();
    if (!this.musicEl) {
      // element -> high-cut -> music gain -> master. The filter takes the
      // edge off the top end so the track reads as "music in the room".
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 8500;
      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = this.muted ? 0 : this.effectiveGain();
      lowpass.connect(this.musicGain).connect(this.masterGain!);
      this.musicEl = new Audio();
      this.musicEl.preload = "auto";
      ctx.createMediaElementSource(this.musicEl).connect(lowpass);
      this.musicEl.addEventListener("ended", () => {
        if (this.musicWanted) this.playNextTrack();
      });
    }
    if (this.musicEl.paused) this.playNextTrack();
  }

  private playNextTrack(): void {
    if (!this.musicEl) return;
    if (this.orderIdx >= this.playOrder.length) {
      // Fresh shuffle each cycle (Fisher-Yates)...
      const order = [...MUSIC_URLS];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      // ...but never the same track twice in a row across the boundary.
      if (order.length > 1 && order[0] === this.lastPlayed) {
        const j = 1 + Math.floor(Math.random() * (order.length - 1));
        [order[0], order[j]] = [order[j], order[0]];
      }
      this.playOrder = order;
      this.orderIdx = 0;
    }
    const url = this.playOrder[this.orderIdx++];
    this.lastPlayed = url;
    this.musicEl.src = url;
    void this.musicEl.play().catch(() => {});
  }

  /** Fade the music out and pause the playlist. */
  stopMusic(): void {
    this.musicWanted = false;
    if (!this.musicEl || !this.ctx) return;
    this.musicGain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
    const el = this.musicEl;
    setTimeout(() => {
      el.pause();
      if (this.musicGain) {
        this.musicGain.gain.value = this.muted ? 0 : this.effectiveGain();
      }
    }, 1600);
  }

  isMuted(): boolean {
    return this.muted;
  }

}

export const audio = new AudioBank();
