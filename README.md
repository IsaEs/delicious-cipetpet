# delicious-cipetpet

"Herseyin bir makami var. Bunlar cipetpet ama lezzetli cipetpet fakat sadece amatoru eglendirir."

Turkish speech in the browser, fully local (no server inference):

* **Antalia-2 Mini** – text to speech, 48 kHz
* **Duyu-small** – speech recognition, Turkish + English, 16 kHz

Both run on [ONNX Runtime Web](https://onnxruntime.ai/) (WASM). Model files are wrapped in `.cpet` packs.

| Package | Description |
|---|---|
| [`cipetpet`](./cipetpet) | Core library: `AntaliaMini`, `DuyuSmall`, pack loader, audio helpers, Web Worker clients |
| [`cipetpet-react`](./cipetpet-react) | React hooks and components (`useTextToSpeech`, `useSpeechToText`, `<SpeakButton>`, `<RecordButton>`) |
| [`cipetpet-demo`](./cipetpet-demo) | Voice chat demo: microphone → Duyu (STT) → OpenRouter LLM → Antalia (TTS), with hands-free mode |

## Install

```sh
npm install cipetpet            # core
npm install cipetpet-react      # React wrapper (needs react >= 18)
```

## Get the model packs

Packs (`.cpet`, 10–60 MB each) and the ONNX Runtime WASM files are **not** in the npm package or the git repository.
They are attached to every [GitHub Release](https://github.com/IsaEs/delicious-cipetpet/releases); download them
into your project's `public/` folder and serve them from there:

```sh
npm install cipetpet
npx cipetpet pull                     # -> public/cipetpet/{antalia-mini-int8.cpet, duyu-small-int8.cpet, ort/...}
npx cipetpet verify                   # check the folder against the release's cipetpet-release.json
```

Release asset URLs cannot be fetched by a browser page directly (GitHub sends no CORS headers), hence the copy in
your own `public/`. Layout, options, per-framework setup and how to cut a release: [cipetpet/RELEASES.md](./cipetpet/RELEASES.md).

Or build them from the upstream model files (pinned in `cipetpet/tools/upstream.lock.json`):

```sh
cd cipetpet
npm install
npm run upstream       # download + SHA-256-check the upstream files into cipetpet/.upstream/
npm run packs          # cipetpet/.upstream/{antalia-mini,duyu-small} -> cipetpet/packs/*.cpet + manifest.json
npm run packs -- --antalia DIR --duyu DIR   # model files kept elsewhere
```

`cipetpet/.upstream/` is gitignored; it is where `npm run packs` looks for the upstream model folders by default.

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

Run inference off the main thread:

```ts
import { createAntaliaWorker, createDuyuWorker } from "cipetpet";

const tts = await createAntaliaWorker("/packs/antalia-mini-int8.cpet", { wasmPaths: "/ort/" });
const stt = await createDuyuWorker("/packs/duyu-small-int8.cpet", { wasmPaths: "/ort/" });
```

The worker file is resolved as `new URL("./worker.js", import.meta.url)`. If your bundler does not pick it up,
copy `node_modules/cipetpet/dist/esm/worker/worker.js` to your static folder and pass `{ worker: "/worker.js" }`.
The worker clients cannot take the `fetch` and `ort` options (they cannot be posted to a worker).

Subpath exports: `cipetpet/antalia`, `cipetpet/duyu`, `cipetpet/pack`, `cipetpet/audio`, `cipetpet/worker`.

## Quick start (React)

```tsx
import { CipetpetProvider, useTextToSpeech, useSpeechToText } from "cipetpet-react";

function App() {
  const tts = useTextToSpeech();
  const stt = useSpeechToText();
  return (
    <>
      <button onClick={() => tts.speak("Merhaba!")}>Speak</button>
      <button onClick={() => (stt.isRecording ? stt.stopRecording() : stt.startRecording())}>Mic</button>
      <p>{stt.result?.text}</p>
    </>
  );
}

export default () => (
  <CipetpetProvider
    tts={{ source: "/packs/antalia-mini-int8.cpet" }}
    stt={{ source: "/packs/duyu-small-int8.cpet", useWorker: true }}
  >
    <App />
  </CipetpetProvider>
);
```

Full API: [cipetpet-react/README.md](./cipetpet-react/README.md).

## Deployment notes

* Serve onnxruntime-web's `ort-wasm-*.wasm` / `.mjs` files from the folder given as `wasmPaths`
  (copy them from `node_modules/onnxruntime-web/dist/`, or let `npx cipetpet pull` download them from the release).
* For multi-threaded WASM serve the page with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Without them it still works, single-threaded.
* Serve `.cpet` files with HTTP range/caching support (any static host/CDN). Packs under a fixed URL get rebuilt:
  pass `integrity` (the `sha256-...` values are in the `cipetpet-release.json` that `npx cipetpet pull` writes next to the packs; `cipetpet/packs/manifest.json` when you build them yourself) with `cache: true`, or use hashed
  file names (`npm run packs -- --hash-names`) before marking them `immutable`.
* To load the library, the packs and ONNX Runtime from a CDN with no build step, see
  [cipetpet/CDN.md](./cipetpet/CDN.md).
* The microphone and `AudioContext` need a secure context (HTTPS or `localhost`) and a user gesture.

## Run the demo

```sh
cd cipetpet && npm install && npm run build && npm run packs
cd ../cipetpet-react && npm install && npm run build
cd ../cipetpet-demo && npm install
cp -n .env.example .env.local     # -n: keeps an existing .env.local; put your OPENROUTER_API_KEY in it (never commit it)
npm run dev                       # http://127.0.0.1:5173
```

The OpenRouter key stays on the demo's Node server (`/api/chat` proxy) and never reaches the browser. The server
only answers requests whose `Host` is `localhost` or an IP address (DNS-rebinding protection); to serve it under a
name, list the name in `ALLOWED_HOSTS` (comma separated). `npm run dev` writes an unminified `dist/` and rebuilds on change; `npm run build` writes the
minified production one. To try the demo without a key, choose the echo backend in Settings.

## Develop

```sh
cd cipetpet        && npm run typecheck && npm run build && npm test
cd cipetpet-react  && npm run typecheck && npm test
cd cipetpet-demo   && npm run typecheck && npm test
```

More: [cipetpet/ARCHITECTURE.md](./cipetpet/ARCHITECTURE.md), [cipetpet/FORMAT.md](./cipetpet/FORMAT.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
