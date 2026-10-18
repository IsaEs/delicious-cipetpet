// TS port of ema-lightning-web's src/core.js (itself the Python package's frontend.py, chunker.py and engine.py),
// on top of Runtime + Pack. Behaviour must stay identical to that file: the same graphs, text, seed and speed give
// the same audio, bit for bit (test/ema.test.ts checks it against core.js when ../ema-lightning-web is there).
//
// Three graphs: text.onnx (letters -> features h and durations), sound.onnx (features + a frame timeline +
// seeded noise -> latents, `steps` flow steps inside the graph), decoder.onnx (latents -> 48 kHz audio, decoded
// in windows with CONTEXT frames of context on each side).

import type * as OrtNS from "onnxruntime-web";
import type { Pack } from "../pack/reader.js";
import type { Runtime } from "../runtime/ort.js";
import { checkAbort } from "../util/abort.js";
import { now } from "../util/time.js";

const FIRST_WINDOW = 25; // a stream's first window is one second, so its first audio comes fast
const WINDOW = 100; // four seconds for every later window
const CONTEXT = 8; // frames decoded on each side of a window; the decoder reaches 4
const MAX_WORD_FRAMES = 250;
const MAX_FRAMES = 3000;

export const GRAPHS = ["text", "sound", "decoder"] as const;
export const CONFIG_ENTRY = "model/config.json";
export const NORMALIZER_ENTRY = "frontend/normalizer.wasm";

/** model/config.json, written by ema-lightning-web's export_onnx.py. */
export interface EmaConfig {
  vocab: string[];
  latent_dim: number;
  steps: number;
  hop: number;
  sample_rate: number;
  fps: number;
}

// ----------------------------------------------------------------------------------- frontend.py
const BLOCK_BYTES = 8 * 1024;
const TURKISH = new Set("çğıöşüÇĞİÖŞÜ");
const TYPOGRAPHY: Record<string, string> = {
  "’": "'", "‘": "'", "ʼ": "'", "´": "'", "`": "'", "“": '"', "”": '"', "„": '"',
  "«": '"', "»": '"', "–": "-", "—": "-", "−": "-", "…": "...",
};
const TYPOGRAPHY_CHARS = new RegExp(`[${Object.keys(TYPOGRAPHY).join("")}]`, "g");
const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const COMBINING = /\p{M}/gu;

export class Frontend {
  readonly #vocab: Set<string>;
  readonly #normalize: (text: string) => string;

  constructor(vocab: readonly string[], normalize: (text: string) => string) {
    this.#vocab = new Set(vocab);
    this.#normalize = normalize;
  }

