// @vitest-environment jsdom
// UI smoke test: <Conversation> with the voice adapter (src/voice/cipetpet.ts) replaced by fakes.
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "../src/ui/Conversation.tsx";
import { I18nContext, translator } from "../src/ui/i18n.ts";
import { DEFAULT_SETTINGS } from "../src/ui/settings.ts";
import type { ServerConfig } from "../src/ui/useServerConfig.ts";
import { FakeAudio, FakeMic, FakeStt, FakeTts } from "./fakes.ts";
import { sleep } from "./helpers.ts";

const fx = vi.hoisted(() => ({ mic: null as unknown, stt: null as unknown, tts: null as unknown, sttReady: false }));

vi.mock("../src/voice/cipetpet.ts", () => {
  const view = (ready: boolean) => ({ status: ready ? "ready" : "loading", progress: null, loadedBytes: 0, totalBytes: 0, error: null, retry() {}, detail: null });
  return {
    PACK_MB: {},
    ttsPack: (m: string) => (m === "ema" ? "ema-lightning-fp32.cpet" : "antalia-mini-mixed.cpet"),
    sttPack: (p: string) => `duyu-small-${p}.cpet`,
    workerSupported: () => false,
    createMicInput: () => fx.mic,
    createAudioOut: () => new (fx.tts as { Audio: new () => unknown }).Audio(),
    useVoiceModels: () => ({
      tts: view(true),
      stt: view(fx.sttReady),
      ttsEngine: fx.tts as { engine: unknown } | null,
      sttEngine: fx.sttReady ? fx.stt : null,
    }),
  };
});

const SERVER: ServerConfig = { loaded: true, proxy: false, defaultModel: "openai/gpt-4o", provider: null, providers: [], packs: {} };

function renderConversation(handsFree: boolean) {
  const i18n = { lang: "en" as const, t: translator("en") };
  return render(
    <StrictMode>
      <I18nContext.Provider value={i18n}>
        <Conversation settings={{ ...DEFAULT_SETTINGS, handsFree, backend: "echo", uiLang: "en" }} update={() => {}} server={SERVER} />
      </I18nContext.Provider>
    </StrictMode>,
  );
}

beforeEach(() => {
  fx.mic = new FakeMic();
  fx.stt = new FakeStt();
  fx.tts = Object.assign(new FakeTts(), { Audio: FakeAudio });
  fx.sttReady = false;
  localStorage.clear();
});
afterEach(() => cleanup());

describe("<Conversation>", () => {
  it("a persisted hands-free setting starts paused: no mic, no 'not loaded' error, before or after the models load", async () => {
    const view = renderConversation(true);
    await act(async () => void (await sleep(30)));
    expect((fx.mic as FakeMic).opens).toHaveLength(0);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(screen.getByText(translator("en")("phase.handsFreePaused"))).toBeTruthy();

    // the speech model arrives: still waiting for the mic button (no gesture yet, so no audio either)
    fx.sttReady = true;
    view.rerender(
      <StrictMode>
        <I18nContext.Provider value={{ lang: "en", t: translator("en") }}>
          <Conversation settings={{ ...DEFAULT_SETTINGS, handsFree: true, backend: "echo", uiLang: "en" }} update={() => {}} server={SERVER} />
        </I18nContext.Provider>
      </StrictMode>,
    );
    await act(async () => void (await sleep(30)));
    expect((fx.mic as FakeMic).opens).toHaveLength(0);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("without hands-free it renders idle and does not touch the mic either", async () => {
    renderConversation(false);
    await act(async () => void (await sleep(20)));
    expect((fx.mic as FakeMic).opens).toHaveLength(0);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });
});
