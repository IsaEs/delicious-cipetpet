# cipetpet-react

React hooks and components for [cipetpet](../cipetpet): Turkish **text to speech** (Antalia-2 Mini, 48 kHz)
and **speech recognition** (Duyu-small, Turkish + English, 16 kHz) running in the browser on ONNX Runtime Web.

* Headless first: `useTextToSpeech`, `useSpeechToText`, plus the lower-level `useAntalia` / `useDuyu`.
* One model instance per pack, shared by every component, refcounted, kept for a grace period after the last
  unmount (React StrictMode and quick remounts never reload a 10-60 MB model).
* Streaming playback: `speak()` starts playing after the first sentence.
* Microphone recording with a level meter, file transcription, abort on unmount, and SSR-safe (Next.js).
* Two small, unstyled, accessible components: `<SpeakButton>` and `<RecordButton>`.
* No dependencies besides React and cipetpet.

## Install

```sh
npm install cipetpet cipetpet-react
```

Peer dependencies: `react >= 18`, `cipetpet ^0.1.0` (and `react-dom >= 18` if you render to the DOM).

## Setup

The provider is optional. It gives the hooks below it their pack sources and load options, and can start
loading on mount:

```tsx
import { CipetpetProvider } from "cipetpet-react";

export function Root() {
  return (
    <CipetpetProvider
      tts={{ source: "/packs/antalia-mini-int8.cpet" }}
      stt={{ source: "/packs/duyu-small-int8.cpet", useWorker: true }}
      preload={["stt"]}          // or `true` for both
      disposeDelayMs={30_000}    // keep models 30 s after the last user unmounts
    >
      <App />
    </CipetpetProvider>
  );
}
```

Without a provider, give each hook a `source`: `useTextToSpeech({ source: "/packs/antalia-mini-int8.cpet" })`.
A hook's options override the provider's, field by field.

## Text to speech

```tsx
import { useState } from "react";
import { useTextToSpeech } from "cipetpet-react";

export function Speaker() {
  const tts = useTextToSpeech({ speed: 0.95, seed: 0 }); // source from the provider
  const [text, setText] = useState("Merhaba! Bugün hava çok güzel.");

  const download = () => {
    const url = URL.createObjectURL(tts.getWavBlob());
    Object.assign(document.createElement("a"), { href: url, download: "speech.wav" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div>
      <p>
        {tts.status}
        {tts.status === "loading" && tts.progress?.total ? ` ${Math.round((100 * tts.progress.loaded) / tts.progress.total)}%` : ""}
        {tts.status === "error" && <button onClick={() => void tts.retry().catch(() => {})}>Retry ({tts.error?.message})</button>}
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      {/* call speak() directly in the click handler: see "Autoplay" below */}
      <button onClick={() => tts.speak(text).catch(console.error)} disabled={tts.status === "loading"}>Speak</button>
      <button onClick={tts.stop} disabled={!tts.isSpeaking && !tts.isSynthesizing}>Stop</button>
      <button onClick={download} disabled={!tts.result}>Download WAV</button>
      {tts.modelText && <p>Model read: {tts.modelText}</p>}
    </div>
  );
}
```

**Autoplay.** Browsers only let an `AudioContext` start inside a user gesture. `speak()` creates (the first
time) and resumes the hook's AudioContext **synchronously, at the start of the call**, so call it straight from
an event handler, not after an `await` or inside a `setTimeout`. The context is reused by later calls and closed
on unmount; pass `audioContext` to use your own.

`speak()` streams sentence chunks into a gapless player and resolves when playback ends. A new `speak()`
cancels the previous one; `stop()` aborts synthesis and playback; both make the cancelled `speak()` resolve
(not reject). `synthesize()` returns the whole `SynthesisResult` without playing it.

## Speech to text

```tsx
import { useState } from "react";
import { useSpeechToText } from "cipetpet-react";

export function Listener() {
  const stt = useSpeechToText({ lang: "tr" });
  const [error, setError] = useState<string>();

  // toggle: press to start, press again to stop and transcribe
  const toggle = () =>
    stt.isRecording
      ? stt.stopRecording().catch((e) => setError(e.message))
      : stt.startRecording().catch((e) => setError(e.message)); // NotAllowedError when the mic is refused

  // or hold to talk:
  //   <button
  //     onPointerDown={() => stt.startRecording().catch(() => {})}
  //     onPointerUp={() => stt.stopRecording().catch(() => {})}  // rejects when the mic was refused
  //   >

  return (
    <div>
      <button onClick={toggle} aria-pressed={stt.isRecording} disabled={!stt.isRecording && stt.isTranscribing}>
        {stt.isRecording ? "Stop" : "Record"}
      </button>
      <meter min={0} max={1} value={stt.level} />
      <input
        type="file"
        accept="audio/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) stt.transcribe(file).catch((err) => setError(err.message));
        }}
      />
      {stt.isTranscribing && <p>Transcribing…</p>}
      <p>{stt.transcript}</p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
```

