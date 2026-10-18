// AntaliaMini: Turkish text to speech (Antalia-2 Mini, 48 kHz) from a .cpet pack.
//
//   const tts = await AntaliaMini.load("packs/antalia-mini-mixed.cpet");
//   const { audio, sampleRate } = await tts.synthesize("Merhaba, nasılsınız?");
//   for await (const chunk of tts.stream(longText)) player.push(chunk.audio);   // first sentence first

import type { PackSource } from "../pack/types.js";
import type { LoadOptions, ModelInfo, SpeechChunk, SynthesisOptions, SynthesisResult, SynthesisTimings } from "../types.js";
import { openPack } from "../pack/reader.js";
import type { Pack } from "../pack/reader.js";
import { initRuntime } from "../runtime/ort.js";
import { SerialQueue } from "../util/queue.js";
import { now } from "../util/time.js";
import { Engine, SAMPLE_RATE, abortError, speak } from "./engine.js";
import { cleanModelText, frontendFromPack } from "./frontend.js";
import type { Frontend } from "./frontend.js";

export { SAMPLE_RATE as ANTALIA_SAMPLE_RATE } from "./engine.js";

const MODEL_ID = "antalia-mini";
const TASK = "text-to-speech";
/** what load() synthesises once, as the reference worker does: the first run of each graph allocates and
 * picks kernels, so the first real sentence is not slow */
const WARMUP_TEXT = "Merhaba, 15 Ekim'de 1.250 TL.";

export interface AntaliaDefaults {
  steps: number;
  cfg: number;
  speed: number;
  temperature: number;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function checkPack(pack: Pack): void {
  const { id, task, variant } = pack.model;
  if (id !== MODEL_ID || task !== TASK) {
    throw new Error(
      `cipetpet: AntaliaMini.load needs an "${MODEL_ID}" (${TASK}) pack, but this pack holds "${id}" (${task}, variant "${variant}")` +
        (id === "duyu-small" ? "; load it with DuyuSmall instead" : ""),
    );
  }
}

/** Throws a clear error for a malformed option; undefined options take the release's defaults. */
function checkOptions(opts: SynthesisOptions): void {
  if (opts === null || typeof opts !== "object") throw new TypeError("cipetpet: synthesis options must be an object");
  const num = (name: keyof SynthesisOptions, ok: (v: number) => boolean, what: string) => {
    const v = opts[name];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new TypeError(`cipetpet: options.${name} must be a finite number, got ${String(v)}`);
    if (!ok(v)) throw new RangeError(`cipetpet: options.${name} must be ${what}, got ${v}`);
  };
  num("seed", Number.isSafeInteger, "an integer");
  num("steps", (v) => Number.isInteger(v) && v >= 1, "an integer >= 1");
  num("cfg", () => true, "a number");
  num("speed", (v) => v > 0, "> 0");
  num("temperature", (v) => v >= 0, ">= 0");
  if (opts.raw !== undefined && typeof opts.raw !== "boolean") throw new TypeError("cipetpet: options.raw must be a boolean");
  if (opts.signal != null && !(typeof opts.signal === "object" && "aborted" in opts.signal)) {
    throw new TypeError("cipetpet: options.signal must be an AbortSignal");
  }
}

/** Antalia-2 Mini text to speech. Calls on one instance run one at a time (ORT sessions must not run two
 * inferences at once); a stream holds the instance while it is being iterated. */
export class AntaliaMini {
  readonly info: ModelInfo;
  /** the release's synthesis defaults (model/manifest.json) */
  readonly defaults: Readonly<AntaliaDefaults>;
  readonly #engine: Engine;
  readonly #frontend: Frontend;
  readonly #queue = new SerialQueue();
  #disposing: Promise<void> | undefined;

  private constructor(engine: Engine, frontend: Frontend, info: ModelInfo) {
    this.#engine = engine;
    this.#frontend = frontend;
    this.info = info;
    const { steps, cfg, speed, temperature } = engine.defaults;
    this.defaults = Object.freeze({ steps, cfg, speed, temperature });
  }

