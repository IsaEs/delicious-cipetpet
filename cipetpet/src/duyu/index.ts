// Duyu-small speech recognition (Turkish + English, 16 kHz) on ONNX Runtime Web: a port of the Python
// engine duyu_small/model.py on top of a .cpet pack.
//
//   audio -> resample to 16 kHz -> chunks (<= 30 s) -> per chunk: 0.4 s tail pad -> fbank
//         -> encoder_pre -> encoder_pass x3 (gated refinement) -> encoder_post (CTC log-probs)
//         -> attention beam search with CTC rescoring (or CTC greedy) -> SentencePiece decode

import type * as OrtNS from "onnxruntime-web";
import type { DuyuLanguage, LoadOptions, ModelInfo, TranscribeOptions, TranscriptionResult } from "../types.js";
import type { PackSource } from "../pack/types.js";
import { openPack } from "../pack/reader.js";
import type { Pack } from "../pack/reader.js";
import { initRuntime } from "../runtime/ort.js";
import type { Runtime } from "../runtime/ort.js";
import { resample } from "../audio/resample.js";
import { SerialQueue } from "../util/queue.js";
import { checkAbort, runQueued, throwIfAborted } from "../util/abort.js";
import { now } from "../util/time.js";
import { Fbank } from "./fbank.js";
import type { Features } from "./fbank.js";
import { ctcGreedyIds } from "./ctc.js";
import { BeamSearch, controlIds } from "./beam.js";
import type { Special } from "./beam.js";
import { SentencePieceDecoder, pyStrip } from "./tokenizer.js";
import type { PiecesJson } from "./tokenizer.js";
import { chunkBounds } from "./chunks.js";

export const SAMPLE_RATE = 16000;
/** push-to-talk recordings end on the last word: trailing silence for the decoder (model.py TAIL_PAD_S) */
export const TAIL_PAD_S = 0.4;

const MODEL_ID = "duyu-small";
const LANGS: readonly DuyuLanguage[] = ["tr", "en", "mix", "auto"];

/** model/engine.json */
interface EngineJson extends Special {
  max_positions: number;
  vocab_size: number;
  d_model: number;
}

type Session = OrtNS.InferenceSession;

interface Graphs {
  pre: Session;
  pass: Session;
  post: Session;
  /** absent in a CTC-only pack: transcription then always uses CTC greedy */
  dec: Session | null;
}

/** DuyuSmall.encode() result */
export interface EncoderOutput {
  /** encoder states [frames, dim] */
  h: Float32Array;
  /** CTC log-probabilities [frames, vocab] */
  logp: Float32Array;
  frames: number;
  dim: number;
  vocab: number;
}

export interface Encoded {
  /** encoder output [1, Tp, d] */
  h: Float32Array;
  /** CTC log-probs [Tp, V] */
  logp: Float32Array;
  T: number;
}

export interface GraphOutput {
  data: Float32Array;
  dims: readonly number[];
}

/** runs one encoder graph on a float32 input of shape `dims` */
export type RunEncoderGraph = (graph: "pre" | "pass" | "post", data: Float32Array, dims: number[]) => Promise<GraphOutput>;

/**
 * The encoder chain of model.py `encode` after the fbank: encoder_pre, then the shared refinement passes
 *     y = pass(x_in + pass_embed[p]);   x = y if p == 0 else x_in + gates[p] * (y - x_in)
 * in float32 elementwise math like numpy's, then encoder_post. Null when encoder_pre yields no frames.
 * (Exported so the parity test can drive it with the Python engine's recorded graph outputs.)
 */
export async function runEncoder(feats: Features, gates: Float32Array, embed: Float32Array, run: RunEncoderGraph): Promise<Encoded | null> {
  let x = await run("pre", feats.data, [1, feats.frames, 160]);
  const [, T, d] = x.dims;
  if (T === 0) return null;
  for (let p = 0; p < gates.length; p++) {
    const xin = x.data;
    const inp = new Float32Array(xin.length);
    for (let i = 0; i < xin.length; i++) inp[i] = xin[i] + embed[p * d + (i % d)];
    const y = await run("pass", inp, [1, T, d]);
    if (p === 0) {
      x = y;
    } else {
      // every float32 op rounds: fround(a op b) is exactly the float32 result
      const g = gates[p];
      const next = new Float32Array(xin.length);
      for (let i = 0; i < xin.length; i++) next[i] = xin[i] + Math.fround(g * Math.fround(y.data[i] - xin[i]));
      x = { data: next, dims: x.dims };
    }
  }
  const logp = await run("post", x.data, [1, T, d]);
  return { h: x.data, logp: logp.data, T };
}

interface ChunkResult {
  ids: number[];
  /** language id the decoder used, or null in CTC mode */
  lang: number | null;
}