`transcribe()` takes a `Float32Array` (mono, at `opts.sampleRate`, default 16000) or an audio file
(`Blob` / `File` / `ArrayBuffer` / `Uint8Array`: WAV is parsed directly, other formats go through the browser's
decoder, then everything is resampled to 16 kHz). When several transcriptions overlap, `transcript` / `result`
follow call order: an older call that finishes late does not overwrite a newer result (its own promise still
resolves with its own result).

`startRecording()` asks for the microphone (call it from a click; it needs https or localhost), and also starts
loading the model so it is ready when you stop. `level` is the microphone RMS (0..1), updated at most once per
animation frame.

## Components

```tsx
import { RecordButton, SpeakButton } from "cipetpet-react";

<SpeakButton text="Merhaba dünya" className="btn" options={{ speed: 1.05 }} onError={console.error} />

<RecordButton lang="tr" onResult={(r) => setText(r.text)}>
  {({ isRecording, isTranscribing, level }) =>
    isRecording ? `Stop (${Math.round(level * 100)})` : isTranscribing ? "…" : "Record"}
</RecordButton>
```

Both render a plain `<button type="button">` with `aria-pressed` (the toggle state), `aria-busy` (loading /
working) and `data-status` (the model status); every other button prop is passed through. Children may be a
render function of the state. They are disabled while the model loads (`RecordButton` stays enabled while
recording, so it can always be stopped).

## Serving notes

* **Pack files.** Serve the `.cpet` packs as static files (any MIME type works; `application/octet-stream` is
  fine). They are large: enable HTTP caching, or pass `cache: true` to keep a copy in the Cache API. A pack can
  also come from bytes or a `File` (`source: file`): keep such objects stable (state / memo), since non-string
  sources are cached by identity.
* **ONNX Runtime WASM.** Packs built with the embedded runtime need nothing else. Otherwise ORT loads
  `ort-wasm-simd-threaded.wasm` / `.mjs` from next to its own script; if your bundler moves things around,
  copy those files from `onnxruntime-web/dist/` to your public folder and set `wasmPaths: "/ort/"` (on the
  provider's `tts` / `stt`, or on a hook).
* **Threads.** Multi-threaded WASM needs a cross-origin isolated page:
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or
  `credentialless`). Without them cipetpet runs single-threaded, which works everywhere, only slower.
* **Workers.** `useWorker: true` runs the model in a dedicated module Worker (keeps the main thread smooth).
  The core's `worker.js` must be reachable: bundlers that understand `new URL("./worker.js", import.meta.url)`
  handle it; otherwise pass `worker: "/path/to/cipetpet/worker.js"` or a `Worker` instance. A supplied Worker
  instance is single-use: it is terminated when its model is disposed or when its load fails, so a retry cannot
  reuse it (pass a worker URL/string if you want retries; keep a `Worker` instance out of render, a new one per
  render is a new model). With a worker, `transcribe()` transfers the `Float32Array`'s buffer (the array is
  detached afterwards), unless the array is a view on a larger buffer, which is copied instead. A relative pack
  URL is resolved against the page, not the worker script. Functions and modules cannot be posted to a worker:
  `fetch` and `ort` options are rejected with `useWorker`.
* **Microphone.** `getUserMedia` needs a secure context (https or localhost).

### Next.js / React Server Components

The package entry starts with `"use client"`, so you can import the hooks and components from a client
component, and render `<CipetpetProvider>` from a layout (it is a client component itself). Nothing touches
`window`, `navigator` or `AudioContext` at import time or during render; loading starts in effects only, so
server rendering shows `status: "idle"`. Put the packs in `public/` and set COOP/COEP headers in
`next.config.js` `headers()` if you want threads.

## API reference

### `<CipetpetProvider>`

| prop | type | |
| --- | --- | --- |
| `tts` | `ModelOptions` | defaults for the TTS model (`source`, load options, `useWorker`, `worker`) |
| `stt` | `ModelOptions` | defaults for the STT model |
| `preload` | `boolean \| ("tts" \| "stt")[]` | start loading on mount (default `false`) |
| `disposeDelayMs` | `number` | ms a model stays loaded after its last user unmounts (default 1000; `Infinity` = never) |

