// Public option and result types shared by both models and the worker client.
import type { PackLoadOptions, PackModelInfo } from "./pack/types.js";

export type Backend = "wasm" | "webgpu";

/** How ONNX Runtime Web is set up. Every field is optional; the defaults work on a static page. */
export interface RuntimeOptions {
  /** "wasm" (default) or "webgpu" (falls back to wasm for unsupported ops) */
  backend?: Backend;
  /** WASM threads. Default: half the cores, at most 4, when the page is cross-origin isolated, else 1. */
  threads?: number;
  /** where ORT finds its .wasm / .mjs files (a URL prefix ending in "/"); ignored when the pack embeds
   * the runtime binary or `wasmBinary` is given. The prebuilt browser bundles (dist/browser, and the
   * worker.js next to the library) default to the matching onnxruntime-web release on jsDelivr; with the
   * npm ESM build and a bundler ORT looks next to its own script, so copy the files and set this. */
  wasmPaths?: string;
  /** the ORT WASM binary itself */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** run ORT in its own proxy worker (keeps the main thread free); default false. Not supported from the
   * CDN bundle (use createAntaliaWorker / createDuyuWorker there). */
  proxy?: boolean;
  /** a preloaded onnxruntime-web module, for apps that already ship one */
  ort?: unknown;
  /** ORT log level, default "error" */
  logLevel?: "verbose" | "info" | "warning" | "error" | "fatal";
}

export interface LoadOptions extends PackLoadOptions, RuntimeOptions {}

export interface ModelInfo extends PackModelInfo {
  sampleRate: number;
  backend: Backend;
  threads: number;
  crossOriginIsolated: boolean;
  /** bytes of the pack */
  packBytes: number;
  /** ms from load() to ready, split */
  loadMs: { fetch: number; init: number };
  onnxruntime: string;
}

// ------------------------------------------------------------------------------------- text to speech
export type AntaliaPrecision = "mixed" | "fp32" | "fp16" | "int8";

export interface SynthesisOptions {
  /** noise seed; the same text and seed give the same audio (default 0) */
  seed?: number;
  /** flow steps (default from the release: 8) */
  steps?: number;
  /** classifier-free guidance (default 2.0) */
  cfg?: number;
  /** speaking rate, > 0 (default 0.95) */
  speed?: number;
  /** noise temperature (default 0.6) */
  temperature?: number;
  /** text is already model text (lowercase Turkish letters and . , ? ! ' - : ;): skip the normaliser */
  raw?: boolean;
  signal?: AbortSignal;
}

export interface SynthesisTimings {
  normalize: number;
  text: number;
  cond: number;
  flow: number;
  vocoder: number;
  istft: number;
  post: number;
}

export interface SpeechChunk {
  /** 48 kHz mono float32 */
  audio: Float32Array;
  index: number;
  count: number;
  /** the chunk's model text */
  text: string;
  timings: Partial<SynthesisTimings>;
}

export interface SynthesisResult {
  audio: Float32Array;
  sampleRate: number;
  /** the normalised text the model read */
  modelText: string;
  stats: { computeMs: number; seconds: number; chunks: number; rtf: number; timings: SynthesisTimings };
}

// ------------------------------------------------------------------------------------- speech recognition
export type DuyuPrecision = "int8" | "q4" | "fp32";
export type DuyuLanguage = "tr" | "en" | "mix" | "auto";

export interface TranscribeOptions {
  /** sample rate of the input; anything other than 16000 is resampled (default 16000) */
  sampleRate?: number;
  /** tr | en | mix (default: whatever is spoken) | auto (detect) */
  lang?: DuyuLanguage;
  /** "auto" (default): attention beam search with CTC rescoring; "ctc": CTC greedy only (fastest) */
  mode?: "auto" | "ctc";
  /** beam width (default 5) */
  beam?: number;
  /** append 0.4 s of silence (push-to-talk recordings end on the last word); default true */
  tailPad?: boolean;
  /** CTC weight in the final ranking (default 0.3) */
  ctcWeight?: number;
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  /** language token the decoder used for the first chunk (tr | en | mix) */
  lang: string;
  /** per chunk (inputs over 30 s are cut into <= 25 s chunks at quiet points) */
  segments: { text: string; start: number; end: number; tokens: number[] }[];
  stats: { seconds: number; computeMs: number; rtf: number; chunks: number; mode: "attn" | "ctc"; encoderMs: number; decoderMs: number };
}
