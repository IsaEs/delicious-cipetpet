import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTextToSpeech } from "../src/index.js";
import { abortable, deferred, fake, type FakeContext, type FakeTts } from "./fake-core.js";

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error");
});
afterEach(() => {
  // no act() warnings, no "update on an unmounted component", no uncaught errors in effects
  expect(consoleError).not.toHaveBeenCalled();
});

async function readyHook(opts: Parameters<typeof useTextToSpeech>[0] = { source: "/a.cpet" }) {
  const hook = renderHook((p: Parameters<typeof useTextToSpeech>[0]) => useTextToSpeech(p), { initialProps: opts });
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return hook;
}

describe("useTextToSpeech", () => {
  it("speak() streams chunks into the player and resolves when playback ends", async () => {
    const { result } = await readyHook({ source: "/a.cpet", seed: 7, speed: 1.1 });
    let done = false;
    let p!: Promise<void>;
    act(() => {
      p = result.current.speak("Bir. Iki. Uc.", { speed: 0.9 }).then(() => {
        done = true;
      });
      // the player (and its AudioContext) exist synchronously, inside the "gesture"
      expect(fake.players).toHaveLength(1);
      expect((fake.players[0].context as unknown as FakeContext).resumed).toBe(1);
    });
    const player = fake.players[0];
    await waitFor(() => expect(player.chunks).toHaveLength(3));
    expect(player.chunks.map((c) => c.length)).toEqual([100, 200, 300]);
    expect(player.sampleRate).toBe(48000);
    await waitFor(() => expect(result.current.isSynthesizing).toBe(false));
    expect(result.current.isSpeaking).toBe(true);
    expect(done).toBe(false);

    const model = fake.loads[0].model as FakeTts;
    expect(model.streamCalls[0].opts).toMatchObject({ seed: 7, speed: 0.9 });
    expect(model.streamCalls[0].opts.signal).toBeInstanceOf(AbortSignal);

    await act(async () => {
      player.endPlayback();
      await p;
    });
    expect(done).toBe(true);
    expect(result.current.isSpeaking).toBe(false);
    expect(result.current.result?.audio.length).toBe(600);
    expect(result.current.result?.stats.chunks).toBe(3);
    expect(result.current.modelText).toBe("bir iki uc");
  });

  it("speak() before the model is ready creates the player first, then waits for the load", async () => {
    fake.autoResolve = false;
    const { result } = renderHook(() => useTextToSpeech({ source: "/a.cpet" }));
    await waitFor(() => expect(fake.loads).toHaveLength(1));
    let p!: Promise<void>;
    act(() => {
      p = result.current.speak("Merhaba.");
    });
    expect(fake.players).toHaveLength(1);
    expect(result.current.isSynthesizing).toBe(true);
    await act(async () => fake.loads[0].resolve());
    await waitFor(() => expect(fake.players[0].chunks).toHaveLength(1));
    await act(async () => {
      fake.players[0].endPlayback();
      await p;
    });
  });

  it("stop() aborts synthesis and stops playback; speak resolves quietly", async () => {
    const { result } = await readyHook();
    const gate = deferred();
    fake.ttsGate = (signal) => abortable(gate, signal);
    let p!: Promise<void>;
    act(() => {
      p = result.current.speak("Bir. Iki.");
    });
    await waitFor(() => expect(result.current.isSynthesizing).toBe(true));
    const model = fake.loads[0].model as FakeTts;
    await waitFor(() => expect(model.streamCalls).toHaveLength(1));
    act(() => result.current.stop());
    await act(async () => {
      await expect(p).resolves.toBeUndefined();
    });
    expect(model.streamCalls[0].opts.signal?.aborted).toBe(true);
    expect(fake.players[0].stopped).toBeGreaterThan(0);
    expect(result.current.isSynthesizing).toBe(false);
    expect(result.current.isSpeaking).toBe(false);
    expect(result.current.result).toBeNull();
  });

  it("a second speak() cancels the first and reuses the AudioContext", async () => {
    const { result } = await readyHook();
    const gate = deferred();
    fake.ttsGate = (signal) => abortable(gate, signal);
    let first!: Promise<void>;
    act(() => {
      first = result.current.speak("Birinci.");
    });
    const model = fake.loads[0].model as FakeTts;
    await waitFor(() => expect(model.streamCalls).toHaveLength(1));

    fake.ttsGate = () => Promise.resolve();
    let second!: Promise<void>;
    act(() => {
      second = result.current.speak("Ikinci.");
    });
    await act(async () => {
      await expect(first).resolves.toBeUndefined();
    });
    expect(model.streamCalls[0].opts.signal?.aborted).toBe(true);
    expect(fake.players[0].stopped).toBeGreaterThan(0);
    expect(fake.players[1].context).toBe(fake.players[0].context);
    await waitFor(() => expect(fake.players[1].chunks).toHaveLength(1));
    await waitFor(() => expect(result.current.isSpeaking).toBe(true));
    await act(async () => {
      fake.players[1].endPlayback();
      await second;
    });
    expect(result.current.modelText).toBe("ikinci");
    expect(result.current.isSpeaking).toBe(false);
  });

  it("unmount aborts everything in flight, closes its AudioContext and sets no state", async () => {
    const { result, unmount } = await readyHook();
    const gate = deferred();
    fake.ttsGate = (signal) => abortable(gate, signal);
    let speakP!: Promise<void>;
    let synthP!: Promise<unknown>;
    act(() => {
      speakP = result.current.speak("Bir.");
      synthP = result.current.synthesize("Iki.").catch((e: unknown) => e);
    });
    const model = fake.loads[0].model as FakeTts;
    await waitFor(() => expect(model.streamCalls).toHaveLength(1));
    await waitFor(() => expect(model.synthCalls).toHaveLength(1));
    unmount();
    await expect(speakP).resolves.toBeUndefined();
    await expect(synthP).resolves.toMatchObject({ name: "AbortError" });
    expect(model.streamCalls[0].opts.signal?.aborted).toBe(true);
    expect(model.synthCalls[0].opts.signal?.aborted).toBe(true);
    expect((fake.players[0].context as unknown as FakeContext).closed).toBe(1);
  });

  it("synthesize() returns the audio, applies defaults, and getWavBlob() encodes it", async () => {
    const { result } = await readyHook({ source: "/a.cpet", seed: 3, steps: 4 });
    let r: Awaited<ReturnType<typeof result.current.synthesize>> | undefined;
    await act(async () => {
      r = await result.current.synthesize("Merhaba", { steps: 6 });
    });
    const model = fake.loads[0].model as FakeTts;
    expect(model.synthCalls[0].opts).toMatchObject({ seed: 3, steps: 6 });
    expect(result.current.result).toBe(r);
    expect(result.current.modelText).toBe("merhaba");
    const blob = result.current.getWavBlob();
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(4);
    expect(fake.wavCalls[0]).toMatchObject({ sampleRate: 48000 });
    expect(fake.players).toHaveLength(0); // synthesize does not play
  });

  it("getWavBlob() throws before anything was synthesised; callbacks are stable", async () => {
    const { result, rerender } = await readyHook();
    const first = result.current;
    expect(() => first.getWavBlob()).toThrow(/nothing synthesised/);
    rerender({ source: "/a.cpet", speed: 1.2 });
    for (const k of ["speak", "synthesize", "stop", "normalize", "getWavBlob", "load", "retry"] as const) {
      expect(result.current[k]).toBe(first[k]);
    }
    expect(fake.loads).toHaveLength(1);
  });

  it("a speak() whose signal aborts resolves without playing the rest", async () => {
    const { result } = await readyHook();
    const gate = deferred();
    fake.ttsGate = (signal) => abortable(gate, signal);
    const ac = new AbortController();
    let p!: Promise<void>;
    act(() => {
      p = result.current.speak("Bir. Iki.", { signal: ac.signal });
    });
    const model = fake.loads[0].model as FakeTts;
    await waitFor(() => expect(model.streamCalls).toHaveLength(1));
    await act(async () => {
      ac.abort();
      await p;
    });
    expect(fake.players[0].chunks).toHaveLength(0);
    expect(result.current.isSynthesizing).toBe(false);
  });

  it("speak() rejects when the model fails to load", async () => {
    fake.failNext = 1;
    const { result } = renderHook(() => useTextToSpeech({ source: "/a.cpet" }));
    await waitFor(() => expect(result.current.status).toBe("error"));
    fake.failNext = 1;
    let err: unknown;
    await act(async () => {
      err = await result.current.speak("Bir.").catch((e: unknown) => e);
    });
    expect(err).toMatchObject({ message: "load failed" });
    expect(result.current.isSynthesizing).toBe(false);
  });
});