  /** Opens the pack (URL, bytes, Blob or Pack), starts ONNX Runtime, builds the four sessions and the text
   * frontend, and runs one short warm-up synthesis. */
  static async load(source: PackSource, opts: LoadOptions = {}): Promise<AntaliaMini> {
    const t0 = now();
    const pack = await openPack(source, opts);
    checkPack(pack);
    const t1 = now();
    checkAbort(opts.signal);

    const runtime = await initRuntime(opts, pack);
    checkAbort(opts.signal);
    const [engineR, frontendR] = await Promise.allSettled([Engine.create(runtime, pack), frontendFromPack(pack)]);
    if (engineR.status === "rejected" || frontendR.status === "rejected") {
      if (engineR.status === "fulfilled") await engineR.value.release();
      throw engineR.status === "rejected" ? engineR.reason : (frontendR as PromiseRejectedResult).reason;
    }
    const engine = engineR.value, frontend = frontendR.value;
    try {
      checkAbort(opts.signal);
      for await (const _ of speak(engine, frontend.modelText(WARMUP_TEXT), { steps: 1, signal: opts.signal }));
    } catch (e) {
      await engine.release();
      throw e;
    }

    const info: ModelInfo = {
      ...pack.model,
      sampleRate: SAMPLE_RATE,
      backend: runtime.backend,
      threads: runtime.threads,
      crossOriginIsolated: runtime.crossOriginIsolated,
      packBytes: pack.byteLength,
      loadMs: { fetch: t1 - t0, init: now() - t1 },
      onnxruntime: runtime.version,
    };
    return new AntaliaMini(engine, frontend, info);
  }

  /** Raw Turkish text -> the model text the voice reads (numbers, dates, abbreviations, foreign words
   * spelled out; lowercase). Never throws on text: if the normaliser fails it reads the text as written. */
  normalize(text: string): string {
    this.#checkUsable();
    if (typeof text !== "string") throw new TypeError("cipetpet: text must be a string");
    return this.#frontend.modelText(text);
  }

  /** The whole utterance as one buffer (the stream's chunks joined, pauses included). */
  async synthesize(text: string, opts: SynthesisOptions = {}): Promise<SynthesisResult> {
    const timings: SynthesisTimings = { normalize: 0, text: 0, cond: 0, flow: 0, vocoder: 0, istft: 0, post: 0 };
    const run = { modelText: "", start: 0 };
    const parts: Float32Array[] = [];
    let samples = 0;
    for await (const c of this.#generate(text, opts, run)) {
      for (const k of Object.keys(c.timings) as (keyof SynthesisTimings)[]) timings[k] += c.timings[k] ?? 0;
      parts.push(c.audio);
      samples += c.audio.length;
    }
    const computeMs = run.start ? now() - run.start : 0;
    const audio = new Float32Array(samples);
    let off = 0;
    for (const p of parts) { audio.set(p, off); off += p.length; }
    const seconds = samples / SAMPLE_RATE;
    return {
      audio,
      sampleRate: SAMPLE_RATE,
      modelText: run.modelText,
      // rtf: compute time / audio time (below 1 is faster than real time)
      stats: { computeMs, seconds, chunks: parts.length, rtf: seconds ? computeMs / 1000 / seconds : 0, timings },
    };
  }

  /** Audio chunk by chunk, first sentence first (the first chunk is short so playback can start early).
   * The instance is held until the iteration ends; leaving a `for await` loop early (break, throw) releases
   * it. An iterator that is neither finished nor returned keeps later calls waiting. */
  stream(text: string, opts: SynthesisOptions = {}): AsyncGenerator<SpeechChunk, void, undefined> {
    return this.#generate(text, opts);
  }

  /** Releases the ONNX Runtime sessions once the calls already queued have finished. Later calls throw. */
  dispose(): Promise<void> {
    this.#disposing ??= this.#queue.run(() => this.#engine.release());
    return this.#disposing;
  }

  #checkUsable(): void {
    if (this.#disposing) throw new Error("cipetpet: this AntaliaMini has been disposed");
  }

  async *#generate(text: string, opts: SynthesisOptions, run?: { modelText: string; start: number }): AsyncGenerator<SpeechChunk, void, undefined> {
    this.#checkUsable();
    if (typeof text !== "string") throw new TypeError("cipetpet: text must be a string");
    checkOptions(opts);
    const { signal, seed, steps, cfg, speed, temperature } = opts;
    checkAbort(signal);
    const release = await this.#acquire(signal);
    try {
      checkAbort(signal);
      const t0 = now();
      // raw: the caller's text is model text already; it is only cleaned of characters the model lacks
      const modelText = opts.raw ? cleanModelText(text) : this.#frontend.modelText(text);
      const normalize = now() - t0;
      if (run) { run.modelText = modelText; run.start = t0; }
      for await (const c of speak(this.#engine, modelText, { seed, steps, cfg, speed, temperature, signal })) {
        yield { audio: c.audio, index: c.index, count: c.count, text: c.text, timings: c.index === 0 ? { normalize, ...c.timings } : c.timings };
      }
    } finally {
      release();
    }
  }

  /** Waits for this instance's turn and returns the function that ends it. An abort while waiting rejects
   * at once; the turn, when it comes, is then handed straight on. */
  #acquire(signal: AbortSignal | undefined): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => void this.#queue.run(() => (r(), held)));
    if (!signal) return ready.then(() => release);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        void ready.then(release);
        reject(abortError(signal));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      void ready.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(release);
      });
    });
  }
}
