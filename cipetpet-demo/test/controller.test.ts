import { describe, expect, it } from "vitest";
import { ConversationController, type ControllerDeps, type ConversationSettings } from "../src/conversation/controller.ts";
import type { AssistantMessage, Phase } from "../src/conversation/types.ts";
import { ChatError } from "../src/llm/types.ts";
import { FakeAudio, FakeBackend, FakeMic, FakeStt, FakeTts } from "./fakes.ts";
import { sleep, until } from "./helpers.ts";

const SETTINGS: ConversationSettings = {
  model: "openai/gpt-4o",
  temperature: 0.7,
  maxTokens: 300,
  systemPrompt: "Türkçe yanıt ver.",
  sttLang: "mix",
  sttBeam: 5,
  ttsSpeed: 1,
  ttsSeed: 0,
  vad: { startMs: 100, endSilenceMs: 200, minLevel: 0.02, ratio: 3, initialFloor: 0.003 },
  echoCancellation: false,
  bargeIn: false,
  history: {},
};

function setup(
  over: Partial<ConversationSettings> = {},
  opts: { tts?: boolean; stt?: boolean; handsFree?: boolean; deps?: Partial<ControllerDeps> } = {},
) {
  const mic = new FakeMic();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const audio = new FakeAudio();
  const backend = new FakeBackend();
  const settings = { ...SETTINGS, ...over };
  const c = new ConversationController(
    {
      getStt: () => (opts.stt === false ? null : stt),
      getTts: () => (opts.tts === false ? null : tts),
      getBackend: () => backend,
      getSettings: () => settings,
      mic,
      audio,
      holdMs: 1000,
      ...opts.deps,
    },
    { handsFree: opts.handsFree ?? false },
  );
  const phases: Phase[] = [c.getState().phase];
  c.subscribe(() => {
    const p = c.getState().phase;
    if (phases[phases.length - 1] !== p) phases.push(p);
  });
  const reply = () => c.getState().messages.find((m): m is AssistantMessage => m.role === "assistant");
  return { c, mic, stt, tts, audio, backend, settings, phases, reply };
}

/** tap, wait for the mic, tap again: one push-to-talk turn */
async function speakTurn(env: ReturnType<typeof setup>) {
  env.c.toggleMic();
  await until(() => env.mic.current?.state === "open", 1000, "mic open");
  env.c.toggleMic();
}

