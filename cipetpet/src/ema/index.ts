// EmaLightning: Turkish text to speech (EMA Lightning, 8.6M parameters, 48 kHz) from a .cpet pack.
//
//   const tts = await EmaLightning.load("packs/ema-lightning-fp32.cpet");
//   const { audio, sampleRate } = await tts.synthesize("Merhaba, nasılsınız?");
//   for await (const chunk of tts.stream(longText)) player.push(chunk.audio);   // the first second comes first
//
// The same API as AntaliaMini (SynthesisOptions in, SpeechChunk / SynthesisResult out), so either model can sit
// behind one text-to-speech interface. EMA has no steps / cfg / temperature: those options are accepted and ignored.

import type { PackSource } from "../pack/types.js";
import type { LoadOptions, ModelInfo, SpeechChunk, SynthesisOptions, SynthesisResult, SynthesisTimings } from "../types.js";
import { openPack } from "../pack/reader.js";
import type { Pack } from "../pack/reader.js";
import { initRuntime } from "../runtime/ort.js";
import { SerialQueue } from "../util/queue.js";
import { now } from "../util/time.js";
import { Engine, Frontend, NORMALIZER_ENTRY, configFromPack } from "./engine.js";
import { TurkishNormalizer } from "./normalizer.js";

const MODEL_ID = "ema-lightning";
const TASK = "text-to-speech";
/** what load() synthesises once: the first run of each graph allocates and picks kernels */
const WARMUP_TEXT = "Merhaba.";
export const EMA_SPEED_RANGE = [0.25, 4] as const;

export interface EmaDefaults {
  speed: number;
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new DOMException("The operation was aborted.", "AbortError");
  if (reason !== undefined) Object.defineProperty(err, "cause", { value: reason, configurable: true, writable: true });
  return err;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function checkPack(pack: Pack): void {
  const { id, task, variant } = pack.model;
  if (id !== MODEL_ID || task !== TASK) {
    throw new Error(
      `cipetpet: EmaLightning.load needs an "${MODEL_ID}" (${TASK}) pack, but this pack holds "${id}" (${task}, variant "${variant}")` +
        (id === "antalia-mini" ? "; load it with AntaliaMini instead" : id === "duyu-small" ? "; load it with DuyuSmall instead" : ""),
    );
  }
}

/** Throws a clear error for a malformed option. steps / cfg / temperature are Antalia's: checked, not used. */
function checkOptions(opts: SynthesisOptions): void {
  if (opts === null || typeof opts !== "object") throw new TypeError("cipetpet: synthesis options must be an object");
  const num = (name: keyof SynthesisOptions, ok: (v: number) => boolean, what: string) => {
    const v = opts[name];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new TypeError(`cipetpet: options.${name} must be a finite number, got ${String(v)}`);
    if (!ok(v)) throw new RangeError(`cipetpet: options.${name} must be ${what}, got ${v}`);
  };
  num("seed", Number.isSafeInteger, "an integer");
  num("speed", (v) => v >= EMA_SPEED_RANGE[0] && v <= EMA_SPEED_RANGE[1], `from ${EMA_SPEED_RANGE[0]} to ${EMA_SPEED_RANGE[1]} for EMA Lightning`);
  num("steps", () => true, "a number");
  num("cfg", () => true, "a number");
  num("temperature", () => true, "a number");
  if (opts.raw !== undefined && typeof opts.raw !== "boolean") throw new TypeError("cipetpet: options.raw must be a boolean");
  if (opts.signal != null && !(typeof opts.signal === "object" && "aborted" in opts.signal)) {
    throw new TypeError("cipetpet: options.signal must be an AbortSignal");
  }
}

/** EMA Lightning text to speech. Calls on one instance run one at a time (ORT sessions must not run two
 * inferences at once); a stream holds the instance while it is being iterated. */
export class EmaLightning {
  readonly info: ModelInfo;
  readonly defaults: Readonly<EmaDefaults> = Object.freeze({ speed: 1 });
  readonly #engine: Engine;
  readonly #frontend: Frontend;
  readonly #normalizer: TurkishNormalizer;
  readonly #queue = new SerialQueue();
  #disposing: Promise<void> | undefined;

  private constructor(engine: Engine, frontend: Frontend, normalizer: TurkishNormalizer, info: ModelInfo) {
    this.#engine = engine;
    this.#frontend = frontend;
    this.#normalizer = normalizer;
    this.info = info;
  }