`ModelOptions` = cipetpet's `LoadOptions` (`backend`, `threads`, `wasmPaths`, `wasmBinary`, `proxy`, `cache`,
`verify`, `fetch`, `requestInit`, `onProgress`, …) plus `source?: PackSource`, `useWorker?: boolean`,
`worker?: Worker | URL | string`. Models are shared by kind + source + these options (functions such as
`onProgress` / `fetch` are not part of the identity). Keep object-valued options stable (module-level constants or
`useMemo`) and do not create a `Worker`, `File` or `Blob` inline in render: those are compared by identity. A provider-level `onProgress` is called for provider
preloads; a hook-level one for loads while that hook is mounted.

### `useTextToSpeech(options?)`

Options: `ModelOptions` + `autoLoad` (default `true`) + `disposeDelayMs` + synthesis defaults (`seed`, `steps`,
`cfg`, `speed`, `temperature`, `raw`) + `audioContext`.

| returns | type | |
| --- | --- | --- |
| `status` | `"idle" \| "loading" \| "ready" \| "error"` | model state |
| `progress` | `{loaded, total} \| null` | pack download progress (`total` 0 when unknown) |
| `error` | `Error \| null` | load error |
| `model` | `AntaliaMini \| AntaliaWorker \| null` | the shared instance |
| `load()` / `retry()` | `() => Promise<model>` | load now (with `autoLoad: false`) / again after an error |
| `speak(text, opts?)` | `Promise<void>` | stream + play; resolves when playback ends or is cancelled |
| `synthesize(text, opts?)` | `Promise<SynthesisResult>` | whole audio, no playback; AbortError when stopped |
| `stop()` | `() => void` | abort all synthesis and playback |
| `normalize(text)` | `Promise<string>` | the model text the normaliser produces |
| `isSynthesizing` / `isSpeaking` | `boolean` | |
| `result` | `SynthesisResult \| null` | the latest finished synthesis (speak or synthesize) |
| `modelText` | `string` | `result.modelText` |
| `getWavBlob(result?)` | `Blob` | 16-bit WAV of `result` (default: the latest) |

### `useSpeechToText(options?)`

Options: `ModelOptions` + `autoLoad` + `disposeDelayMs` + transcription defaults (`lang`, `mode`, `beam`,
`tailPad`, `ctcWeight`).

| returns | type | |
| --- | --- | --- |
| `status`, `progress`, `error`, `model`, `load()`, `retry()` | | as above (`model`: `DuyuSmall \| DuyuWorker`) |
| `transcribe(input, opts?)` | `Promise<TranscriptionResult>` | `Float32Array \| Blob \| File \| ArrayBuffer \| Uint8Array` |
| `startRecording(opts?)` | `Promise<void>` | `{deviceId?, constraints?}`; no-op while recording |
| `stopRecording(opts?)` | `Promise<TranscriptionResult>` | stop the mic and transcribe (`TranscribeOptions`) |
| `cancelRecording()` | `() => void` | stop the mic, drop the audio |
| `isRecording` / `isTranscribing` | `boolean` | |
| `level` | `number` | mic level 0..1, per animation frame |
| `transcript` | `string` | latest text |
| `result` | `TranscriptionResult \| null` | latest result |

### `useAntalia(options?)` / `useDuyu(options?)`

Just the model: `{ status, progress, error, model, load, retry }`. Use them to call the core API directly
(`model.stream()`, `model.transcribe()` with your own options).

### Lifecycle guarantees

* Every function a hook returns is referentially stable; changing options never reloads unless the model
  identity (source / load options) changes.
* On unmount, synthesis and transcriptions are aborted, playback and the microphone stop, and no state is set
  afterwards.
* `clearModelCache()` disposes every cached model now (mounted hooks reload on their next use).
  `modelRegistry` exposes the cache itself (`acquire`, `subscribe`, `getSnapshot`) for non-React code.

## Development

```sh
npm install
npm run typecheck   # tsc against ../cipetpet/src
npm test            # vitest + jsdom, with the core mocked (test/fake-core.ts)
npm run build       # dist/ (ESM + .d.ts, "use client" entry)
cd ../cipetpet && npm run build
cd ../cipetpet-react && npm run example
cd ../cipetpet && npm run serve   # then open http://127.0.0.1:4173/cipetpet-react/example/
```

`tsconfig.json` maps `"cipetpet"` to the core's TypeScript sources in `../cipetpet/src` so the wrapper is
checked against the real code while both are developed side by side (`contract/cipetpet.d.ts`, the original API
contract, is only a type-check fallback if those sources are missing). `npm run build` needs the core built
(`../cipetpet`, `npm run build`) and stops with an error otherwise, so published declarations are always checked
against the real core. The example bundles against the core
source or its build, and the core server serves the project with cross-origin isolation headers. None of this is
published: the package imports plain `"cipetpet"`, which resolves to the real dependency in your app.

## License

Apache-2.0