export class DuyuSmall {
  readonly info: ModelInfo;
  readonly #rt: Runtime;
  readonly #g: Graphs;
  readonly #fbank: Fbank;
  readonly #gates: Float32Array;
  readonly #embed: Float32Array;
  readonly #tok: SentencePieceDecoder;
  readonly #eng: EngineJson;
  readonly #drop: Set<number>;
  readonly #queue = new SerialQueue();
  #disposed = false;

  private constructor(
    info: ModelInfo,
    rt: Runtime,
    g: Graphs,
    fbank: Fbank,
    gates: Float32Array,
    embed: Float32Array,
    tok: SentencePieceDecoder,
    eng: EngineJson,
  ) {
    this.info = info;
    this.#rt = rt;
    this.#g = g;
    this.#fbank = fbank;
    this.#gates = gates;
    this.#embed = embed;
    this.#tok = tok;
    this.#eng = eng;
    this.#drop = new Set([eng.pad, eng.bos, eng.eos, ...controlIds(eng)]);
  }

  /** Opens a Duyu-small pack, starts ONNX Runtime, creates the sessions and warms them up. */
  static async load(source: PackSource, opts: LoadOptions = {}): Promise<DuyuSmall> {
    const t0 = now();
    const pack = await openPack(source, opts);
    const tFetch = now() - t0;
    const t1 = now();
    const { id, name, variant } = pack.model;
    if (id !== MODEL_ID) {
      throw new Error(`cipetpet: DuyuSmall.load needs a "${MODEL_ID}" pack, got "${id}" (${name} ${variant})`);
    }
    throwIfAborted(opts.signal);
    const rt = await initRuntime(opts, pack);

    const sessions: Session[] = [];
    const session = async (graph: string): Promise<Session> => {
      throwIfAborted(opts.signal);
      const s = await rt.createSession(await pack.bytes(`graphs/${graph}.onnx`), `${MODEL_ID}/${graph}`);
      sessions.push(s);
      return s;
    };
    try {
      const g: Graphs = {
        pre: await session("encoder_pre"),
        pass: await session("encoder_pass"),
        post: await session("encoder_post"),
        dec: pack.has("graphs/decoder.onnx") ? await session("decoder") : null,
      };
      const [win, mel, gates, embed, pieces, eng] = await Promise.all([
        pack.tensor<Float32Array>("tables/fbank_window"),
        pack.tensor<Float32Array>("tables/fbank_mel"),
        pack.tensor<Float32Array>("tables/pass_gates"),
        pack.tensor<Float32Array>("tables/pass_embed"),
        pack.json<PiecesJson>("tokenizer/pieces.json"),
        pack.json<EngineJson>("model/engine.json"),
      ]);
      checkTables(pack, eng, gates.shape, embed.shape, win.dtype, mel.dtype);
      const tok = new SentencePieceDecoder(pieces);
      if (tok.size !== eng.vocab_size) throw new Error(`cipetpet: ${packName(pack)}: tokenizer has ${tok.size} pieces, engine.json says ${eng.vocab_size}`);

      const info: ModelInfo = {
        ...pack.model,
        sampleRate: SAMPLE_RATE,
        backend: rt.backend,
        threads: rt.threads,
        crossOriginIsolated: rt.crossOriginIsolated,
        packBytes: pack.byteLength,
        loadMs: { fetch: tFetch, init: 0 },
        onnxruntime: rt.version,
      };
      const model = new DuyuSmall(info, rt, g, new Fbank(win.data, mel.data), gates.data, embed.data, tok, eng);
      // Warm-up: the first run of each session pays for kernel preparation; do it before the user waits.
      await model.#transcribe(new Float32Array(SAMPLE_RATE), resolveOptions({ signal: opts.signal }));
      info.loadMs.init = now() - t1;
      return model;
    } catch (e) {
      await Promise.allSettled(sessions.map((s) => s.release()));
      throw e;
    }
  }

