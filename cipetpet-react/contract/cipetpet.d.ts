// FALLBACK type declarations for the "cipetpet" root entry, transcribed from the core's binding contract
// (../cipetpet/ARCHITECTURE.md "Model classes" / "Root entry and worker client", ../cipetpet/src/types.ts,
// ../cipetpet/src/pack/types.ts, ../cipetpet/src/audio/*).
//
// It is only used when neither the real core sources (../cipetpet/src/index.ts, for `npm run typecheck`) nor
// the built core (node_modules/cipetpet/dist/types, for `npm run build`) exist yet; see the "paths" fallbacks
// in tsconfig.json / tsconfig.build.json. It is never published and never shadows the real package: the moment
// the core's index exists, TypeScript resolves "cipetpet" to it and this file is ignored.
//
// Only the subset cipetpet-react uses is declared. Keep it in sync with the contract.

// ------------------------------------------------------------------------------------------ pack/types.ts
export type ModelId = "antalia-mini" | "duyu-small";
export type ModelTask = "text-to-speech" | "speech-recognition";

export interface PackModelInfo {
  id: ModelId | (string & {});
  name: string;
  version: string;
  task: ModelTask | (string & {});
  variant: string;
  license?: string;
  source?: string;
  languages?: string[];
}

export interface PackProgress {
  loaded: number;
  /** 0 when the size is unknown */
  total: number;
}

export interface PackLoadOptions {
  verify?: boolean;
  onProgress?: (p: PackProgress) => void;
  signal?: AbortSignal;
  cache?: boolean | string;
  fetch?: typeof fetch;
  requestInit?: RequestInit;
}

export declare class Pack {
  private constructor();
  readonly byteLength: number;
  get model(): PackModelInfo;
  get meta(): Record<string, unknown>;
  has(name: string): boolean;
}

export type PackSource = string | URL | ArrayBuffer | Uint8Array | Blob | Pack;

// ------------------------------------------------------------------------------------------ types.ts
export type Backend = "wasm" | "webgpu";

export interface RuntimeOptions {
  backend?: Backend;
  threads?: number;
  wasmPaths?: string;
  wasmBinary?: ArrayBuffer | Uint8Array;
  proxy?: boolean;
  ort?: unknown;
  logLevel?: "verbose" | "info" | "warning" | "error" | "fatal";
}

export interface LoadOptions extends PackLoadOptions, RuntimeOptions {}

export interface ModelInfo extends PackModelInfo {
  sampleRate: number;
  backend: Backend;
  threads: number;
  crossOriginIsolated: boolean;
  packBytes: number;
  loadMs: { fetch: number; init: number };
  onnxruntime: string;
}

export type AntaliaPrecision = "mixed" | "fp32" | "fp16" | "int8";

export interface SynthesisOptions {
  seed?: number;
  steps?: number;
  cfg?: number;
  speed?: number;
  temperature?: number;
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
  audio: Float32Array;
  index: number;
  count: number;
  text: string;
  timings: Partial<SynthesisTimings>;
}

export interface SynthesisResult {
  audio: Float32Array;
  sampleRate: number;
  modelText: string;
  stats: { computeMs: number; seconds: number; chunks: number; rtf: number; timings: SynthesisTimings };
}

export type DuyuPrecision = "int8" | "q4" | "fp32";
export type DuyuLanguage = "tr" | "en" | "mix" | "auto";

export interface TranscribeOptions {
  sampleRate?: number;
  lang?: DuyuLanguage;
  mode?: "auto" | "ctc";
  beam?: number;
  tailPad?: boolean;
  ctcWeight?: number;
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  lang: string;
  segments: { text: string; start: number; end: number; tokens: number[] }[];
  stats: { seconds: number; computeMs: number; rtf: number; chunks: number; mode: "attn" | "ctc"; encoderMs: number; decoderMs: number };
}

// ------------------------------------------------------------------------------------------ model classes
export declare class AntaliaMini {
  private constructor();
  static load(source: PackSource, opts?: LoadOptions): Promise<AntaliaMini>;
  readonly info: ModelInfo;
  readonly defaults: { steps: number; cfg: number; speed: number; temperature: number };
  normalize(text: string): string;
  synthesize(text: string, opts?: SynthesisOptions): Promise<SynthesisResult>;
  stream(text: string, opts?: SynthesisOptions): AsyncGenerator<SpeechChunk>;
  dispose(): Promise<void>;
}

export declare class DuyuSmall {
  private constructor();
  static load(source: PackSource, opts?: LoadOptions): Promise<DuyuSmall>;
  readonly info: ModelInfo;
  transcribe(audio: Float32Array, opts?: TranscribeOptions): Promise<TranscriptionResult>;
  dispose(): Promise<void>;
}

// ------------------------------------------------------------------------------------------ worker client
export interface WorkerOptions extends LoadOptions {
  worker?: Worker | URL | string;
}

export interface AntaliaWorker {
  readonly info: ModelInfo;
  readonly defaults: { steps: number; cfg: number; speed: number; temperature: number };
  normalize(text: string): Promise<string>;
  synthesize(text: string, opts?: SynthesisOptions): Promise<SynthesisResult>;
  stream(text: string, opts?: SynthesisOptions): AsyncGenerator<SpeechChunk>;
  dispose(): Promise<void>;
}

export interface DuyuWorker {
  readonly info: ModelInfo;
  transcribe(audio: Float32Array, opts?: TranscribeOptions): Promise<TranscriptionResult>;
  dispose(): Promise<void>;
}

export declare function createAntaliaWorker(
  source: string | URL | ArrayBuffer | Uint8Array | Blob,
  opts?: WorkerOptions,
): Promise<AntaliaWorker>;
export declare function createDuyuWorker(
  source: string | URL | ArrayBuffer | Uint8Array | Blob,
  opts?: WorkerOptions,
): Promise<DuyuWorker>;

// ------------------------------------------------------------------------------------------ audio
export interface EncodeWavOptions {
  bitDepth?: 16 | 32;
}
export declare function encodeWav(
  samples: Float32Array | Float32Array[],
  sampleRate: number,
  opts?: EncodeWavOptions,
): Uint8Array;

export type AudioInput = Blob | ArrayBuffer | Uint8Array;
export interface DecodedAudio {
  audio: Float32Array;
  sampleRate: number;
  duration: number;
}
export declare function decodeAudio(input: AudioInput, targetRate?: number): Promise<DecodedAudio>;

export interface MicRecorderOptions {
  sampleRate?: number;
  deviceId?: string;
  onLevel?: (rms: number) => void;
  constraints?: MediaTrackConstraints;
}

export declare class MicRecorder {
  private constructor();
  readonly sampleRate: number;
  readonly captureRate: number;
  static start(opts?: MicRecorderOptions): Promise<MicRecorder>;
  get duration(): number;
  get recording(): boolean;
  stop(): Promise<Float32Array>;
  cancel(): void;
}

export interface Playback {
  ended: Promise<void>;
  stop(): void;
}

export declare class StreamPlayer {
  constructor(sampleRate: number, ctx?: AudioContext);
  readonly sampleRate: number;
  get context(): AudioContext;
  get buffered(): number;
  get playing(): boolean;
  push(chunk: Float32Array): void;
  finish(): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}
