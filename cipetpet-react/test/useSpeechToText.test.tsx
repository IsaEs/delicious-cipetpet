import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpeechToText } from "../src/index.js";
import { abortable, deferred, fake, type FakeStt } from "./fake-core.js";

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error");
});
afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled();
});

async function readyHook(opts: Parameters<typeof useSpeechToText>[0] = { source: "/d.cpet" }) {
  const hook = renderHook((p: Parameters<typeof useSpeechToText>[0]) => useSpeechToText(p), { initialProps: opts });
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return hook;
}

const stt = () => fake.loads.find((l) => l.kind === "stt")!.model as FakeStt;

describe("useSpeechToText: transcribe", () => {
  it("transcribes a Float32Array at its sample rate (default 16000) with the hook defaults", async () => {
    const { result } = await readyHook({ source: "/d.cpet", lang: "tr", beam: 3 });
    const samples = new Float32Array(32000);
    let text = "";
    await act(async () => {
      text = (await result.current.transcribe(samples)).text;
    });
    expect(text).toBe("heard 32000@16000#1");
    expect(result.current.transcript).toBe(text);
    expect(stt().calls[0].audio).toBe(samples);
    expect(stt().calls[0].opts).toMatchObject({ lang: "tr", beam: 3, sampleRate: 16000 });
    expect(fake.decodeCalls).toHaveLength(0);

    await act(async () => {
      await result.current.transcribe(new Float32Array(44100), { sampleRate: 44100, lang: "en" });
    });
    expect(stt().calls[1].opts).toMatchObject({ lang: "en", beam: 3, sampleRate: 44100 });
    expect(result.current.result?.lang).toBe("en");
  });

  it("decodes a Blob / File / ArrayBuffer to 16 kHz first", async () => {
    const { result } = await readyHook();
    const file = new File([new Uint8Array(10)], "clip.wav", { type: "audio/wav" });
    await act(async () => {
      await result.current.transcribe(file);
      await result.current.transcribe(new ArrayBuffer(8));
    });
    expect(fake.decodeCalls.map((c) => c.targetRate)).toEqual([16000, 16000]);
    expect(fake.decodeCalls[0].input).toBe(file);
    expect(stt().calls[0].audio.length).toBe(8000);
    expect(stt().calls[0].opts.sampleRate).toBe(16000);
    expect(result.current.transcript).toBe("heard 8000@16000#2");
  });

  it("a stale (older) result does not overwrite a newer one; each promise gets its own", async () => {
    const { result } = await readyHook();
    const gates = [deferred(), deferred()];
    fake.sttGate = (i, signal) => abortable(gates[i], signal);
    let p1!: Promise<{ text: string }>;
    let p2!: Promise<{ text: string }>;
    act(() => {
      p1 = result.current.transcribe(new Float32Array(100));
      p2 = result.current.transcribe(new Float32Array(200));
    });
    await waitFor(() => expect(stt().calls).toHaveLength(2));
    expect(result.current.isTranscribing).toBe(true);
    await act(async () => {
      gates[1].resolve();
      await p2;
    });
    expect(result.current.transcript).toBe("heard 200@16000#2");
    await act(async () => {
      gates[0].resolve();
      await p1;
    });
    await expect(p1).resolves.toMatchObject({ text: "heard 100@16000#1" });
    expect(result.current.transcript).toBe("heard 200@16000#2");
    expect(result.current.isTranscribing).toBe(false);
  });

  it("aborts transcriptions on unmount", async () => {
    const { result, unmount } = await readyHook();
    const gate = deferred();
    fake.sttGate = (_i, signal) => abortable(gate, signal);
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.transcribe(new Float32Array(10)).catch((e: unknown) => e);
    });
    await waitFor(() => expect(stt().calls).toHaveLength(1));
    unmount();
    await expect(p).resolves.toMatchObject({ name: "AbortError" });
    expect(stt().calls[0].opts.signal?.aborted).toBe(true);
  });
});

