// Playback through Web Audio (browser only): one buffer, or a gapless stream of chunks (streaming TTS).

export interface Playback {
  /** resolves when the audio has finished playing or was stopped */
  ended: Promise<void>;
  stop(): void;
}

/** how far ahead of "now" an idle stream schedules its first chunk, so it never starts mid-quantum late */
const LEAD_SECONDS = 0.05;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function newContext(): AudioContext {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const Ctx = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctx) throw new Error("cipetpet: audio playback needs the Web Audio API (a browser)");
  return new Ctx();
}

function toBuffer(ctx: BaseAudioContext, samples: Float32Array, sampleRate: number): AudioBuffer {
  const buf = ctx.createBuffer(1, samples.length, sampleRate);
  // getChannelData().set rather than copyToChannel: older Safari lacks the latter, and it rejects
  // arrays on a SharedArrayBuffer
  buf.getChannelData(0).set(samples);
  return buf;
}

/**
 * Plays mono samples once. The context's own rate does not matter: Web Audio resamples the buffer.
 * Without `ctx` a context is created for this playback and closed when it ends.
 */
export function playAudio(samples: Float32Array, sampleRate: number, ctx?: AudioContext): Playback {
  const own = !ctx;
  const c = ctx ?? newContext();
  // outside a user gesture this may stay pending; playback then starts on the next resume
  if (c.state === "suspended") c.resume().catch(() => {});
  if (samples.length === 0) {
    if (own) c.close().catch(() => {});
    return { ended: Promise.resolve(), stop() {} };
  }
  const src = c.createBufferSource();
  src.buffer = toBuffer(c, samples, sampleRate);
  src.connect(c.destination);
  const ended = new Promise<void>((resolve) => {
    src.onended = () => {
      src.disconnect();
      if (own) c.close().catch(() => {});
      resolve();
    };
  });
  src.start();
  return {
    ended,
    stop() {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    },
  };
}

/**
 * Plays chunks as they arrive, back to back with no gap (each starts exactly where the previous one
 * ends on the context's clock). If the stream runs dry, the next chunk starts ~50 ms after it arrives.
 *
 * ```ts
 * const player = new StreamPlayer(48000);
 * for await (const chunk of tts.stream(text)) player.push(chunk.audio);
 * await player.finish();
 * ```
 */
export class StreamPlayer {
  readonly sampleRate: number;
  private readonly ctx: AudioContext;
  private readonly own: boolean;
  private nextTime = 0;
  private readonly active = new Set<AudioBufferSourceNode>();
  private waiters: (() => void)[] = [];

  constructor(sampleRate: number, ctx?: AudioContext) {
    if (!(sampleRate > 0)) throw new RangeError(`cipetpet: bad sample rate ${sampleRate}`);
    this.sampleRate = sampleRate;
    this.own = !ctx;
    this.ctx = ctx ?? newContext();
  }

  get context(): AudioContext {
    return this.ctx;
  }

  /** seconds of audio scheduled but not yet played */
  get buffered(): number {
    return Math.max(0, this.nextTime - this.ctx.currentTime);
  }

  get playing(): boolean {
    return this.active.size > 0;
  }

  push(chunk: Float32Array): void {
    if (chunk.length === 0) return;
    const ctx = this.ctx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const start = this.nextTime > now ? this.nextTime : now + LEAD_SECONDS;
    const src = ctx.createBufferSource();
    src.buffer = toBuffer(ctx, chunk, this.sampleRate);
    src.connect(ctx.destination);
    src.onended = () => {
      src.disconnect();
      this.active.delete(src);
      if (this.active.size === 0) this.release();
    };
    this.active.add(src);
    src.start(start);
    this.nextTime = start + chunk.length / this.sampleRate;
  }

  /** resolves when the last chunk pushed so far has finished playing (at once when nothing is queued) */
  finish(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** stops playback at once and drops the queue; pending finish() promises resolve */
  stop(): void {
    for (const src of this.active) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // not started yet / already stopped
      }
      src.disconnect();
    }
    this.active.clear();
    this.nextTime = 0;
    this.release();
  }

  /** stop(), and close the AudioContext if this player created it */
  async close(): Promise<void> {
    this.stop();
    if (this.own && this.ctx.state !== "closed") await this.ctx.close();
  }

  private release(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }
}