describe("ConversationController", () => {
  it("runs a full push-to-talk turn: listen -> transcribe -> think -> speak -> idle, with timings", async () => {
    const env = setup();
    env.backend.deltas = ["**Merhaba!** ", "Bugün size ", "nasıl yardımcı olabilirim? ", "İyi günler dilerim."];
    await speakTurn(env);
    await until(() => env.c.getState().phase === "idle" && env.phases.length > 1, 4000, "turn end");

    expect(env.phases).toEqual(["idle", "listening", "transcribing", "thinking", "speaking", "idle"]);
    expect(env.audio.unlocked).toBeGreaterThan(0); // the press unlocked audio
    expect(env.stt.calls[0]).toMatchObject({ lang: "mix", beam: 5 });

    const [user, assistant] = env.c.getState().messages;
    expect(user).toMatchObject({ role: "user", text: "Merhaba, nasılsın?", source: "voice", lang: "tr" });
    expect(assistant).toMatchObject({ role: "assistant", status: "done", text: "**Merhaba!** Bugün size nasıl yardımcı olabilirim? İyi günler dilerim.", speaking: null });
    const a = assistant as AssistantMessage;
    for (const k of ["sttMs", "ttftMs", "ttfaMs", "totalMs"] as const) expect(a.timings[k], k).toBeGreaterThanOrEqual(0);
    expect(a.timings.ttfaMs!).toBeLessThan(a.timings.totalMs!);
    expect(a.sentences.map((s) => a.text.slice(s.start, s.end))).toEqual(["**Merhaba!** Bugün size nasıl yardımcı olabilirim?", "İyi günler dilerim."]);

    // markdown stripped before TTS; the LLM got system prompt + the user's words
    expect(env.tts.texts).toEqual(["Merhaba! Bugün size nasıl yardımcı olabilirim?", "İyi günler dilerim."]);
    expect(env.backend.calls[0].messages).toEqual([
      { role: "system", content: "Türkçe yanıt ver." },
      { role: "user", content: "Merhaba, nasılsın?" },
    ]);
    expect(env.backend.calls[0].opts).toMatchObject({ model: "openai/gpt-4o", temperature: 0.7, maxTokens: 300 });
  });

  it("synthesises sentence k+1 while sentence k plays, and starts speaking before the LLM has finished", async () => {
    const env = setup();
    env.backend.deltas = ["Birinci cümle burada bitiyor. ", "İkinci cümle de ", "burada bitiyor. ", "Üçüncü cümle ", "en sonda geliyor."];
    env.backend.deltaMs = 40;
    env.tts.synthMs = 20; // 2 chunks of 0.1 s audio each: 40 ms work for 200 ms of speech
    env.c.sendText("Üç cümle söyle.");
    await until(() => env.c.getState().phase === "idle" && env.audio.played.length > 0, 5000, "turn end");

    const s1 = "Birinci cümle burada bitiyor.";
    const s2 = "İkinci cümle de burada bitiyor.";
    const s3 = "Üçüncü cümle en sonda geliyor.";
    expect(env.tts.texts).toEqual([s1, s2, s3]);
    const start = (text: string) => env.tts.events.find((e) => e.kind === "synth-start" && e.text === text)!.t;
    // overlap: the next sentence is being synthesised while the previous one is still playing
    expect(start(s2)).toBeLessThan(env.audio.span(s1).end);
    expect(start(s3)).toBeLessThan(env.audio.span(s2).end);
    // gapless: each sentence starts where the previous one ends
    expect(env.audio.span(s2).start).toBeCloseTo(env.audio.span(s1).end, 0);
    // low latency: the first sentence was synthesised (and was playing) before the LLM's last token
    expect(start(s1)).toBeLessThan(env.backend.lastDeltaAt);
    expect(env.audio.span(s1).start).toBeLessThan(env.backend.lastDeltaAt);
  });

  it("highlights the sentence being spoken", async () => {
    const env = setup();
    env.backend.deltas = ["Birinci cümle burada bitiyor. ", "İkinci cümle de burada bitiyor."];
    env.tts.chunkSeconds = 0.15;
    const seen = new Set<number>();
    env.c.subscribe(() => {
      const r = env.reply();
      if (r?.speaking !== null && r?.speaking !== undefined) seen.add(r.speaking);
    });
    env.c.sendText("İki cümle.");
    await until(() => env.c.getState().phase === "idle" && seen.size > 0, 5000, "turn end");
    expect([...seen]).toEqual([0, 1]);
    expect(env.reply()!.speaking).toBeNull();
  });

  it("barge-in by mic press aborts the LLM stream and TTS at once and starts listening", async () => {
    const env = setup();
    env.backend.deltas = ["Uzun bir hikâye anlatacağım. ", ...Array.from({ length: 40 }, (_, i) => `parça ${i} `)];
    env.backend.deltaMs = 30;
    env.tts.chunkSeconds = 0.5;
    env.c.sendText("Bir hikâye anlat.");
    await until(() => env.c.getState().phase === "speaking", 3000, "speaking");

    const stopsBefore = env.audio.stops;
    env.c.micDown();
    env.c.micUp();
    expect(env.c.getState().phase).toBe("listening");
    expect(env.audio.stops).toBeGreaterThan(stopsBefore); // playback cut synchronously
    expect(env.tts.signals.every((s) => s.aborted)).toBe(true);
    await until(() => env.backend.finished.length === 1, 1000, "LLM stream end");
    expect(env.backend.finished[0].aborted).toBe(true);
    expect(env.reply()).toMatchObject({ status: "interrupted", speaking: null });

    // the aborted turn never touches the state again
    const textNow = env.reply()!.text;
    await sleep(150);
    expect(env.reply()!.text).toBe(textNow);
    expect(env.c.getState().phase).toBe("listening");
    await until(() => env.mic.current?.state === "open", 1000, "mic open");

    // the new turn goes through
    env.backend.deltas = ["Tamam, dinliyorum."];
    env.c.toggleMic();
    await until(() => env.c.getState().phase === "idle", 3000, "second turn");
    const replies = env.c.getState().messages.filter((m) => m.role === "assistant");
    expect(replies.map((m) => (m as AssistantMessage).status)).toEqual(["interrupted", "done"]);
  });

  it("Stop during thinking returns to idle and nothing hangs or arrives later", async () => {
    const env = setup();
    env.backend.firstMs = 200;
    env.c.sendText("Merhaba");
    expect(env.c.getState().phase).toBe("thinking");
    await sleep(20);
    env.c.stop();
    expect(env.c.getState().phase).toBe("idle");
    await until(() => env.backend.finished.length === 1, 1000, "LLM abort");
    expect(env.backend.finished[0].aborted).toBe(true);
    await sleep(250);
    expect(env.reply()).toMatchObject({ status: "interrupted", text: "" });
    expect(env.c.getState().notices).toEqual([]); // an abort is not an error
  });

  it("Stop while listening cancels the recording; Stop while transcribing aborts STT", async () => {
    const env = setup();
    env.c.toggleMic();
    await until(() => env.mic.current?.state === "open", 1000, "mic open");
    env.c.stop();
    expect(env.c.getState().phase).toBe("idle");
    expect(env.mic.current?.state).toBe("cancelled");

    env.stt.ms = 300;
    await speakTurn(env);
    await until(() => env.c.getState().phase === "transcribing" && env.stt.calls.length === 1, 1000, "transcribing");
    env.c.stop();
    expect(env.c.getState().phase).toBe("idle");
    expect(env.stt.calls[0].signal?.aborted).toBe(true);
    await sleep(350);
    expect(env.c.getState().messages).toEqual([]);
    expect(env.backend.calls).toHaveLength(0);
  });

  it("an empty transcript goes back without calling the LLM (push-to-talk: idle)", async () => {
    const env = setup();
    env.stt.reply = { text: "  ", lang: "tr" };
    await speakTurn(env);
    await until(() => env.stt.calls.length === 1 && env.c.getState().phase === "idle", 2000, "back to idle");
    expect(env.backend.calls).toHaveLength(0);
    expect(env.c.getState().messages).toEqual([]);
  });

  it("an empty transcript in hands-free mode goes back to listening with a fresh mic session", async () => {
    const env = setup({}, { handsFree: true });
    env.stt.reply = { text: "", lang: "tr" };
    await speakTurn(env);
    await until(() => env.stt.calls.length === 1 && env.c.getState().phase === "listening" && env.mic.sessions.length === 2, 2000, "listening again");
    expect(env.backend.calls).toHaveLength(0);
    expect(env.mic.current?.state).toBe("open");
    env.c.stop();
  });

  it("a recording that is too short counts as empty and never reaches STT", async () => {
    const env = setup();
    env.mic.seconds = 0.1;
    await speakTurn(env);
    await until(() => env.c.getState().phase === "idle" && env.phases.includes("transcribing"), 2000, "idle");
    expect(env.stt.calls).toHaveLength(0);
  });

  it("an LLM error surfaces as a toast, stops audio and returns to idle", async () => {
    const env = setup();
    env.backend.error = { afterDeltas: 2, error: new ChatError("OpenRouter rejected the request: invalid API key (401)", "invalid_key", 401) };
    env.c.sendText("Merhaba");
    await until(() => env.c.getState().notices.length === 1, 2000, "error notice");
    const s = env.c.getState();
    expect(s.phase).toBe("idle");
    expect(s.notices[0]).toMatchObject({ kind: "error", code: "invalid_key", message: expect.stringContaining("invalid API key") });
    expect(env.reply()!.status).toBe("error");
    expect(env.audio.stops).toBeGreaterThan(0);
  });

  it("STT and TTS errors also end in idle with a toast", async () => {
    const env = setup();
    env.stt.error = new Error("decoder exploded");
    await speakTurn(env);
    await until(() => env.c.getState().notices.length === 1, 2000, "stt error");
    expect(env.c.getState()).toMatchObject({ phase: "idle", notices: [{ message: "decoder exploded" }] });

    const env2 = setup();
    env2.tts.stream = async function* () {
      yield new Float32Array(10);
      throw new Error("vocoder failed");
    };
    env2.c.sendText("Merhaba");
    await until(() => env2.c.getState().notices.length === 1, 2000, "tts error");
    expect(env2.c.getState()).toMatchObject({ phase: "idle", notices: [{ message: "vocoder failed" }] });
    await until(() => env2.backend.finished.length === 1, 1000, "LLM aborted after TTS failure");
    expect(env2.backend.finished[0].aborted).toBe(true);
  });

  it("mic permission errors become a mic notice", async () => {
    const env = setup();
    env.mic.fail = new Error("Permission denied");
    env.c.toggleMic();
    await until(() => env.c.getState().notices.length === 1, 1000, "mic error");
    expect(env.c.getState()).toMatchObject({ phase: "idle", notices: [{ key: "mic", message: "Permission denied" }] });
  });

  it("refuses to listen while speech recognition is not loaded", () => {
    const env = setup({}, { stt: false });
    env.c.toggleMic();
    expect(env.c.getState()).toMatchObject({ phase: "idle", notices: [{ key: "stt-not-ready" }] });
    expect(env.mic.opens).toHaveLength(0);
  });

  it("resumes hands-free listening after an assistant backend error", async () => {
    const env = setup({}, { handsFree: true });
    env.backend.error = { afterDeltas: 0, error: new ChatError("temporarily unavailable", "network") };
    env.c.sendText("Merhaba");
    await until(() => env.c.getState().phase === "listening" && env.mic.current?.state === "open", 3000, "hands-free resumes");
    expect(env.c.getState().handsFree).toBe(true);
    expect(env.c.getState().notices.at(-1)).toMatchObject({ key: "generic", message: "temporarily unavailable" });
    env.c.stop();
  });

  it("without TTS the reply is shown as text only and the turn still completes", async () => {
    const env = setup({}, { tts: false });
    env.c.sendText("Merhaba");
    await until(() => env.c.getState().phase === "idle" && env.reply()?.status === "done", 3000, "done");
    expect(env.reply()).toMatchObject({ silent: true });
    expect(env.c.getState().notices[0]).toMatchObject({ key: "tts-not-ready" });
  });

  it("mentions the Turkish-only TTS once when the user speaks English", async () => {
    const env = setup();
    env.stt.reply = { text: "What is the weather like?", lang: "en" };
    await speakTurn(env);
    await until(() => env.c.getState().phase === "idle" && env.reply()?.status === "done", 3000, "turn 1");
    await speakTurn(env);
    await until(() => env.c.getState().messages.length === 4 && env.c.getState().phase === "idle", 3000, "turn 2");
    expect(env.c.getState().notices.filter((n) => n.key === "english-tts")).toHaveLength(1);
  });

  it("hold-to-talk: a long press ends the turn on release", async () => {
    const env = setup();
    const c = new ConversationController(
      { getStt: () => env.stt, getTts: () => env.tts, getBackend: () => env.backend, getSettings: () => env.settings, mic: env.mic, audio: env.audio, holdMs: 50 },
    );
    c.micDown();
    await until(() => env.mic.current?.state === "open", 1000, "mic open");
    await sleep(70);
    c.micUp();
    expect(c.getState().phase).toBe("transcribing");
    await until(() => c.getState().phase === "idle", 3000, "turn end");
    expect(c.getState().messages).toHaveLength(2);
  });

  it("hands-free: VAD ends the utterance, the turn runs, and listening resumes", async () => {
    const env = setup({}, { handsFree: true });
    env.c.setHandsFree(true);
    await until(() => env.mic.current?.state === "open", 1000, "mic open");
    const s = env.mic.current!;
    // silence, speech, silence: ~20 readings a second like MicRecorder
    for (let i = 0; i < 40; i++) (s.level(0.003), await sleep(10));
    for (let i = 0; i < 8; i++) (s.level(0.2), await sleep(25));
    expect(env.c.getState().phase).toBe("listening");
    for (let i = 0; i < 20 && env.c.getState().phase === "listening"; i++) (s.level(0.003), await sleep(25));
    expect(["transcribing", "thinking", "speaking"]).toContain(env.c.getState().phase);
    await until(() => env.reply()?.status === "done" && env.c.getState().phase === "listening" && env.mic.sessions.length === 2, 4000, "listening again");
    expect(env.mic.current?.state).toBe("open");
    // pre-roll trimming: the STT got less audio than the whole recording
    expect(env.stt.calls[0].samples).toBeLessThan(env.mic.seconds * 16000);
    env.c.stop();
    expect(env.mic.current?.state).toBe("cancelled");
  });

  it("hands-free barge-in by voice (echo cancellation on): speaking over the assistant interrupts it", async () => {
    const env = setup({ echoCancellation: true, bargeIn: true }, { handsFree: true });
    env.backend.deltas = ["Uzun bir hikâye anlatacağım şimdi. ", ...Array.from({ length: 30 }, (_, i) => `parça ${i}. `)];
    env.backend.deltaMs = 50;
    env.tts.chunkSeconds = 0.4;
    env.c.sendText("Hikâye anlat.");
    await until(() => env.c.getState().phase === "speaking", 3000, "speaking");
    await until(() => env.mic.sessions.length === 1 && env.mic.current?.state === "open", 1000, "monitor mic");
    expect(env.mic.opens[0].echoCancellation).toBe(true);
    const monitor = env.mic.current!;
    for (let i = 0; i < 4; i++) (monitor.level(0.003), await sleep(10));
    for (let i = 0; i < 12 && env.c.getState().phase === "speaking"; i++) (monitor.level(0.3), await sleep(25));
    expect(env.c.getState().phase).toBe("listening");
    expect(["interrupted", "done"]).toContain(env.reply()!.status); // the text stream may finish before its audio
    expect(env.tts.signals[0].aborted).toBe(true);
    await until(() => env.backend.finished.length === 1, 1000, "LLM stream settled");
    // when the reply was cut off mid-stream, the LLM request itself must have been aborted
    if (env.reply()!.status === "interrupted") expect(env.backend.finished[0].aborted).toBe(true);
    // the same recording carries on as the user's turn (no new getUserMedia)
    expect(env.mic.sessions).toHaveLength(1);
    expect(monitor.state).toBe("open");
    env.c.stop();
  });

  it("hands-free with nobody speaking: the idle session is renewed, silence never reaches the recogniser", async () => {
    // defaults are 25 s (cap) and 30 s (idle recycle): the cap must not fire first on a recording without speech
    const env = setup({}, { handsFree: true, deps: { maxUtteranceMs: 150, idleRecycleMs: 400 } });
    env.c.setHandsFree(true);
    await until(() => env.mic.current?.state === "open", 1000, "mic open");
    const first = env.mic.current!;
    for (let i = 0; i < 40 && env.mic.sessions.length < 2; i++) (env.mic.current!.level(0.003), await sleep(20));
    expect(env.mic.sessions.length).toBeGreaterThanOrEqual(2); // recycled
    expect(first.state).toBe("cancelled");
    expect(env.stt.calls).toHaveLength(0);
    expect(env.c.getState().phase).toBe("listening");
    env.c.stop();
  });

  it("push-to-talk recordings still stop at the length cap", async () => {
    const env = setup({}, { deps: { maxUtteranceMs: 150 } });
    env.c.toggleMic();
    await until(() => env.mic.current?.state === "open", 1000, "mic open");
    for (let i = 0; i < 20 && env.stt.calls.length === 0; i++) (env.mic.current!.level(0.2), await sleep(20));
    await until(() => env.stt.calls.length === 1, 2000, "capped recording transcribed");
  });

  it("barge-in after a long reply is not cut by the length cap (it counts from where the user starts)", async () => {
    const env = setup({ echoCancellation: true, bargeIn: true }, { handsFree: true, deps: { maxUtteranceMs: 900 } });
    env.backend.deltas = ["Uzun bir hikâye anlatacağım şimdi. ", ...Array.from({ length: 30 }, (_, i) => `parça ${i}. `)];
    env.backend.deltaMs = 80;
    env.tts.chunkSeconds = 0.4;
    env.c.sendText("Hikâye anlat.");
    await until(() => env.c.getState().phase === "speaking", 3000, "speaking");
    await until(() => env.mic.sessions.length === 1 && env.mic.current?.state === "open", 1000, "monitor mic");
    const monitor = env.mic.current!;
    // the monitor has been recording for longer than the cap when the user starts to talk
    for (let i = 0; i < 100 && monitor.duration < 1.0; i++) (monitor.level(0.003), await sleep(20));
    expect(monitor.duration).toBeGreaterThan(0.95);
    for (let i = 0; i < 12 && env.c.getState().phase === "speaking"; i++) (monitor.level(0.3), await sleep(25));
    expect(env.c.getState().phase).toBe("listening");
    for (let i = 0; i < 6; i++) (monitor.level(0.3), await sleep(25));
    expect(env.c.getState().phase).toBe("listening"); // not sent off to the recogniser mid-sentence
    expect(env.stt.calls).toHaveLength(0);
    env.c.stop();
  });

  it("hands-free pauses after a permanent error (bad key) instead of re-opening the mic", async () => {
    const env = setup({}, { handsFree: true });
    env.backend.error = { afterDeltas: 0, error: new ChatError("invalid key", "invalid_key", 401) };
    env.c.sendText("Merhaba");
    await until(() => env.c.getState().notices.some((n) => n.code === "invalid_key"), 3000, "error toast");
    await sleep(80);
    expect(env.c.getState().phase).toBe("idle");
    expect(env.mic.opens).toHaveLength(0);
    expect(env.c.getState().handsFree).toBe(true); // still armed: the mic button resumes
  });

  it("turning hands-free off while it waits for speech closes the mic", async () => {
    const env = setup({}, { handsFree: true });
    env.c.setHandsFree(true);
    await until(() => env.mic.current?.state === "open", 1000, "mic open");
    const session = env.mic.current!;
    env.c.setHandsFree(false);
    expect(session.state).toBe("cancelled");
    expect(env.c.getState().phase).toBe("idle");
    expect(env.c.getState().handsFree).toBe(false);
  });

  it("without echo cancellation there is no voice barge-in (the assistant would hear itself)", async () => {
    const env = setup({ echoCancellation: false, bargeIn: true }, { handsFree: true });
    env.c.sendText("Merhaba");
    await until(() => env.c.getState().phase === "speaking", 3000, "speaking");
    expect(env.mic.opens).toHaveLength(0);
    await until(() => env.c.getState().phase === "listening", 3000, "listening after the reply");
    env.c.stop();
  });

  it("speak again replays a reply with its sentences", async () => {
    const env = setup();
    env.backend.deltas = ["Birinci cümle burada bitiyor. ", "İkinci cümle de burada bitiyor."];
    env.c.sendText("Merhaba");
    await until(() => env.c.getState().phase === "idle" && env.reply()?.status === "done", 3000, "done");
    env.tts.texts = [];
    env.c.speakAgain(env.reply()!.id);
    expect(env.c.getState().phase).toBe("speaking");
    await until(() => env.c.getState().phase === "idle", 3000, "replay done");
    expect(env.tts.texts).toEqual(["Birinci cümle burada bitiyor.", "İkinci cümle de burada bitiyor."]);
    expect(env.backend.calls).toHaveLength(1);
  });

  it("typed text while listening cancels the recording and runs the turn", async () => {
    const env = setup();
    env.c.toggleMic();
    await until(() => env.mic.current?.state === "open", 1000, "mic open");
    env.c.sendText("Yazarak soruyorum");
    expect(env.mic.current?.state).toBe("cancelled");
    await until(() => env.c.getState().phase === "idle" && env.reply()?.status === "done", 3000, "done");
    expect(env.c.getState().messages[0]).toMatchObject({ source: "text", text: "Yazarak soruyorum" });
    expect(env.stt.calls).toHaveLength(0);
  });

  it("keeps the conversation history across turns", async () => {
    const env = setup();
    env.backend.deltas = ["Birinci yanıt."];
    env.c.sendText("Birinci soru");
    await until(() => env.c.getState().phase === "idle" && env.reply()?.status === "done", 3000, "turn 1");
    env.backend.deltas = ["İkinci yanıt."];
    env.c.sendText("İkinci soru");
    await until(() => env.backend.calls.length === 2 && env.c.getState().phase === "idle", 3000, "turn 2");
    expect(env.backend.calls[1].messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "system:Türkçe yanıt ver.",
      "user:Birinci soru",
      "assistant:Birinci yanıt.",
      "user:İkinci soru",
    ]);
  });
});
