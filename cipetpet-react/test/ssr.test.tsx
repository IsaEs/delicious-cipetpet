// @vitest-environment node
// Server rendering: no window / navigator / AudioContext exist here, so any access would throw.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CipetpetProvider,
  RecordButton,
  SpeakButton,
  useAntalia,
  useSpeechToText,
  useTextToSpeech,
} from "../src/index.js";
import { modelRegistry } from "../src/registry.js";
import { fake } from "./fake-core.js";

function App() {
  const tts = useTextToSpeech();
  const stt = useSpeechToText({ source: "/d.cpet" });
  const raw = useAntalia({ source: new URL("https://example.com/a.cpet") });
  return (
    <main>
      <p id="tts">{tts.status}</p>
      <p id="stt">{stt.status}</p>
      <p id="raw">{raw.status}</p>
      <SpeakButton text="Merhaba" />
      <RecordButton />
    </main>
  );
}

describe("SSR", () => {
  it("renders with renderToString without touching browser globals or loading anything", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof navigator === "undefined" || !("mediaDevices" in navigator)).toBe(true);
    const html = renderToString(
      <CipetpetProvider tts={{ source: "/a.cpet" }} stt={{ source: "/d.cpet" }} preload>
        <App />
      </CipetpetProvider>,
    );
    expect(html).toContain('<p id="tts">idle</p>');
    expect(html).toContain('<p id="stt">idle</p>');
    expect(html).toContain('<p id="raw">idle</p>');
    expect(html).toContain("Speak");
    expect(html).toContain("Record");
    expect(fake.loads).toHaveLength(0);
    expect(fake.players).toHaveLength(0);
    expect(fake.recorders).toHaveLength(0);
    expect(modelRegistry.size).toBe(0); // nothing acquired during render
  });
});