describe("useSpeechToText: recording", () => {
  it("start -> level -> stop -> transcript", async () => {
    const { result } = await readyHook({ source: "/d.cpet", lang: "tr" });
    await act(async () => {
      await result.current.startRecording({ deviceId: "mic-2" });
    });
    expect(result.current.isRecording).toBe(true);
    const rec = fake.recorders[0];
    expect(rec.opts).toMatchObject({ sampleRate: 16000, deviceId: "mic-2" });

    act(() => {
      rec.level(0.2);
      rec.level(0.4); // same frame: only the latest is published
    });
    await waitFor(() => expect(result.current.level).toBeCloseTo(0.4));
    act(() => rec.level(3)); // clamped
    await waitFor(() => expect(result.current.level).toBe(1));

    let text = "";
    await act(async () => {
      text = (await result.current.stopRecording({ beam: 1 })).text;
    });
    expect(rec.stopped).toBe(1);
    expect(text).toBe("heard 16000@16000#1");
    expect(stt().calls[0].opts).toMatchObject({ lang: "tr", beam: 1, sampleRate: 16000 });
    expect(result.current.transcript).toBe(text);
    expect(result.current.isRecording).toBe(false);
    expect(result.current.level).toBe(0);
  });

  it("stop during the permission prompt waits for the start, then transcribes", async () => {
    const { result } = await readyHook();
    const permission = deferred();
    fake.micGate = () => permission.promise;
    let started!: Promise<void>;
    act(() => {
      started = result.current.startRecording();
    });
    expect(result.current.isRecording).toBe(true);
    let stopped!: Promise<{ text: string }>;
    act(() => {
      stopped = result.current.stopRecording();
    });
    await act(async () => {
      permission.resolve();
      await started;
      await stopped;
    });
    await expect(stopped).resolves.toMatchObject({ text: "heard 16000@16000#1" });
  });

  it("cancelRecording() drops the audio; a start that resolves after a cancel releases the mic", async () => {
    const { result } = await readyHook();
    await act(async () => {
      await result.current.startRecording();
    });
    act(() => result.current.cancelRecording());
    expect(fake.recorders[0].cancelled).toBe(1);
    expect(result.current.isRecording).toBe(false);
    await expect(result.current.stopRecording()).rejects.toThrow(/not recording/);

    const permission = deferred();
    fake.micGate = () => permission.promise;
    let started!: Promise<void>;
    act(() => {
      started = result.current.startRecording();
    });
    act(() => result.current.cancelRecording());
    await act(async () => {
      permission.resolve();
      await started;
    });
    expect(fake.recorders[1].cancelled).toBe(1);
    expect(result.current.isRecording).toBe(false);
    expect(stt().calls).toHaveLength(0);
  });

  it("start, cancel, start during the permission prompt: the second start is not dropped", async () => {
    const { result } = await readyHook();
    const first = deferred();
    const second = deferred();
    const gates = [first, second];
    fake.micGate = () => gates.shift()!.promise;
    let started1!: Promise<void>;
    let started2!: Promise<void>;
    act(() => {
      started1 = result.current.startRecording();
    });
    act(() => result.current.cancelRecording());
    act(() => {
      started2 = result.current.startRecording();
    });
    await act(async () => {
      first.resolve();
      second.resolve();
      await started1;
      await started2;
    });
    expect(fake.recorders).toHaveLength(2);
    expect(fake.recorders[0].cancelled).toBe(1); // the voided first start releases its mic
    expect(fake.recorders[1].cancelled).toBe(0);
    expect(result.current.isRecording).toBe(true);
    await act(async () => {
      await result.current.stopRecording();
    });
    expect(fake.recorders[1].stopped).toBe(1);
  });

  it("a denied microphone rejects and resets isRecording", async () => {
    const { result } = await readyHook();
    fake.micGate = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    let err: unknown;
    await act(async () => {
      err = await result.current.startRecording().catch((e: unknown) => e);
    });
    expect(err).toMatchObject({ name: "NotAllowedError" });
    expect(result.current.isRecording).toBe(false);
  });

  it("startRecording() starts loading a model that was not auto-loaded", async () => {
    const { result } = renderHook(() => useSpeechToText({ source: "/d.cpet", autoLoad: false }));
    await act(async () => {});
    expect(fake.loads).toHaveLength(0);
    await act(async () => {
      await result.current.startRecording();
    });
    expect(fake.loads).toHaveLength(1);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.cancelRecording());
  });

  it("unmount stops the microphone", async () => {
    const { result, unmount } = await readyHook();
    await act(async () => {
      await result.current.startRecording();
    });
    unmount();
    expect(fake.recorders[0].cancelled).toBe(1);
  });
});