  /**
   * Transcribes mono audio of any length. Calls on one instance run one at a time, in call order.
   * The input is copied when the call is made, so the caller may reuse its buffer right away.
   */
  transcribe(audio: Float32Array, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    let o: Resolved;
    try {
      if (!(audio instanceof Float32Array)) throw new TypeError("cipetpet: transcribe() needs a Float32Array of samples");
      o = resolveOptions(opts);
      this.#checkAlive();
    } catch (e) {
      return Promise.reject(e);
    }
    const copy = audio.slice();
    return runQueued(this.#queue, o.signal, () => {
      this.#checkAlive();
      return this.#transcribe(copy, o);
    });
  }

  /**
   * The encoder alone (model.py `encode`), for one utterance of 16 kHz audio as given (no resampling,
   * chunking or tail pad): `h` [frames, dim] is what the decoder attends to, `logp` [frames, vocab] the
   * CTC log-probabilities (25 frames per second). frames is 0 for audio too short to give one frame.
   */
  encode(audio: Float32Array, opts: { signal?: AbortSignal } = {}): Promise<EncoderOutput> {
    if (!(audio instanceof Float32Array)) return Promise.reject(new TypeError("cipetpet: encode() needs a Float32Array of samples"));
    const copy = audio.slice();
    return runQueued(this.#queue, opts.signal, async () => {
      this.#checkAlive();
      const V = this.#eng.vocab_size;
      const d = this.#eng.d_model;
      const enc = await this.#encode(copy, opts.signal);
      if (!enc) return { h: new Float32Array(0), logp: new Float32Array(0), frames: 0, dim: d, vocab: V };
      return { h: enc.h, logp: enc.logp, frames: enc.T, dim: enc.h.length / enc.T, vocab: V };
    });
  }

  /** Releases the sessions once the queued calls have finished. */
  dispose(): Promise<void> {
    return this.#queue.run(async () => {
      if (this.#disposed) return;
      this.#disposed = true;
      const { pre, pass, post, dec } = this.#g;
      await Promise.allSettled([pre, pass, post, dec].filter((s): s is Session => s !== null).map((s) => s.release()));
    });
  }

  #checkAlive(): void {
    if (this.#disposed) throw new Error("cipetpet: this DuyuSmall instance has been disposed");
  }

  async #transcribe(audio: Float32Array, o: Resolved): Promise<TranscriptionResult> {
    const t0 = now();
    throwIfAborted(o.signal);
    const seconds = audio.length / o.sampleRate;
    const wav = o.sampleRate === SAMPLE_RATE ? audio : resample(audio, o.sampleRate, SAMPLE_RATE);
    const ctc = o.mode === "ctc" || this.#g.dec === null;
    const timing = { encoderMs: 0, decoderMs: 0 };
    const tail = o.tailPad ? Math.trunc(TAIL_PAD_S * SAMPLE_RATE) : 0;

    const segments: TranscriptionResult["segments"] = [];
    let langId: number | null = null;
    const bounds = chunkBounds(wav, { sampleRate: SAMPLE_RATE });
    for (const [i, [start, end]] of bounds.entries()) {
      let x = wav.subarray(start, end);
      if (tail) {
        const padded = new Float32Array(x.length + tail);
        padded.set(x);
        x = padded;
      }
      const r = await this.#utterance(x, o, ctc, timing);
      if (i === 0) langId = r.lang;
      const text = this.#decodeText(r.ids);
      segments.push({ text, start: start / SAMPLE_RATE, end: end / SAMPLE_RATE, tokens: r.ids });
    }

    const computeMs = now() - t0;
    return {
      text: segments.map((s) => s.text).filter((t) => t).join(" "),
      lang: langId !== null ? this.#langName(langId) : o.lang === "auto" ? "mix" : o.lang,
      segments,
      stats: {
        seconds,
        computeMs,
        rtf: seconds > 0 ? computeMs / 1000 / seconds : 0,
        chunks: bounds.length,
        mode: ctc ? "ctc" : "attn",
        encoderMs: timing.encoderMs,
        decoderMs: timing.decoderMs,
      },
    };
  }

  /** One chunk (model.py transcribe_utterance, after the tail pad). */
  async #utterance(x: Float32Array, o: Resolved, ctc: boolean, timing: { encoderMs: number; decoderMs: number }): Promise<ChunkResult> {
    const te = now();
    const enc = await this.#encode(x, o.signal);
    timing.encoderMs += now() - te;
    // Fewer than two fbank frames (only possible without the tail pad): nothing to recognise.
    if (!enc) return { ids: [], lang: null };
    const V = this.#eng.vocab_size;
    if (ctc) return { ids: ctcGreedyIds(enc.logp, enc.T, V, this.#eng.pad), lang: null };

    const td = now();
    const { ort } = this.#rt;
    const dec = this.#g.dec!;
    const d = enc.h.length / enc.T;
    // h stays batch 1: the graph broadcasts it over the K beams (as model.py does)
    const memory = new ort.Tensor("float32", enc.h, [1, enc.T, d]);
    try {
      const search = new BeamSearch(
        async (tokens, K, L) => {
          await checkAbort(o.signal);
          const tt = new ort.Tensor("int64", tokens, [K, L]);
          let out: OrtNS.InferenceSession.OnnxValueMapType | undefined;
          try {
            out = await dec.run({ tokens: tt, memory });
            const logits = out.logits.data as Float32Array;
            // only the last position of [K, L, V] is needed
            const last = new Float32Array(K * V);
            for (let k = 0; k < K; k++) last.set(logits.subarray((k * L + L - 1) * V, (k * L + L) * V), k * V);
            return last;
          } finally {
            tt.dispose();
            for (const t of Object.values(out ?? {})) t.dispose();
          }
        },
        this.#eng,
        this.#eng.max_positions,
        V,
      );
      const lang = o.lang === "auto" ? null : o.lang;
      return await search.search(enc.logp, enc.T, { beam: o.beam, lang, ctcWeight: o.ctcWeight });
    } finally {
      memory.dispose();
      timing.decoderMs += now() - td;
    }
  }

  /** model.py encode: fbank -> encoder graphs. Null when there are no frames. */
  async #encode(wav: Float32Array, signal?: AbortSignal): Promise<Encoded | null> {
    const { ort } = this.#rt;
    const feats = this.#fbank.compute(wav);
    if (feats.frames === 0) return null;
    const io = { pre: ["feats", "x"], pass: ["x", "y"], post: ["x", "log_probs"] } as const;
    return runEncoder(feats, this.#gates, this.#embed, async (graph, data, dims) => {
      await checkAbort(signal);
      const [inName, outName] = io[graph];
      const input = new ort.Tensor("float32", data, dims);
      try {
        const out = await this.#g[graph].run({ [inName]: input });
        // keep the data (a JS-owned copy for CPU tensors), release everything else
        const res: GraphOutput = { data: out[outName].data as Float32Array, dims: out[outName].dims };
        for (const v of Object.values(out)) v.dispose();
        return res;
      } finally {
        input.dispose();
      }
    });
  }

  /** model.py decode_ids: drop pad / BOS / EOS / control ids, SentencePiece decode, strip */
  #decodeText(ids: readonly number[]): string {
    return pyStrip(this.#tok.decode(ids.filter((i) => !this.#drop.has(i))));
  }

  #langName(id: number): string {
    for (const [name, v] of Object.entries(this.#eng.lang)) if (v === id) return name;
    return String(id);
  }
}

