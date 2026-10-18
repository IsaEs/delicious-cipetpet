# cipetpet architecture (contract for contributors)

cipetpet is a TypeScript library that runs three Turkish speech models in the browser (and in Node for tests),
on ONNX Runtime Web (WASM, optional WebGPU):

* **Antalia-2 Mini** – text to speech, 48 kHz (source: `../antalia-mini`, a static web page in plain JS;
  `js/tts.js` + `js/frontend.js` are the reference implementation that we port to TypeScript).
* **EMA Lightning** – text to speech, 48 kHz, 8.6M parameters (source: `../ema-lightning-web`, whose `web/` folder
  is a browser port in plain JS: `web/src/core.js` is the reference implementation we port to TypeScript; its graphs
  come from `web/export_onnx.py`, its text normaliser is normalizer-tr compiled to WebAssembly in `web/normalizer`).
* **Duyu-small** – speech recognition, Turkish + English, 16 kHz in (source: `../Duyu-small`, a Python
  engine in `duyu_small/*.py`, which is the reference we port to TypeScript).

Every file a model needs (graphs, tables, tokenizer, frontend data, metadata, optionally the ORT WASM binary)
is wrapped into one `.cpet` pack per model and precision (`FORMAT.md`). `src/pack/types.ts` and
`src/types.ts` are the shared types: **do not change their exported shapes**; add fields only if unavoidable
and say so.

The real binaries (the sibling repos only hold Git LFS pointers) are in `.upstream/` (gitignored, SHA-256
verified against the LFS pointers):

```
.upstream/antalia-mini/models/{text,cond,flow,vocoder}{,.fp16,.int8}.onnx, models/manifest.json
.upstream/antalia-mini/assets/frontend-data.json.gz
.upstream/antalia-mini/vendor/ort/ort-wasm-simd-threaded.wasm      (ORT 1.30.0, same as node_modules)
.upstream/duyu-small/{int8,q4}/{encoder_pre,encoder_pass,encoder_post,decoder}.onnx
.upstream/duyu-small/{fbank.npz,passes.npz,spm.model,engine.json,config.json}
```

The EMA Lightning files have no pinned upstream: `npm run packs` reads them from `../ema-lightning-web/web`
(`--ema DIR`), and skips the pack when the folder is missing.

Graph signatures (all verified with onnx):

```
antalia text.onnx     ids int64 [1,L]                                   -> h f32 [1,L,192], logd f32 [1,L]
antalia cond.onnx     h f32 [1,L,192], idx int64 [1,T]                  -> ctok, cnull f32 [1,T/2,192]
antalia flow.onnx     x f32 [1,N,256], ctok, cnull [1,N,192], t, dt, cfg f32 [1] -> x_next f32 [1,N,256]
antalia vocoder.onnx  z f32 [1,N,256]                                   -> mel [1,128,T], re, im [1,1025,T]
ema text.onnx         ids int64 [1,L]                                   -> h f32 [1,L,C], dur f32 [1,L]
ema sound.onnx        h, dur, cw int64 [1,L], wstart int64 [1,L], fw int64 [1,T], fp f32 [1,T], noise f32 [1,steps,T,64] -> latents f32 [1,T,64]
ema decoder.onnx      z f32 [1,N,64]                                    -> audio f32 [1,N*1920]
duyu encoder_pre      feats f32 [1,T,160]   -> x f32 [1,Tp,256]
duyu encoder_pass     x f32 [1,Tp,256]      -> y f32 [1,Tp,256]          (run 3x with pass_embed / gates)
duyu encoder_post     x f32 [1,Tp,256]      -> log_probs f32 [1,Tp,2048]
duyu decoder          tokens int64 [K,L], memory f32 [1,Tp,256] (broadcast over K) -> logits f32 [K,L,2048]
```

q4 Duyu graphs use `com.microsoft:MatMulNBits`; onnxruntime-web 1.30.0 WASM runs them (checked in Node).
`fbank.npz` = {window f32[400], mel f32[257,80]}; `passes.npz` = {gates f32[3], pass_embed f32[3,256]};
`spm.model` = 2048 pieces, ids 0..8 = `<pad> <unk> <s> </s> <tr> <en> <mix> <cased> <plain>`, ids 9..264 =
byte-fallback pieces `<0x00>`..`<0xFF>`.

