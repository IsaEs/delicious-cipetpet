// A fake "cipetpet" root entry: the same API surface the React package uses, with no inference, no
// Web Audio and no microphone. Tests drive timing through the `fake` controller.

import type {
  LoadOptions,
  ModelInfo,
  PackSource,
  SpeechChunk,
  SynthesisOptions,
  SynthesisResult,
  TranscribeOptions,
  TranscriptionResult,
} from "cipetpet";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  return new DOMException("aborted", "AbortError");
}

function info(kind: "tts" | "stt"): ModelInfo {
  return {
    id: kind === "tts" ? "antalia-mini" : "duyu-small",
    name: kind,
    version: "test",
    task: kind === "tts" ? "text-to-speech" : "speech-recognition",
    variant: "int8",
    sampleRate: kind === "tts" ? 48000 : 16000,
    backend: "wasm",
    threads: 1,
    crossOriginIsolated: false,
    packBytes: 1,
    loadMs: { fetch: 0, init: 0 },
    onnxruntime: "test",
  };
}

const TIMINGS = { normalize: 0, text: 0, cond: 0, flow: 0, vocoder: 0, istft: 0, post: 0 };

export class FakeTts {
  readonly info = info("tts");
  readonly defaults = { steps: 8, cfg: 2, speed: 0.95, temperature: 0.6 };
  disposed = 0;
  streamCalls: { text: string; opts: SynthesisOptions }[] = [];
  synthCalls: { text: string; opts: SynthesisOptions }[] = [];
  constructor(readonly via: "load" | "worker", private readonly worker?: unknown) {}

  normalize(text: string): string | Promise<string> {
    const t = text.toLowerCase();
    return this.via === "worker" ? Promise.resolve(t) : t;
  }

  async synthesize(text: string, opts: SynthesisOptions = {}): Promise<SynthesisResult> {
    this.synthCalls.push({ text, opts });
    await fake.ttsGate(opts.signal);
    if (opts.signal?.aborted) throw abortError();
    return {
      audio: new Float32Array(480),
      sampleRate: 48000,
      modelText: text.toLowerCase(),
      stats: { computeMs: 1, seconds: 0.01, chunks: 1, rtf: 0.1, timings: { ...TIMINGS } },
    };
  }

  async *stream(text: string, opts: SynthesisOptions = {}): AsyncGenerator<SpeechChunk> {
    this.streamCalls.push({ text, opts });
    const parts = text.split(".").map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      await fake.ttsGate(opts.signal);
      if (opts.signal?.aborted) throw abortError();
      yield { audio: new Float32Array(100 * (i + 1)), index: i, count: parts.length, text: parts[i].toLowerCase(), timings: { flow: 1 } };
    }
  }

  async dispose(): Promise<void> {
    this.disposed++;
    terminateWorker(this.worker);
  }
}

export class FakeStt {
  readonly info = info("stt");
  disposed = 0;
  calls: { audio: Float32Array; opts: TranscribeOptions }[] = [];
  constructor(readonly via: "load" | "worker", private readonly worker?: unknown) {}

  async transcribe(audio: Float32Array, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    const n = this.calls.push({ audio, opts });
    await fake.sttGate(n - 1, opts.signal);
    if (opts.signal?.aborted) throw abortError();
    return {
      text: `heard ${audio.length}@${opts.sampleRate ?? 16000}#${n}`,
      lang: opts.lang === "en" ? "en" : "tr",
      segments: [],
      stats: { seconds: 0, computeMs: 0, rtf: 0, chunks: 1, mode: "attn", encoderMs: 0, decoderMs: 0 },
    };
  }

  async dispose(): Promise<void> {
    this.disposed++;
    terminateWorker(this.worker);
  }
}

function terminateWorker(worker: unknown): void {
  if (
    typeof worker === "object" &&
    worker !== null &&
    "terminate" in worker &&
    typeof worker.terminate === "function"
  ) {
    worker.terminate();
  }
}

export interface LoadCall {
  kind: "tts" | "stt";
  via: "load" | "worker";
  source: unknown;
  opts: LoadOptions & { worker?: unknown };
  model: FakeTts | FakeStt;
  deferred: Deferred<FakeTts | FakeStt>;
  /** resolve with the model */
  resolve(): void;
  reject(e?: unknown): void;
}

export class FakeContext {
  state: AudioContextState = "suspended";
  resumed = 0;
  closed = 0;
  async resume(): Promise<void> {
    this.resumed++;
    this.state = "running";
  }
  async close(): Promise<void> {
    this.closed++;
    this.state = "closed";
  }
}