interface Resolved {
  sampleRate: number;
  lang: DuyuLanguage;
  mode: "auto" | "ctc";
  beam: number;
  tailPad: boolean;
  ctcWeight: number;
  signal?: AbortSignal;
}

function resolveOptions(opts: TranscribeOptions): Resolved {
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`cipetpet: sampleRate must be a finite number > 0, got ${String(sampleRate)}`);
  }
  const lang = opts.lang ?? "mix";
  if (!LANGS.includes(lang)) throw new RangeError(`cipetpet: lang must be one of ${LANGS.join(", ")}, got "${String(lang)}"`);
  const mode = opts.mode ?? "auto";
  if (mode !== "auto" && mode !== "ctc") throw new RangeError(`cipetpet: mode must be "auto" or "ctc", got "${String(mode)}"`);
  const beam = opts.beam ?? 5;
  if (!Number.isInteger(beam) || beam < 1) throw new RangeError(`cipetpet: beam must be an integer >= 1, got ${String(beam)}`);
  const ctcWeight = opts.ctcWeight ?? 0.3;
  if (typeof ctcWeight !== "number" || !(ctcWeight >= 0 && ctcWeight <= 1)) {
    throw new RangeError(`cipetpet: ctcWeight must be in [0, 1], got ${String(ctcWeight)}`);
  }
  return { sampleRate, lang, mode, beam, tailPad: opts.tailPad ?? true, ctcWeight, signal: opts.signal };
}

function packName(pack: Pack): string {
  return `${pack.model.id}-${pack.model.variant}`;
}

function checkTables(pack: Pack, eng: EngineJson, gates: number[], embed: number[], ...dtypes: string[]): void {
  const bad = (msg: string) => new Error(`cipetpet: ${packName(pack)}: ${msg}`);
  for (const k of ["pad", "bos", "eos", "unk", "max_positions", "vocab_size", "d_model"] as const) {
    if (!Number.isInteger(eng[k])) throw bad(`model/engine.json has no integer "${k}"`);
  }
  if (!eng.lang || !eng.style || !Object.keys(eng.lang).every((l) => LANGS.includes(l as DuyuLanguage))) {
    throw bad("model/engine.json has no valid lang / style maps");
  }
  if (!("cased" in eng.style)) throw bad('model/engine.json has no "cased" style');
  if (gates.length !== 1 || embed.length !== 2 || embed[0] !== gates[0] || embed[1] !== eng.d_model) {
    throw bad(`refinement tables do not fit: pass_gates [${gates}], pass_embed [${embed}], d_model ${eng.d_model}`);
  }
  if (dtypes.some((t) => t !== "float32")) throw bad("fbank tables are not float32");
}