## Layout and module contracts

```
src/
  types.ts                 public option/result types (fixed)
  index.ts                 re-exports everything public
  pack/
    types.ts               format types (fixed)
    crc32.ts               crc32(bytes: Uint8Array): number
    codec.ts               gzip(b), gunzip(b): Promise<Uint8Array>  (CompressionStream / DecompressionStream)
                           sha256Hex(b): Promise<string>           (crypto.subtle)
    reader.ts              class Pack, openPack(source, opts), fetchBytes(url, opts)
    writer.ts              writePack(input: PackInput): Promise<Uint8Array>
    index.ts
  runtime/
    ort.ts                 initRuntime(opts: RuntimeOptions, pack?: Pack): Promise<Runtime>
    index.ts
  audio/
    wav.ts                 encodeWav(samples, sampleRate, {bitDepth?: 16|32}): Uint8Array
                           decodeWav(bytes): {sampleRate, channels: Float32Array[]}
    resample.ts            resample(x, fromRate, toRate): Float32Array ; toMono(channels): Float32Array
    decode.ts              decodeAudio(input: Blob|ArrayBuffer|Uint8Array, targetRate?): Promise<{audio: Float32Array, sampleRate}>
    record.ts              class MicRecorder (getUserMedia + AudioWorklet), start()/stop()/cancel()
    play.ts                playAudio(samples, sampleRate, ctx?) ; class StreamPlayer (gapless queue of chunks)
    index.ts
  antalia/
    frontend.ts            TS port of antalia-mini/js/frontend.js (behaviour identical)
    engine.ts              TS port of antalia-mini/js/tts.js (TorchRandn, durations, frameIndex, istft,
                           Engine, OutputChain, speak, splitModelText) on top of Runtime + Pack
    index.ts               class AntaliaMini
  ema/
    normalizer.ts          normalizer-tr's wasm-bindgen binding, per instance, imports matched without build hashes
    engine.ts              TS port of ema-lightning-web/web/src/core.js (Frontend, chunk, windows, the 3-graph Engine)
    index.ts               class EmaLightning (same API as AntaliaMini)
  tts.ts                   loadTextToSpeech(source, opts): AntaliaMini | EmaLightning by the pack's model id
  duyu/
    fft.ts fbank.ts ctc.ts beam.ts tokenizer.ts chunks.ts   ports of features.py / decode.py / audio.py
    index.ts               class DuyuSmall
  worker/
    protocol.ts worker.ts client.ts index.ts   run either model inside a Web Worker
tools/
  build-packs.ts           .upstream -> packs/*.cpet + packs/manifest.json  (run with tsx)
  inspect-pack.ts          list / verify a pack
  build.mjs                tsc (dist/esm, dist/types) + esbuild: the worker bundle and dist/browser (CDN bundles, see CDN.md); ORT's .wasm files are not copied
  serve.mjs                static server with COOP/COEP for demo/
test/                      node:test files run with tsx (node --import tsx --test)
demo/                      a page using the browser bundle: speak, listen (mic / file), round trip
packs/                     built packs (gitignored)
```

### pack/reader.ts

```ts
export class Pack {
  static async fromBytes(bytes: ArrayBuffer | Uint8Array, opts?: PackLoadOptions): Promise<Pack>;
  static async fromBlob(blob: Blob, opts?: PackLoadOptions): Promise<Pack>;
  static async fromUrl(url: string | URL, opts?: PackLoadOptions): Promise<Pack>;
  readonly header: PackHeader;
  readonly byteLength: number;
  get model(): PackModelInfo;
  get meta(): Record<string, unknown>;
  has(name: string): boolean;
  entry(name: string): PackEntry;          // throws a clear Error naming the pack and the missing entry
  list(): PackEntry[];
  bytes(name: string): Promise<Uint8Array>; // decoded + verified (unless verify:false); zero-copy view for raw entries
  text(name: string): Promise<string>;
  json<T = unknown>(name: string): Promise<T>;
  tensor<T extends TypedTensorData = TypedTensorData>(name: string): Promise<PackTensor<T>>; // copies into an aligned typed array
}
export function openPack(source: PackSource, opts?: PackLoadOptions): Promise<Pack>;
export function fetchBytes(url: string | URL, opts?: PackLoadOptions): Promise<Uint8Array>; // streaming progress, Cache API
```

