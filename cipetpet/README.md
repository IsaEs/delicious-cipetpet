# cipetpet

Core library of [delicious-cipetpet](https://github.com/IsaEs/delicious-cipetpet): local Turkish TTS (Antalia-2 Mini, EMA Lightning) and STT (Duyu-small) in the browser.

## Install

```sh
npm install cipetpet            # core

```

## Get the model packs and the ONNX Runtime files

Packs (`.cpet`, 10–60 MB each) are **not** in the npm package or the git repository. Every GitHub Release of the
project has them as downloads, together with the ONNX Runtime files and a `SHA256SUMS` file. Put them into your
project's `public/` folder with:

```sh
npm install cipetpet
npx cipetpet pull            # -> public/cipetpet/{antalia-mini-int8.cpet, duyu-small-int8.cpet, ort/...}
npx cipetpet verify          # re-hash the folder against the release manifest
```

then `AntaliaMini.load("/cipetpet/antalia-mini-int8.cpet", { wasmPaths: "/cipetpet/ort/" })`. A browser cannot
fetch GitHub release URLs directly (no CORS), so the files are served from your own origin. Folder layout, options,
setup for Vite / Next.js / CRA / Express and the maintainer's steps to cut a release: [RELEASES.md](./RELEASES.md).

To build the packs yourself from the upstream model files (pinned in `tools/upstream.lock.json`):

```sh
cd cipetpet
npm install
npm run upstream       # download + SHA-256-check the upstream files into .upstream/ (once)
npm run packs          # .upstream/{antalia-mini,duyu-small} -> packs/*.cpet and packs/manifest.json
npm run packs -- --antalia DIR --duyu DIR   # model files kept elsewhere
npm run release:assets # packs + ORT files + SHA256SUMS -> release/ (what a GitHub Release carries)
```

`.upstream/` (gitignored) is where `npm run packs` looks for the upstream model folders by default.

**EMA Lightning** has no pinned upstream with ONNX files: its pack is built from
[ema-lightning-web](https://github.com/canberk7/ema-lightning)'s browser export (`web/models/` from
`web/export_onnx.py`, and normalizer-tr compiled to `web/normalizer/pkg/normalizer_tr_wasm_bg.wasm`). `npm run packs`
picks it up from `../ema-lightning-web/web` when that folder exists, and skips it otherwise:

```sh
npm run packs -- --only ema-lightning-fp32 --ema ../ema-lightning-web/web   # -> packs/ema-lightning-fp32.cpet (~34 MB)
```

## Quick start (core)

```ts
import { AntaliaMini, DuyuSmall } from "cipetpet";

// A folder that serves onnxruntime-web's files: copy ort-wasm-simd-threaded.{mjs,wasm} from
// node_modules/onnxruntime-web/dist/ (plus ort-wasm-simd-threaded.asyncify.{mjs,wasm} for backend: "webgpu").
// A pack built with `--embed-runtime` carries the .wasm itself.
const runtime = { wasmPaths: "/ort/" };

// Text to speech
const tts = await AntaliaMini.load("/packs/antalia-mini-int8.cpet", {
  ...runtime,
  onProgress: (p) => console.log(p.loaded, p.total),
});
const { audio, sampleRate } = await tts.synthesize("Merhaba dünya!");
// audio: Float32Array (mono). Stream sentence by sentence with `for await (const chunk of tts.stream(text))`.

// Speech to text
const stt = await DuyuSmall.load("/packs/duyu-small-int8.cpet", runtime);
const result = await stt.transcribe(float32Mono16k);
console.log(result.text);
```

EMA Lightning has the same API as `AntaliaMini` (`synthesize`, `stream`, `normalize`, `dispose`; `SynthesisOptions` in,
`SynthesisResult` / `SpeechChunk` out). Its `speed` goes from 0.25 to 4, it has no `steps` / `cfg` / `temperature`
(they are accepted and ignored), and its text goes through normalizer-tr (numbers, dates, money, units read aloud).
Its stream starts with one second of audio, then up to four seconds per chunk. `loadTextToSpeech` loads whichever of
the two a pack holds:

```ts
import { EmaLightning, loadTextToSpeech } from "cipetpet";

const ema = await EmaLightning.load("/packs/ema-lightning-fp32.cpet", runtime);
const tts = await loadTextToSpeech(packUrl, runtime);   // AntaliaMini or EmaLightning, by the pack's header (tts.info.id)
```

Run inference off the main thread:

```ts
import { createAntaliaWorker, createDuyuWorker, createEmaWorker, createTtsWorker } from "cipetpet";

const tts = await createAntaliaWorker("/packs/antalia-mini-int8.cpet", { wasmPaths: "/ort/" });
const stt = await createDuyuWorker("/packs/duyu-small-int8.cpet", { wasmPaths: "/ort/" });
const ema = await createEmaWorker("/packs/ema-lightning-fp32.cpet", { wasmPaths: "/ort/" });
const any = await createTtsWorker(packUrl, { wasmPaths: "/ort/" });   // whichever TTS model the pack holds
```

The worker file is resolved as `new URL("./worker.js", import.meta.url)`. If your bundler does not pick it up,
copy `node_modules/cipetpet/dist/esm/worker/worker.js` to your static folder and pass `{ worker: "/worker.js" }`
(bundlers do not rewrite that URL inside a dependency: pass the `worker` option built with the bundler's own worker
syntax, or use the CDN bundle below). A worker script on another origin, for example on a CDN, is started through
a Blob URL that imports it, so it works too as long as the script is served with CORS headers.

Worker clients post their arguments to the worker, so what they take must be structured-cloneable: a relative
pack URL (or `wasmPaths`) is resolved against the page, not the worker script; the `fetch` and `ort` options are
rejected (use the main-thread `load` for those). `DuyuWorker.transcribe(audio)` transfers the array's buffer (the
array is detached afterwards) unless `audio` is a view on a larger buffer, which is copied instead.

