// cipetpet-react example: a TTS panel, an STT panel and a round trip ("speak what I said").
// Build with `npm run example` (example/build.mjs), then run `npm run serve` in ../cipetpet: it serves the parent
// folder with the COOP/COEP headers (threads) and the packs at ../../cipetpet/packs/ are reachable. Open
// http://127.0.0.1:4173/cipetpet-react/example/ (a plain static server works too, but runs single-threaded).
// Query parameters: ?tts=<pack url>&stt=<pack url>&worker=<url of cipetpet's built worker.js>

import { StrictMode, useState, type ChangeEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  CipetpetProvider,
  useSpeechToText,
  useTextToSpeech,
  type DuyuLanguage,
  type PackProgress,
} from "cipetpet-react";

const params = new URLSearchParams(location.search);
const TTS_PACK = params.get("tts") ?? "../../cipetpet/packs/antalia-mini-int8.cpet";
const STT_PACK = params.get("stt") ?? "../../cipetpet/packs/duyu-small-int8.cpet";
// example/build.mjs copies ONNX Runtime's .wasm/.mjs files next to the bundle (packs that embed the runtime
// binary do not need them)
const WASM_PATHS = new URL("./dist/", location.href).href;
// The core's worker script must be served as its own file; this example runs the models in-thread unless
// ?worker=<url of cipetpet's built worker.js> is given.
const WORKER = params.get("worker");

function percent(p: PackProgress | null): string {
  if (!p) return "";
  return p.total > 0 ? ` ${Math.round((100 * p.loaded) / p.total)}%` : ` ${(p.loaded / 1e6).toFixed(1)} MB`;
}

function TtsPanel() {
  const tts = useTextToSpeech({ speed: 0.95 });
  const [text, setText] = useState("Merhaba! Bugün hava çok güzel. Size nasıl yardımcı olabilirim?");
  const [error, setError] = useState<string | null>(null);

  const speak = () => {
    setError(null);
    // called straight from the click: the AudioContext starts inside the gesture
    tts.speak(text).catch((e: Error) => setError(e.message));
  };
  const download = () => {
    const url = URL.createObjectURL(tts.getWavBlob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "cipetpet.wav";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section aria-labelledby="tts-title">
      <h2 id="tts-title">Text to speech</h2>
      <p role="status">
        Model: {tts.status}
        {tts.status === "loading" && percent(tts.progress)}
        {tts.error && ` (${tts.error.message})`} {tts.status === "error" && <button onClick={() => void tts.retry().catch(() => {})}>Retry</button>}
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} cols={60} aria-label="Text to speak" />
      <div>
        <button onClick={speak} disabled={tts.status === "loading" || !text.trim()}>
          Speak
        </button>
        <button onClick={tts.stop} disabled={!tts.isSpeaking && !tts.isSynthesizing}>
          Stop
        </button>
        <button onClick={download} disabled={!tts.result}>
          Download WAV
        </button>
      </div>
      {tts.isSynthesizing && <p>Synthesising…</p>}
      {tts.modelText && (
        <p>
          Model text: <code>{tts.modelText}</code>
          {tts.result && ` (${tts.result.stats.seconds.toFixed(1)} s audio, RTF ${tts.result.stats.rtf.toFixed(2)})`}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function SttPanel({ onTranscript }: { onTranscript(text: string): void }) {
  const [lang, setLang] = useState<DuyuLanguage>("tr");
  const stt = useSpeechToText({ lang });
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    setError(null);
    if (stt.isRecording) {
      stt.stopRecording().then((r) => onTranscript(r.text), (e: Error) => setError(e.message));
    } else {
      stt.startRecording().catch((e: Error) => setError(e.message));
    }
  };
  const upload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    stt.transcribe(file).then((r) => onTranscript(r.text), (err: Error) => setError(err.message));
  };

  return (
    <section aria-labelledby="stt-title">
      <h2 id="stt-title">Speech to text</h2>
      <p role="status">
        Model: {stt.status}
        {stt.status === "loading" && percent(stt.progress)}
        {stt.error && ` (${stt.error.message})`}
      </p>
      <label>
        Language{" "}
        <select value={lang} onChange={(e) => setLang(e.target.value as DuyuLanguage)}>
          <option value="tr">Turkish</option>
          <option value="en">English</option>
          <option value="mix">Mixed</option>
          <option value="auto">Detect</option>
        </select>
      </label>
      <div>
        <button onClick={toggle} aria-pressed={stt.isRecording} disabled={!stt.isRecording && stt.isTranscribing}>
          {stt.isRecording ? "Stop and transcribe" : "Record"}
        </button>
        <meter min={0} max={1} value={stt.level} aria-label="Microphone level" />
        {stt.isRecording && <button onClick={stt.cancelRecording}>Cancel</button>}
      </div>
      <label>
        Or transcribe a file: <input type="file" accept="audio/*" onChange={upload} />
      </label>
      {stt.isTranscribing && <p>Transcribing…</p>}
      {stt.transcript && (
        <p>
          Transcript ({stt.result?.lang}): <strong>{stt.transcript}</strong>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function RoundTrip({ text }: { text: string }) {
  // shares the provider's TTS model with TtsPanel: one instance, loaded once
  const tts = useTextToSpeech();
  return (
    <section aria-labelledby="rt-title">
      <h2 id="rt-title">Round trip</h2>
      <p>Last transcript: {text || "(record something first)"}</p>
      <button onClick={() => void tts.speak(text).catch(() => {})} disabled={!text || tts.status !== "ready"}>
        Speak what I said
      </button>
    </section>
  );
}

function App() {
  const [heard, setHeard] = useState("");
  return (
    <>
      <h1>cipetpet-react</h1>
      <TtsPanel />
      <SttPanel onTranscript={setHeard} />
      <RoundTrip text={heard} />
    </>
  );
}

const shared = {
  wasmPaths: WASM_PATHS,
  ...(WORKER ? { useWorker: true, worker: WORKER } : {}),
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CipetpetProvider tts={{ source: TTS_PACK, ...shared }} stt={{ source: STT_PACK, ...shared }} preload>
      <App />
    </CipetpetProvider>
  </StrictMode>,
);