### runtime/ort.ts

```ts
import type * as OrtNS from "onnxruntime-web";
export type Ort = typeof OrtNS;
export interface Runtime {
  ort: Ort; backend: Backend; threads: number; crossOriginIsolated: boolean; version: string;
  createSession(bytes: Uint8Array, name?: string): Promise<OrtNS.InferenceSession>;
}
export function initRuntime(opts?: RuntimeOptions, pack?: Pack): Promise<Runtime>;
```

ORT's `env` is global: the first `initRuntime` configures it (threads, wasm paths / binary, proxy, log level);
later calls reuse that configuration and return a Runtime for the requested backend. The wasm build is
imported with `import("onnxruntime-web")` (Node resolves this to ORT's node build), WebGPU with
`import("onnxruntime-web/webgpu")`. When the pack holds `runtime/ort-wasm-simd-threaded.wasm` and
`pack.header.runtime.onnxruntime === ort.env.versions.web`, its bytes go to `env.wasm.wasmBinary`.

### Model classes

```ts
class AntaliaMini {
  static load(source: PackSource, opts?: LoadOptions): Promise<AntaliaMini>; // fetch pack, sessions, frontend, warm-up
  readonly info: ModelInfo;          // sampleRate 48000
  readonly defaults: { steps: number; cfg: number; speed: number; temperature: number };
  normalize(text: string): string;   // raw Turkish text -> model text (frontend.modelText)
  synthesize(text: string, opts?: SynthesisOptions): Promise<SynthesisResult>;
  stream(text: string, opts?: SynthesisOptions): AsyncGenerator<SpeechChunk>;
  dispose(): Promise<void>;
}
class EmaLightning {                 // same shape as AntaliaMini
  static load(source: PackSource, opts?: LoadOptions): Promise<EmaLightning>;
  readonly info: ModelInfo;          // sampleRate 48000
  readonly defaults: { speed: number };  // speed 0.25..4; steps / cfg / temperature are accepted and ignored
  normalize(text: string): string;   // normalizer-tr (fallback policy) + the model's alphabet
  synthesize(text: string, opts?: SynthesisOptions): Promise<SynthesisResult>;
  stream(text: string, opts?: SynthesisOptions): AsyncGenerator<SpeechChunk>;  // one chunk per decoded window
  dispose(): Promise<void>;
}
function loadTextToSpeech(source: PackSource, opts?: LoadOptions, expect?: "antalia-mini" | "ema-lightning"): Promise<AntaliaMini | EmaLightning>;
class DuyuSmall {
  static load(source: PackSource, opts?: LoadOptions): Promise<DuyuSmall>;
  readonly info: ModelInfo;          // sampleRate 16000
  transcribe(audio: Float32Array, opts?: TranscribeOptions): Promise<TranscriptionResult>;
  dispose(): Promise<void>;
}
```

Calls on one model instance are serialised (an internal promise queue), since an ORT session must not
run two inferences at once.

### Root entry and worker client (consumed by `../cipetpet-react`)

`src/index.ts` re-exports: `AntaliaMini`, `EmaLightning`, `loadTextToSpeech`, `DuyuSmall`, `Pack`, `openPack`, `fetchBytes`,
`writePack`, `initRuntime`, everything from `audio/index.ts` (`encodeWav`, `decodeWav`, `resample`, `toMono`, `decodeAudio`,
`MicRecorder`, `playAudio`, `StreamPlayer`), `createAntaliaWorker`, `createEmaWorker`, `createTtsWorker`, `createDuyuWorker`,
and all types from `types.ts` and `pack/types.ts`. (`ModelId` gained `"ema-lightning"`: an added union member, the
one change to the fixed types.)

```ts
// worker/client.ts: the same model API, run inside a dedicated module Worker
export interface WorkerOptions extends LoadOptions { worker?: Worker | URL | string } // default: new Worker(new URL("./worker.js", import.meta.url), {type: "module"})
export function createAntaliaWorker(source: string | URL | ArrayBuffer | Uint8Array | Blob, opts?: WorkerOptions): Promise<AntaliaWorker>;
export interface AntaliaWorker {
  readonly info: ModelInfo;
  readonly defaults: { steps: number; cfg: number; speed: number; temperature: number };
  normalize(text: string): Promise<string>;                 // async here (AntaliaMini.normalize is sync)
  synthesize(text: string, opts?: SynthesisOptions): Promise<SynthesisResult>;
  stream(text: string, opts?: SynthesisOptions): AsyncGenerator<SpeechChunk>;
  dispose(): Promise<void>;                                // disposes the model and terminates the worker
}
// the worker's "tts" load names the model the pack must hold (createAntaliaWorker / createEmaWorker), or none
// (createTtsWorker: the worker reads the pack's header and loads that model)
export function createEmaWorker(source: string | URL | ArrayBuffer | Uint8Array | Blob, opts?: WorkerOptions): Promise<EmaWorker>;   // defaults: { speed }
export function createTtsWorker(source: string | URL | ArrayBuffer | Uint8Array | Blob, opts?: WorkerOptions): Promise<AntaliaWorker | EmaWorker>;
export function createDuyuWorker(source: string | URL | ArrayBuffer | Uint8Array | Blob, opts?: WorkerOptions): Promise<DuyuWorker>;
export interface DuyuWorker {
  readonly info: ModelInfo;
  transcribe(audio: Float32Array, opts?: TranscribeOptions): Promise<TranscriptionResult>;
  dispose(): Promise<void>;
}
```

`onProgress` and `signal` work across the worker boundary (progress messages are forwarded; an abort posts a
cancel message and rejects with an `AbortError`). Audio buffers are transferred, not copied; an input
`Float32Array` that is a view on a larger buffer (it does not span its `ArrayBuffer`) is copied first, so the
caller's other views stay valid. What is posted must be structured-cloneable: URL sources and a relative
`wasmPaths` are made absolute against the page first (a worker would resolve them against its own script),
`requestInit.signal` is dropped, and the `fetch` and `ort` options are rejected with a `TypeError`.

## Fidelity rules

* Antalia: the TS port must give **bit-identical audio** to the original `antalia-mini/js/tts.js` given the
  same graphs, text, seed and options, and **identical model text** to `antalia-mini/js/frontend.js`.
* EMA Lightning: the TS port must give **bit-identical audio** and **identical model text** to ema-lightning-web's
  `web/src/core.js` (with its wasm-bindgen glue for the normaliser) given the same graphs, text, seed and speed, on the
  same ORT module; `test/ema.test.ts` checks it when `../ema-lightning-web/web` is there. Its seeded noise is
  core.js's (mulberry32 + Box-Muller), not torch's, so seeds do not match the Python package.
* Duyu: fbank within 1e-4 abs of `features.py`; the search logic (beam 5, beam 1, CTC mode, tie order, language
  handling) and the encoder chain must be **identical** to `DuyuSmall.transcribe` (Python), which
  `test/duyu-parity.test.ts` proves by replaying the Python engine's own graph outputs (token ids and text equal).
  End to end through ORT Web the transcripts are not bit-identical to the Python engine on ORT CPU: the graphs give
  slightly different numbers (fused int8 kernels, MatMulNBits), and 33 of 40 test transcripts per precision are
  equal. The 7 that are not are listed in the test as known numerics-only cases; any other case must match, and the
  count must not drop. The replay needs a Python venv: set `REFVENV_PYTHON` (numpy, onnxruntime, sentencepiece, onnx).
* No Node-only API in `src/` (no `fs`, `Buffer`, `zlib`, `path`): `src/` must run in a browser, a Web
  Worker and Node >= 20 alike. `tools/` and `test/` may use Node APIs.
