import { describe, expect, it, vi } from "vitest";
import { ModelRegistry, modelKey } from "../src/registry.js";
import { fake, type FakeTts } from "./fake-core.js";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("modelKey", () => {
  it("ignores functions, signal and key order; keys strings by value and bytes by identity", () => {
    const a = modelKey("tts", { source: "/a.cpet", backend: "wasm", threads: 2, onProgress: () => {} });
    const b = modelKey("tts", { threads: 2, backend: "wasm", source: "/a.cpet", fetch: globalThis.fetch });
    expect(a).toBe(b);
    expect(modelKey("stt", { source: "/a.cpet" })).not.toBe(modelKey("tts", { source: "/a.cpet" }));
    expect(modelKey("tts", { source: "/a.cpet", useWorker: true })).not.toBe(modelKey("tts", { source: "/a.cpet" }));
    expect(modelKey("tts", { source: new URL("https://x/a.cpet") })).toBe(modelKey("tts", { source: new URL("https://x/a.cpet") }));

    const bytes = new Uint8Array(4);
    expect(modelKey("tts", { source: bytes })).toBe(modelKey("tts", { source: bytes }));
    expect(modelKey("tts", { source: bytes })).not.toBe(modelKey("tts", { source: new Uint8Array(4) }));
    const blob = new Blob(["x"]);
    expect(modelKey("stt", { source: blob })).toBe(modelKey("stt", { source: blob }));
    expect(modelKey("stt", { source: blob })).not.toBe(modelKey("stt", { source: new Blob(["x"]) }));
  });
});