  /** Opens the pack (URL, bytes, Blob or Pack), starts ONNX Runtime and normalizer-tr's WebAssembly, builds the
   * three sessions and runs one short warm-up synthesis. */
  static async load(source: PackSource, opts: LoadOptions = {}): Promise<EmaLightning> {
    const t0 = now();
    const pack = await openPack(source, opts);
    checkPack(pack);
    const t1 = now();
    checkAbort(opts.signal);

    const config = await configFromPack(pack);
    const runtime = await initRuntime(opts, pack);
    checkAbort(opts.signal);
    const [engineR, normalizerR] = await Promise.allSettled([
      Engine.create(runtime, pack, config),
      pack.bytes(NORMALIZER_ENTRY).then((bytes) => TurkishNormalizer.create(bytes)),
    ]);
    if (engineR.status === "rejected" || normalizerR.status === "rejected") {
      if (engineR.status === "fulfilled") await engineR.value.release();
      if (normalizerR.status === "fulfilled") normalizerR.value.free();
      throw engineR.status === "rejected" ? engineR.reason : (normalizerR as PromiseRejectedResult).reason;
    }
    const engine = engineR.value, normalizer = normalizerR.value;
    const frontend = new Frontend(config.vocab, (text) => normalizer.normalize(text));
    try {
      checkAbort(opts.signal);
      for await (const _ of engine.stream(frontend.run(WARMUP_TEXT), 1, 0, opts.signal));
    } catch (e) {
      await engine.release();
      normalizer.free();
      throw e;
    }

    const info: ModelInfo = {
      ...pack.model,
      sampleRate: engine.sampleRate,
      backend: runtime.backend,
      threads: runtime.threads,
      crossOriginIsolated: runtime.crossOriginIsolated,
      packBytes: pack.byteLength,
      loadMs: { fetch: t1 - t0, init: now() - t1 },
      onnxruntime: runtime.version,
    };
    return new EmaLightning(engine, frontend, normalizer, info);
  }

  /** Raw Turkish text -> the model text the voice reads (normalizer-tr reads numbers, dates, money, units and
   * abbreviations out; lowercase, the model's alphabet only). Never throws on text: if the normaliser fails it
   * reads the text as written. */
  normalize(text: string): string {
    this.#checkUsable();
    if (typeof text !== "string") throw new TypeError("cipetpet: text must be a string");
    return this.#frontend.run(text);
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
    const sampleRate = this.info.sampleRate;
    const seconds = samples / sampleRate;
    return {
      audio,
      sampleRate,
      modelText: run.modelText,
      // rtf: compute time / audio time (below 1 is faster than real time)
      stats: { computeMs, seconds, chunks: parts.length, rtf: seconds ? computeMs / 1000 / seconds : 0, timings },
    };
  }

  /** Audio chunk by chunk: one second first, then up to four seconds at a time (one chunk per decoded window, so
   * several chunks share a piece's `index`; the last one of a piece carries the pause after it). Timings map EMA's
   * graphs onto SynthesisTimings: text.onnx -> `text`, sound.onnx -> `flow`, decoder.onnx -> `vocoder`.
   * The instance is held until the iteration ends; leaving a `for await` loop early (break, throw) releases it. */
  stream(text: string, opts: SynthesisOptions = {}): AsyncGenerator<SpeechChunk, void, undefined> {
    return this.#generate(text, opts);
  }

  /** Releases the ONNX Runtime sessions and the normaliser once the calls already queued have finished. Later
   * calls throw. */
  dispose(): Promise<void> {
    this.#disposing ??= this.#queue.run(async () => {
      await this.#engine.release();
      this.#normalizer.free();
    });
    return this.#disposing;
  }

  #checkUsable(): void {
    if (this.#disposing) throw new Error("cipetpet: this EmaLightning has been disposed");
  }

  async *#generate(text: string, opts: SynthesisOptions, run?: { modelText: string; start: number }): AsyncGenerator<SpeechChunk, void, undefined> {
    this.#checkUsable();
    if (typeof text !== "string") throw new TypeError("cipetpet: text must be a string");
    checkOptions(opts);
    const { signal, seed = 0, speed = this.defaults.speed } = opts;
    checkAbort(signal);
    const release = await this.#acquire(signal);
    try {
      checkAbort(signal);
      const t0 = now();
      // raw: the caller's text is model text already; it is only folded into the model's alphabet
      const modelText = opts.raw ? this.#frontend.alphabet(text) : this.#frontend.run(text);
      const normalize = now() - t0;
      if (run) { run.modelText = modelText; run.start = t0; }
      let first = true;
      for await (const c of this.#engine.stream(modelText, speed, seed, signal)) {
        const timings: Partial<SynthesisTimings> = { vocoder: c.timings.decoder };
        if (c.timings.text !== undefined) timings.text = c.timings.text;
        if (c.timings.sound !== undefined) timings.flow = c.timings.sound;
        if (first) timings.normalize = normalize;
        first = false;
        yield { audio: c.audio, index: c.index, count: c.count, text: c.text, timings };
      }
    } catch (e) {
      throw signal?.aborted ? abortError(signal) : e;
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