  /** Written Turkish -> the model's text: normalised (numbers, dates, units … read out), lowercase, its alphabet only. */
  run(text: string): string {
    text = text.replace(LONE_SURROGATE, "").replace(UNSAFE, " ");
    if (!text.trim()) return "";
    return this.alphabet(Array.from(blocks(text), (block) => this.#spoken(block)).join(" "));
  }

  /** Lowercase, Turkish casing, typography folded, accents dropped, anything outside the vocabulary a space. */
  alphabet(text: string): string {
    text = text.replace(TYPOGRAPHY_CHARS, (c) => TYPOGRAPHY[c]).replaceAll("İ", "i").replaceAll("I", "ı").toLowerCase();
    let out = "";
    for (let ch of text) {
      if (!TURKISH.has(ch)) ch = ch.normalize("NFKD").replace(COMBINING, "");
      out += ch && [...ch].every((c) => this.#vocab.has(c)) ? ch : " ";
    }
    return out.replace(/\s+/g, " ").trim();
  }

  #spoken(text: string): string {
    try {
      return this.#normalize(text);
    } catch {
      return text; // invalid input or a resource limit: keep the words rather than lose the sentence
    }
  }
}

function* blocks(text: string): Generator<string> {
  const utf8 = new TextEncoder();
  let block: string[] = [], size = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const n = utf8.encode(word).length + 1;
    if (block.length && size + n > BLOCK_BYTES) {
      yield block.join(" ");
      block = [];
      size = 0;
    }
    block.push(word);
    size += n;
  }
  if (block.length) yield block.join(" ");
}

// ----------------------------------------------------------------------------------- chunker.py
const LETTERS_PER_SECOND = 18;
const MAX_SECONDS = 10;
const MAX_LETTERS = 250;
const SENTENCE_PAUSE = 0.25;
const CLAUSE_PAUSE = 0.12;
const CUTS: [RegExp, number][] = [[/[.!?]+["')]*(?= )/g, SENTENCE_PAUSE], [/[,;:](?= )/g, CLAUSE_PAUSE], [/\S(?= )/g, CLAUSE_PAUSE]];
const LETTER = /\p{L}/u;

/** [[piece, seconds of silence after it]], each piece ending in terminal punctuation. */
export function chunk(text: string, speed: number): [string, number][] {
  const limit = Math.trunc(Math.min(MAX_LETTERS, LETTERS_PER_SECOND * MAX_SECONDS * speed));
  const pieces: [string, number][] = [];
  let rest = text.trim();
  while (rest) {
    let cut = rest.length, pause = 0;
    if (rest.length > limit) {
      cut = limit;
      const head = rest.slice(0, limit + 1);
      for (const [pattern, gap] of CUTS) {
        const ends = Array.from(head.matchAll(pattern), (m) => m.index + m[0].length);
        if (ends.length) {
          cut = ends.at(-1)!;
          pause = gap;
          break;
        }
      }
    }
    const piece = rest.slice(0, cut).trim();
    rest = rest.slice(cut).trim();
    if (LETTER.test(piece)) pieces.push([finish(piece), pause]);
  }
  if (pieces.length) pieces.at(-1)![1] = 0;
  return pieces;
}

function finish(piece: string): string {
  if ([".", "!", "?"].includes(piece.replace(/["')]+$/, "").slice(-1))) return piece;
  return piece.replace(/[,;:\- ]+$/, "") + ".";
}

// ----------------------------------------------------------------------------------- engine.py
/** [start, end) frame spans: `first` frames, then WINDOW at a time. */
export function windows(frames: number, first = WINDOW): [number, number][] {
  const spans: [number, number][] = [];
  for (let s = 0; s < frames;) {
    const e = Math.min(frames, s + (s === 0 ? first : WINDOW));
    spans.push([s, e]);
    s = e;
  }
  return spans;
}

/** torch.round: halves go to the even neighbour. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Seeded standard normal noise (mulberry32 + Box-Muller); not torch's stream, so seeds differ from Python. */
function gaussian(seed: number, n: number): Float32Array {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(1 - uniform())), a = 2 * Math.PI * uniform();
    out[i] = r * Math.cos(a);
    if (i + 1 < n) out[i + 1] = r * Math.sin(a);
  }
  return out;
}

const int64 = (array: ArrayLike<number>): BigInt64Array => BigInt64Array.from(array, (v) => BigInt(v));

/** One piece of text on its way through the three graphs. */
interface Piece {
  text: string;
  pause: number;
  seed: number;
  ids: Int32Array;
  /** word of each letter */
  cw: Int32Array;
  /** first letter of each letter's word */
  wstart: Int32Array;
  frames: number;
  h?: OrtNS.Tensor | null;
  dur?: Float32Array;
  /** word of each frame, and the frame's position inside that word (0..1) */
  fw?: Int32Array;
  fp?: Float32Array;
  latents?: Float32Array | null;
}

export interface EmaChunk {
  /** 48 kHz mono float32; the last window of a piece carries the pause after it */
  audio: Float32Array;
  /** piece number and count (a piece gives one chunk per decoded window) */
  index: number;
  count: number;
  /** the piece's model text */
  text: string;
  timings: { text?: number; sound?: number; decoder?: number };
}

interface Sessions {
  text: OrtNS.InferenceSession;
  sound: OrtNS.InferenceSession;
  decoder: OrtNS.InferenceSession;
}

export class Engine {
  readonly sampleRate: number;
  readonly #ort: Runtime["ort"];
  readonly #sessions: Sessions;
  readonly #latentDim: number;
  readonly #steps: number;
  readonly #hop: number;
  readonly #stoi: Map<string, number>;

  private constructor(runtime: Runtime, config: EmaConfig, sessions: Sessions) {
    this.#ort = runtime.ort;
    this.#sessions = sessions;
    this.#latentDim = config.latent_dim;
    this.#steps = config.steps;
    this.#hop = config.hop;
    this.sampleRate = config.sample_rate;
    this.#stoi = new Map(config.vocab.map((ch, i) => [ch, i]));
  }

  /** The three sessions from the pack; one session failing releases the ones already made. */
  static async create(runtime: Runtime, pack: Pack, config: EmaConfig): Promise<Engine> {
    const made: Partial<Sessions> = {};
    try {
      for (const g of GRAPHS) made[g] = await runtime.createSession(await pack.bytes(`graphs/${g}.onnx`), `ema-lightning ${g}.onnx`);
    } catch (e) {
      await Promise.allSettled(Object.values(made).map((s) => s.release()));
      throw e;
    }
    return new Engine(runtime, config, made as Sessions);
  }

  async release(): Promise<void> {
    await Promise.allSettled(Object.values(this.#sessions).map((s) => s.release()));
  }

  /** Model text -> audio chunks, piece by piece, window by window (core.js Pipeline.stream). `modelText` comes from
   * Frontend.run; `speed` is checked by the caller (0.25 to 4). */
  async *stream(modelText: string, speed: number, seed: number, signal?: AbortSignal): AsyncGenerator<EmaChunk, void, undefined> {
    const pieces = chunk(modelText, speed).map(([t, pause], i) => this.#piece(t, pause, Math.imul(seed, 1000003) + i));
    for (const [i, piece] of pieces.entries()) {
      try {
        await checkAbort(signal);
        let t0 = now();
        await this.#plan(piece, speed);
        const text = now() - t0;
        await checkAbort(signal);
        t0 = now();
        await this.#think(piece);
        const sound = now() - t0;
        const spans = windows(piece.frames, i === 0 ? FIRST_WINDOW : WINDOW);
        for (const [k, span] of spans.entries()) {
          await checkAbort(signal);
          t0 = now();
          let audio = await this.#decode(piece, span);
          const timings: EmaChunk["timings"] = { decoder: now() - t0 };
          if (k === 0) Object.assign(timings, { text, sound });
          if (k === spans.length - 1 && piece.pause) {
            const padded = new Float32Array(audio.length + Math.round(piece.pause * this.sampleRate));
            padded.set(audio);
            audio = padded;
          }
          yield { audio, index: i, count: pieces.length, text: piece.text, timings };
        }
      } finally {
        // a finished piece, or one left by an abort, an error or an early return
        piece.h?.dispose();
        piece.h = piece.latents = null;
      }
    }
  }

  #piece(text: string, pause: number, seed: number): Piece {
    const n = text.length; // the model's alphabet is all in the BMP: one UTF-16 unit per letter
    const ids = new Int32Array(n), cw = new Int32Array(n), wstart = new Int32Array(n);
    for (let i = 0, w = -1, start = 0; i < n; i++) {
      if (i === 0 || (text[i] !== " " && text[i - 1] === " ")) {
        w += 1;
        start = i;
      }
      ids[i] = this.#stoi.get(text[i]) ?? 1;
      cw[i] = w;
      wstart[i] = start;
    }
    return { text, pause, seed, ids, cw, wstart, frames: 0 };
  }

  /** Durations, then the exact frame timeline: the word of each frame and its position inside that word. */
  async #plan(p: Piece, speed: number): Promise<void> {
    const { Tensor } = this.#ort;
    const L = p.ids.length;
    const { h, dur } = await this.#sessions.text.run({ ids: new Tensor("int64", int64(p.ids), [1, L]) });
    p.h = h;
    p.dur = Float32Array.from(dur.data as Float32Array, (d) => d / speed);
    dur.dispose();
    const totals = new Float32Array(p.cw[L - 1] + 1);
    for (let i = 0; i < L; i++) totals[p.cw[i]] += p.dur[i];
    const counts = Array.from(totals, (t) => Math.min(MAX_WORD_FRAMES, Math.max(1, roundHalfEven(t))));
    p.frames = Math.min(counts.reduce((a, b) => a + b, 0), MAX_FRAMES);
    p.fw = new Int32Array(p.frames);
    p.fp = new Float32Array(p.frames);
    for (let w = 0, f = 0; w < counts.length && f < p.frames; w++) {
      for (let k = 0; k < counts[w] && f < p.frames; k++, f++) {
        p.fw[f] = w;
        p.fp[f] = k / counts[w];
      }
    }
  }

  /** Latents for a planned piece, from its own seeded noise. */
  async #think(p: Piece): Promise<void> {
    const { Tensor } = this.#ort;
    const L = p.ids.length, T = p.frames;
    const noise = gaussian(p.seed, this.#steps * T * this.#latentDim);
    const { latents } = await this.#sessions.sound.run({
      h: p.h!,
      dur: new Tensor("float32", p.dur!, [1, L]),
      cw: new Tensor("int64", int64(p.cw), [1, L]),
      wstart: new Tensor("int64", int64(p.wstart), [1, L]),
      fw: new Tensor("int64", int64(p.fw!), [1, T]),
      fp: new Tensor("float32", p.fp!, [1, T]),
      noise: new Tensor("float32", noise, [1, this.#steps, T, this.#latentDim]),
    });
    // the wasm backend hands outputs back as JS arrays: the data outlives the tensor
    p.latents = latents.data as Float32Array;
    latents.dispose();
    p.h?.dispose();
    p.h = null;
  }

  /** Audio for one window, decoded with CONTEXT frames on each side and cut to the window. */
  async #decode(p: Piece, [s, e]: [number, number]): Promise<Float32Array> {
    const D = this.#latentDim;
    const a = Math.max(0, s - CONTEXT), b = Math.min(p.frames, e + CONTEXT);
    const z = new this.#ort.Tensor("float32", p.latents!.slice(a * D, b * D), [1, b - a, D]);
    const { audio } = await this.#sessions.decoder.run({ z });
    try {
      return (audio.data as Float32Array).slice((s - a) * this.#hop, (e - a) * this.#hop);
    } finally {
      audio.dispose();
    }
  }
}

/** Reads and checks model/config.json. */
export async function configFromPack(pack: Pack): Promise<EmaConfig> {
  const c = await pack.json<Partial<EmaConfig>>(CONFIG_ENTRY);
  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
  if (!Array.isArray(c?.vocab) || !c.vocab.every((v) => typeof v === "string") || !int(c.latent_dim) || !int(c.steps) || !int(c.hop) || !int(c.sample_rate)) {
    throw new Error(`cipetpet: ${CONFIG_ENTRY} of this ema-lightning pack is not a valid EMA Lightning config (vocab, latent_dim, steps, hop, sample_rate)`);
  }
  return c as EmaConfig;
}