describe("ModelRegistry", () => {
  it("shares one instance per key and refcounts it", async () => {
    const reg = new ModelRegistry();
    const l1 = reg.acquire("tts", { source: "/a.cpet" });
    const l2 = reg.acquire("tts", { source: "/a.cpet", onProgress: () => {} });
    const [m1, m2] = await Promise.all([l1.load(), l2.load()]);
    expect(m1).toBe(m2);
    expect(fake.loads).toHaveLength(1);
    expect(reg.size).toBe(1);
    l1.release(0);
    expect(reg.size).toBe(1); // still held by l2
    l2.release(0);
    expect(reg.size).toBe(0);
    await flush();
    expect((m1 as unknown as FakeTts).disposed).toBe(1);
  });

  it("disposes after the grace period, and a re-acquire within it keeps the model", async () => {
    vi.useFakeTimers();
    const reg = new ModelRegistry();
    reg.defaultDisposeDelayMs = 1000;
    const l1 = reg.acquire("stt", { source: "/d.cpet" });
    const model = await l1.load();
    l1.release();
    vi.advanceTimersByTime(900);
    const l2 = reg.acquire("stt", { source: "/d.cpet" }); // a quick remount
    expect(await l2.load()).toBe(model);
    vi.advanceTimersByTime(5000);
    expect(reg.size).toBe(1);
    l2.release();
    vi.advanceTimersByTime(999);
    expect(reg.size).toBe(1);
    vi.advanceTimersByTime(1);
    expect(reg.size).toBe(0);
    expect((model as unknown as { disposed: number }).disposed).toBe(1);
    expect(fake.loads).toHaveLength(1);
  });

  it("does not cache errors: load() after a failure loads again", async () => {
    const reg = new ModelRegistry();
    fake.failNext = 1;
    const lease = reg.acquire("tts", { source: "/a.cpet" });
    await expect(lease.load()).rejects.toThrow("load failed");
    expect(lease.getSnapshot().status).toBe("error");
    expect(lease.getSnapshot().error?.message).toBe("load failed");
    const model = await lease.retry();
    expect(model).toBeTruthy();
    expect(lease.getSnapshot().status).toBe("ready");
    expect(lease.getSnapshot().error).toBeNull();
    expect(fake.loads).toHaveLength(2);
    lease.release(0);
  });

  it("aborts a load that is released before it finishes", async () => {
    fake.autoResolve = false;
    const reg = new ModelRegistry();
    const lease = reg.acquire("tts", { source: "/a.cpet" });
    const p = lease.load();
    expect(lease.getSnapshot().status).toBe("loading");
    lease.release(0);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.loads[0].opts.signal?.aborted).toBe(true);
    expect(reg.size).toBe(0);
  });

  it("disposes a model whose loader ignored the abort", async () => {
    fake.autoResolve = false;
    const reg = new ModelRegistry();
    const lease = reg.acquire("tts", { source: "/a.cpet" });
    const p = lease.load().catch((e: unknown) => e);
    const call = fake.loads[0];
    // simulate a loader that does not listen to the signal: resolve before the abort rejection lands
    call.resolve();
    lease.release(0);
    await p;
    await flush();
    expect(reg.size).toBe(0);
  });

  it("publishes progress and notifies subscribers", async () => {
    const reg = new ModelRegistry();
    const lease = reg.acquire("stt", { source: "/d.cpet" });
    const seen: string[] = [];
    const unsubscribe = reg.subscribe(lease.key, () => {
      const s = reg.getSnapshot(lease.key);
      seen.push(`${s.status}:${s.progress?.loaded ?? "-"}`);
    });
    const progress: number[] = [];
    const l2 = reg.acquire("stt", { source: "/d.cpet" }, { onProgress: (p) => progress.push(p.loaded) });
    await lease.load();
    expect(seen[0]).toBe("loading:-");
    expect(seen).toContain("loading:50");
    expect(seen.at(-1)).toBe("ready:100");
    expect(progress).toEqual([50, 100]);
    unsubscribe();
    lease.release(0);
    l2.release(0);
  });

  it("uses the worker factories with useWorker and passes the worker option", async () => {
    const reg = new ModelRegistry();
    const w = new URL("https://x/worker.js");
    const t = reg.acquire("tts", { source: "/a.cpet", useWorker: true, worker: w, threads: 2 });
    const s = reg.acquire("stt", { source: "/d.cpet", useWorker: true });
    await Promise.all([t.load(), s.load()]);
    expect(fake.loads.map((l) => `${l.kind}:${l.via}`)).toEqual(["tts:worker", "stt:worker"]);
    expect(fake.loads[0].opts.worker).toBe(w);
    expect(fake.loads[0].opts.threads).toBe(2);
    expect(fake.loads[0].opts.signal).toBeInstanceOf(AbortSignal);
    t.release(0);
    s.release(0);
  });

  it("rejects reusing a Worker instance after its model disposes it", async () => {
    const reg = new ModelRegistry();
    const worker = {
      terminated: false,
      postMessage() {},
      terminate() {
        this.terminated = true;
      },
    };
    const config = { source: "/a.cpet", useWorker: true, worker: worker as unknown as Worker };
    const first = reg.acquire("tts", config);

    const model = await first.load();
    first.release(0);
    await flush();
    expect(worker.terminated).toBe(true);
    expect((model as unknown as FakeTts).disposed).toBe(1);

    const second = reg.acquire("tts", config);
    await expect(second.load()).rejects.toThrow(
      "a Worker instance can only be used once; pass a worker URL/string instead",
    );
    expect(fake.loads).toHaveLength(1);
    second.release(0);
  });

  it("a retry after a failed load on a Worker instance still says what failed first", async () => {
    const reg = new ModelRegistry();
    const worker = {
      terminated: false,
      postMessage() {},
      terminate() {
        this.terminated = true;
      },
    };
    const config = { source: "/a.cpet", useWorker: true, worker: worker as unknown as Worker };
    fake.failNext = 1;
    const lease = reg.acquire("tts", config);
    await expect(lease.load()).rejects.toThrow("load failed");
    expect(worker.terminated).toBe(true);
    await expect(lease.load()).rejects.toThrow(/can only be used once.*the load before it failed: load failed/);
    expect(fake.loads).toHaveLength(1);
    lease.release(0);
  });

  it("clear() disposes everything and held leases reload on demand", async () => {
    const reg = new ModelRegistry();
    const lease = reg.acquire("tts", { source: "/a.cpet" });
    const m1 = await lease.load();
    reg.clear();
    expect(reg.size).toBe(0);
    expect(lease.getSnapshot().status).toBe("idle");
    const m2 = await lease.load();
    expect(m2).not.toBe(m1);
    expect(fake.loads).toHaveLength(2);
    lease.release(0);
  });
});