export class StreamPlayer {
  readonly chunks: Float32Array[] = [];
  readonly context: AudioContext;
  stopped = 0;
  private ended = deferred();
  constructor(
    readonly sampleRate: number,
    ctx?: AudioContext,
  ) {
    this.context = ctx ?? (new FakeContext() as unknown as AudioContext);
    fake.players.push(this);
  }
  get playing(): boolean {
    return this.chunks.length > 0 && !this.stopped;
  }
  push(chunk: Float32Array): void {
    this.chunks.push(chunk);
  }
  finish(): Promise<void> {
    if (this.chunks.length === 0) this.ended.resolve(); // like the real player: nothing queued, nothing to wait for
    return this.ended.promise;
  }
  /** test helper: the queued audio finished playing */
  endPlayback(): void {
    this.ended.resolve();
  }
  stop(): void {
    this.stopped++;
    this.ended.resolve();
  }
  async close(): Promise<void> {
    this.stop();
  }
}

export class MicRecorder {
  readonly sampleRate: number;
  readonly captureRate = 48000;
  cancelled = 0;
  stopped = 0;
  constructor(readonly opts: { sampleRate?: number; onLevel?: (rms: number) => void; deviceId?: string }) {
    this.sampleRate = opts.sampleRate ?? 16000;
  }
  static start(opts: { sampleRate?: number; onLevel?: (rms: number) => void } = {}): Promise<MicRecorder> {
    const rec = new MicRecorder(opts);
    fake.recorders.push(rec);
    return fake.micGate().then(() => rec);
  }
  /** test helper */
  level(rms: number): void {
    this.opts.onLevel?.(rms);
  }
  get recording(): boolean {
    return !this.stopped && !this.cancelled;
  }
  get duration(): number {
    return 1;
  }
  async stop(): Promise<Float32Array> {
    if (this.cancelled) throw new Error("the recording was cancelled"); // like the real recorder
    this.stopped++;
    return new Float32Array(this.sampleRate); // one second
  }
  cancel(): void {
    this.cancelled++;
  }
}

function load(
  kind: "tts" | "stt",
  via: "load" | "worker",
  source: unknown,
  opts: LoadOptions & { worker?: unknown } = {},
): Promise<FakeTts | FakeStt> {
  const model = kind === "tts" ? new FakeTts(via, opts.worker) : new FakeStt(via, opts.worker);
  const d = deferred<FakeTts | FakeStt>();
  const call: LoadCall = {
    kind,
    via,
    source,
    opts,
    model,
    deferred: d,
    resolve: () => d.resolve(model),
    reject: (e = new Error("load failed")) => d.reject(e),
  };
  fake.loads.push(call);
  // like the real worker client: a load that fails or is aborted terminates the worker it started
  if (via === "worker") {
    d.promise.catch(() => (opts.worker as { terminate?(): void } | undefined)?.terminate?.());
  }
  opts.signal?.addEventListener("abort", () => d.reject(abortError()), { once: true });
  if (fake.failNext > 0) {
    fake.failNext--;
    queueMicrotask(() => call.reject(new Error("load failed")));
  } else if (fake.autoResolve) {
    queueMicrotask(() => {
      opts.onProgress?.({ loaded: 50, total: 100 });
      opts.onProgress?.({ loaded: 100, total: 100 });
      call.resolve();
    });
  }
  return d.promise;
}

export const AntaliaMini = {
  load: (source: PackSource, opts?: LoadOptions) => load("tts", "load", source, opts),
};
export const DuyuSmall = {
  load: (source: PackSource, opts?: LoadOptions) => load("stt", "load", source, opts),
};
export const createAntaliaWorker = (source: unknown, opts?: LoadOptions & { worker?: unknown }) =>
  load("tts", "worker", source, opts);
export const createDuyuWorker = (source: unknown, opts?: LoadOptions & { worker?: unknown }) =>
  load("stt", "worker", source, opts);

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  fake.wavCalls.push({ samples, sampleRate });
  return new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
}

export async function decodeAudio(input: unknown, targetRate = 16000) {
  fake.decodeCalls.push({ input, targetRate });
  return { audio: new Float32Array(8000), sampleRate: targetRate, duration: 8000 / targetRate };
}

/** the test controller */
export const fake = {
  autoResolve: true,
  failNext: 0,
  loads: [] as LoadCall[],
  players: [] as StreamPlayer[],
  recorders: [] as MicRecorder[],
  wavCalls: [] as { samples: Float32Array; sampleRate: number }[],
  decodeCalls: [] as { input: unknown; targetRate: number }[],
  /** awaited before each TTS chunk / synthesize */
  ttsGate: (_signal?: AbortSignal): Promise<void> => Promise.resolve(),
  /** awaited inside transcribe call #index */
  sttGate: (_index: number, _signal?: AbortSignal): Promise<void> => Promise.resolve(),
  /** awaited by MicRecorder.start (the permission prompt) */
  micGate: (): Promise<void> => Promise.resolve(),
  reset(): void {
    this.autoResolve = true;
    this.failNext = 0;
    this.loads = [];
    this.players = [];
    this.recorders = [];
    this.wavCalls = [];
    this.decodeCalls = [];
    this.ttsGate = () => Promise.resolve();
    this.sttGate = () => Promise.resolve();
    this.micGate = () => Promise.resolve();
  },
};

/** a gate that waits for `d` but rejects when `signal` aborts (like a real model call) */
export function abortable(d: Deferred<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return d.promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
    d.promise.then(resolve, reject);
  });
}