## From a CDN, no build step

```html
<script type="module">
  import { AntaliaMini } from "https://cdn.jsdelivr.net/npm/cipetpet@VERSION/dist/browser/cipetpet.min.js";
  const tts = await AntaliaMini.load("https://<your pack host>/antalia-mini-int8.cpet", {
    integrity: "sha256-...", // optional, from cipetpet-release.json (written by `npx cipetpet pull`)
    cache: true,
  });
  const { audio, sampleRate } = await tts.synthesize("Merhaba dünya!");
</script>
```

`dist/browser/` (also on unpkg) holds the single-file library with ONNX Runtime's JS inside (`cipetpet.js`,
`cipetpet.min.js`), the lazily loaded WebGPU build (`ort-webgpu.js`) and a standalone `worker.js`. In that bundle
ONNX Runtime fetches its `.wasm`/`.mjs` from `https://cdn.jsdelivr.net/npm/onnxruntime-web@<its version>/dist/`
unless you pass `wasmPaths` / `wasmBinary` or use a pack built with `--embed-runtime`. The packs must be served
with `Access-Control-Allow-Origin`; Hugging Face model repos do, GitHub Releases do not. Threads need COOP/COEP on
your page. Downloaded packs: the `integrity` strings are in `cipetpet-release.json` (see [RELEASES.md](./RELEASES.md)). Built packs:
`npm run packs` also writes `packs/manifest.json` (size, SHA-256 and the `integrity` string of every
pack; `--hash-names` adds immutable `<name>.<hash>.cpet` copies). jsDelivr serves npm files only up to about 50 MB, so
`duyu-small-int8.cpet` (55.8 MB) cannot come from there; the other packs are smaller (details in CDN.md).

Which host for what, the headers each one sends (checked with curl), copy-paste CORS configs, the COOP/COEP setup,
and complete pages for TTS, STT and the worker clients: [CDN.md](./CDN.md).

Subpath exports: `cipetpet/antalia`, `cipetpet/ema`, `cipetpet/duyu`, `cipetpet/pack`, `cipetpet/audio`, `cipetpet/worker`, `cipetpet/browser` (the CDN bundle), `cipetpet/browser/*`.

Docs, packs, deployment notes and React wrapper: https://github.com/IsaEs/delicious-cipetpet#readme
