import { StrictMode, useState } from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CipetpetProvider, useAntalia, useDuyu, useSpeechToText, useTextToSpeech } from "../src/index.js";
import { modelRegistry } from "../src/registry.js";
import { fake } from "./fake-core.js";

function Status({ id, source }: { id: string; source?: string }) {
  const tts = useAntalia(source ? { source } : undefined);
  return (
    <span data-testid={id}>
      {tts.status}
      {tts.progress ? ` ${tts.progress.loaded}/${tts.progress.total}` : ""}
    </span>
  );
}

describe("useAntalia / useDuyu", () => {
  it("shares one model between components and loads once under StrictMode", async () => {
    render(
      <StrictMode>
        <Status id="a" source="/a.cpet" />
        <Status id="b" source="/a.cpet" />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("ready 100/100"));
    expect(screen.getByTestId("b").textContent).toBe("ready 100/100");
    expect(fake.loads).toHaveLength(1);
    expect(modelRegistry.size).toBe(1);
  });

  it("keeps the model across a quick remount and disposes it after the grace period", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    function Toggle() {
      const [on, setOn] = useState(true);
      return (
        <>
          <button onClick={() => setOn((v) => !v)}>toggle</button>
          {on && <Status id="s" source="/a.cpet" />}
        </>
      );
    }
    render(<Toggle />);
    await waitFor(() => expect(screen.getByTestId("s").textContent).toContain("ready"));
    const model = fake.loads[0].model;
    act(() => screen.getByText("toggle").click()); // unmount
    act(() => vi.advanceTimersByTime(500));
    act(() => screen.getByText("toggle").click()); // remount within the grace period
    expect(screen.getByTestId("s").textContent).toContain("ready");
    expect(fake.loads).toHaveLength(1);
    act(() => screen.getByText("toggle").click()); // unmount for good
    act(() => vi.advanceTimersByTime(1000));
    expect(modelRegistry.size).toBe(0);
    expect(model.disposed).toBe(1);
  });

  it("reports progress, then errors, and retry() reloads", async () => {
    fake.autoResolve = false;
    const { result } = renderHook(() => useDuyu({ source: "/d.cpet" }));
    await waitFor(() => expect(result.current.status).toBe("loading"));
    act(() => fake.loads[0].opts.onProgress?.({ loaded: 10, total: 100 }));
    expect(result.current.progress).toEqual({ loaded: 10, total: 100 });
    await act(async () => fake.loads[0].reject(new Error("network down")));
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe("network down");

    let reloaded: Promise<unknown>;
    act(() => {
      reloaded = result.current.retry();
    });
    expect(result.current.status).toBe("loading");
    expect(fake.loads).toHaveLength(2);
    await act(async () => {
      fake.loads[1].resolve();
      await reloaded;
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.model).toBe(fake.loads[1].model);
    expect(result.current.error).toBeNull();
  });

  it("autoLoad: false waits for load(); callbacks are stable", async () => {
    const { result, rerender } = renderHook(() => useAntalia({ source: "/a.cpet", autoLoad: false }));
    const { load, retry } = result.current;
    await act(async () => {});
    expect(result.current.status).toBe("idle");
    expect(fake.loads).toHaveLength(0);
    await act(async () => {
      await result.current.load();
    });
    expect(result.current.status).toBe("ready");
    rerender();
    expect(result.current.load).toBe(load);
    expect(result.current.retry).toBe(retry);
  });

  it("does not reload when inline options change identity", async () => {
    const { result, rerender } = renderHook(({ threads }) => useAntalia({ source: "/a.cpet", threads, onProgress: () => {} }), {
      initialProps: { threads: 1 },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ threads: 1 });
    rerender({ threads: 1 });
    expect(fake.loads).toHaveLength(1);
    rerender({ threads: 2 }); // a different instance
    await waitFor(() => expect(fake.loads).toHaveLength(2));
  });

  it("without a source stays idle and load() rejects with a clear message", async () => {
    const { result } = renderHook(() => useAntalia());
    expect(result.current.status).toBe("idle");
    await expect(result.current.load()).rejects.toThrow(/no tts model source/);
  });

  it("uses the worker factories with useWorker", async () => {
    const { result } = renderHook(() => ({
      tts: useTextToSpeech({ source: "/a.cpet", useWorker: true }),
      stt: useSpeechToText({ source: "/d.cpet", useWorker: true }),
    }));
    await waitFor(() => expect(result.current.tts.status).toBe("ready"));
    await waitFor(() => expect(result.current.stt.status).toBe("ready"));
    expect(fake.loads.map((l) => `${l.kind}:${l.via}`).sort()).toEqual(["stt:worker", "tts:worker"]);
    // AntaliaWorker.normalize is async; the hook's normalize() handles both
    await expect(result.current.tts.normalize("MERHABA")).resolves.toBe("merhaba");
  });
});

describe("CipetpetProvider", () => {
  it("gives hooks their source and options; hook options win", async () => {
    const { result } = renderHook(() => ({ a: useAntalia(), d: useDuyu({ threads: 3 }) }), {
      wrapper: ({ children }) => (
        <CipetpetProvider tts={{ source: "/p/a.cpet" }} stt={{ source: "/p/d.cpet", threads: 1, backend: "wasm" }}>
          {children}
        </CipetpetProvider>
      ),
    });
    await waitFor(() => expect(result.current.a.status).toBe("ready"));
    await waitFor(() => expect(result.current.d.status).toBe("ready"));
    const stt = fake.loads.find((l) => l.kind === "stt")!;
    expect(stt.source).toBe("/p/d.cpet");
    expect(stt.opts.threads).toBe(3);
    expect(stt.opts.backend).toBe("wasm");
  });

  it("preload starts loading on mount without any hook", async () => {
    render(
      <CipetpetProvider tts={{ source: "/p/a.cpet" }} stt={{ source: "/p/d.cpet" }} preload={["stt"]}>
        <p>app</p>
      </CipetpetProvider>,
    );
    await waitFor(() => expect(fake.loads).toHaveLength(1));
    expect(fake.loads[0].kind).toBe("stt");
  });

  it("a preloaded model is shared with the hooks", async () => {
    const { result } = renderHook(() => useDuyu(), {
      wrapper: ({ children }) => (
        <CipetpetProvider stt={{ source: "/p/d.cpet" }} preload>
          {children}
        </CipetpetProvider>
      ),
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fake.loads).toHaveLength(1);
  });
});
