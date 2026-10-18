// Fake STT / TTS / LLM / mic / speaker for the controller tests. Time is real but short; every fake records
// what happened with timestamps so the tests can check ordering and overlap.

import type { ChatBackend, ChatMessage, ChatStreamOptions } from "../src/llm/types.ts";
import type { AudioOut, MicInput, MicOpenOptions, MicSession, SttEngine, Transcript, TtsEngine } from "../src/voice/types.ts";
import { sleep } from "./helpers.ts";

export const now = () => performance.now();

function abortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export class FakeMic implements MicInput {
  sessions: FakeMicSession[] = [];
  opens: MicOpenOptions[] = [];
  fail: Error | null = null;
  /** seconds of 16 kHz audio a session returns */
  seconds = 1.5;

  async open(opts: MicOpenOptions): Promise<MicSession> {
    this.opens.push(opts);
    await sleep(2);
    if (this.fail) throw this.fail;
    const s = new FakeMicSession(opts, this.seconds);
    this.sessions.push(s);
    return s;
  }

  get current(): FakeMicSession | undefined {
    return this.sessions[this.sessions.length - 1];
  }
}

export class FakeMicSession implements MicSession {
  state: "open" | "stopped" | "cancelled" = "open";
  private readonly t0 = now();
  constructor(
    readonly opts: MicOpenOptions,
    private readonly seconds: number,
  ) {}
  get duration(): number {
    return (now() - this.t0) / 1000;
  }
  level(v: number): void {
    if (this.state === "open") this.opts.onLevel(v);
  }
  async stop(): Promise<Float32Array> {
    this.state = "stopped";
    await sleep(1);
    return new Float32Array(Math.round(this.seconds * 16000)).fill(0.01);
  }
  cancel(): void {
    this.state = "cancelled";
  }
}

export class FakeStt implements SttEngine {
  calls: { samples: number; lang: string; beam: number; signal?: AbortSignal }[] = [];
  reply: Transcript = { text: "Merhaba, nasılsın?", lang: "tr" };
  ms = 20;
  error: Error | null = null;
  async transcribe(audio: Float32Array, req: { lang: string; beam: number; signal?: AbortSignal }): Promise<Transcript> {
    this.calls.push({ samples: audio.length, lang: req.lang, beam: req.beam, signal: req.signal });
    await abortable(this.ms, req.signal);
    if (this.error) throw this.error;
    return this.reply;
  }
}

export interface TtsEvent {
  kind: "synth-start" | "synth-end";
  text: string;
  t: number;
}

export class FakeTts implements TtsEngine {
  readonly sampleRate = 48000;
  events: TtsEvent[] = [];
  texts: string[] = [];
  signals: AbortSignal[] = [];
  /** synthesis time per chunk, and seconds of audio per chunk */
  synthMs = 15;
  chunkSeconds = 0.1;
  chunks = 2;
  async *stream(text: string, req: { speed: number; seed: number; signal?: AbortSignal }): AsyncIterable<Float32Array> {
    this.texts.push(text);
    if (req.signal) this.signals.push(req.signal);
    this.events.push({ kind: "synth-start", text, t: now() });
    for (let i = 0; i < this.chunks; i++) {
      await abortable(this.synthMs, req.signal);
      const chunk = new Float32Array(Math.round(this.chunkSeconds * this.sampleRate));
      (chunk as Float32Array & { label?: string }).label = text;
      yield chunk;
    }
    this.events.push({ kind: "synth-end", text, t: now() });
  }
}

export interface Played {
  label: string;
  start: number;
  end: number;
}

/** plays on a virtual timeline that follows the real clock */
export class FakeAudio implements AudioOut {
  unlocked = 0;
  stops = 0;
  played: Played[] = [];
  private queueEnd = 0;
  private waiters: { at: number; resolve: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

  unlock(): void {
    this.unlocked++;
  }
  push(chunk: Float32Array, sampleRate: number): number {
    const t = now();
    const start = Math.max(t + 5, this.queueEnd);
    const end = start + (chunk.length / sampleRate) * 1000;
    this.queueEnd = end;
    this.played.push({ label: (chunk as Float32Array & { label?: string }).label ?? "", start, end });
    return (start - t) / 1000;
  }
  finish(): Promise<void> {
    const wait = this.queueEnd - now();
    if (wait <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const w = { at: this.queueEnd, resolve, timer: setTimeout(() => resolve(), wait) };
      this.waiters.push(w);
    });
  }
  stop(): void {
    this.stops++;
    const t = now();
    // drop what has not played yet
    this.played = this.played.filter((p) => p.start < t).map((p) => ({ ...p, end: Math.min(p.end, t) }));
    this.queueEnd = 0;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
    this.waiters = [];
  }
  /** when the first chunk of a sentence starts / its last chunk ends */
  span(label: string): { start: number; end: number } {
    const mine = this.played.filter((p) => p.label === label);
    return { start: Math.min(...mine.map((p) => p.start)), end: Math.max(...mine.map((p) => p.end)) };
  }
}

export class FakeBackend implements ChatBackend {
  readonly kind = "proxy" as const;
  calls: { messages: ChatMessage[]; opts: ChatStreamOptions }[] = [];
  deltas: string[] = ["Merhaba! ", "Bugün size ", "nasıl yardımcı ", "olabilirim? ", "Sorunuzu ", "bekliyorum."];
  firstMs = 20;
  deltaMs = 10;
  error: { afterDeltas: number; error: Error } | null = null;
  /** resolves when the stream ended or was aborted */
  finished: { aborted: boolean; t: number }[] = [];
  lastDeltaAt = 0;

  async *stream(messages: ChatMessage[], opts: ChatStreamOptions): AsyncGenerator<string, void, undefined> {
    this.calls.push({ messages, opts });
    try {
      await abortable(this.firstMs, opts.signal);
      for (let i = 0; i < this.deltas.length; i++) {
        if (this.error && i === this.error.afterDeltas) throw this.error.error;
        if (i > 0) await abortable(this.deltaMs, opts.signal);
        this.lastDeltaAt = now();
        yield this.deltas[i];
      }
      this.finished.push({ aborted: false, t: now() });
    } catch (e) {
      this.finished.push({ aborted: opts.signal?.aborted ?? false, t: now() });
      throw e;
    }
  }
}
