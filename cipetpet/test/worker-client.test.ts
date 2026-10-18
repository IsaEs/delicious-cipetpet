// makeWorker / the worker clients: a cross-origin worker script goes through a Blob URL shim, everything
// else keeps the plain `new Worker(url, { type: "module" })`. Worker, location and URL.createObjectURL are
// faked, since Node has none of the browser's worker machinery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAntaliaWorker, createDuyuWorker, makeWorker } from "../src/worker/client.js";
import type { WorkerRequest } from "../src/worker/protocol.js";

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

class FakeWorker extends EventTarget {
  static created: FakeWorker[] = [];
  static failToConstruct = false;
  static loadError: string | undefined;
  terminated = false;
  posted: WorkerRequest[] = [];
  constructor(readonly source: unknown, readonly options: unknown) {
    super();
    if (FakeWorker.failToConstruct) throw new DOMException("blocked", "SecurityError");
    FakeWorker.created.push(this);
  }
  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
    queueMicrotask(() => {
      if (message.type === "load") {
        if (FakeWorker.loadError) {
          this.dispatchEvent(new MessageEvent("message", { data: { type: "error", id: message.id, name: "Error", message: FakeWorker.loadError } }));
        } else {
          const info = { id: "duyu-small", sampleRate: 16000 };
          this.dispatchEvent(new MessageEvent("message", { data: { type: "loaded", id: message.id, info, defaults: { steps: 8, cfg: 2, speed: 1, temperature: 0.6 } } }));
        }
      } else if (message.type === "dispose") {
        this.dispatchEvent(new MessageEvent("message", { data: { type: "result", id: message.id } }));
      }
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

interface Env {
  blobs: Map<string, Blob>;
  revoked: string[];
  restore(): void;
}

/** installs the fakes; `origin` undefined = no `location` at all */
function install(origin: string | undefined): Env {
  const saved = { Worker: g.Worker, location: g.location, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  let n = 0;
  FakeWorker.created = [];
  FakeWorker.failToConstruct = false;
  FakeWorker.loadError = undefined;
  g.Worker = FakeWorker;
  if (origin) g.location = { origin, href: origin === "null" ? "about:srcdoc" : `${origin}/app/index.html` };
  else delete g.location;
  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:${origin ?? "null"}/fake-${++n}`;
    blobs.set(url, blob);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => void revoked.push(url)) as typeof URL.revokeObjectURL;
  return {
    blobs,
    revoked,
    restore() {
      g.Worker = saved.Worker;
      if (saved.location === undefined) delete g.location;
      else g.location = saved.location;
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    },
  };
}

const CDN = "https://cdn.jsdelivr.net/npm/cipetpet@0.1.0/dist/browser/worker.js";

test("makeWorker: a cross-origin URL starts through a Blob module that imports it, and the Blob URL is revoked on release", async () => {
  const env = install("https://app.example");
  try {
    const h = makeWorker(CDN);
    assert.equal(FakeWorker.created.length, 1);
    const w = FakeWorker.created[0];
    assert.equal(h.worker as unknown, w);
    assert.match(String(w.source), /^blob:/);
    assert.deepEqual(w.options, { type: "module" });
    assert.equal(h.shimmedFor, CDN);

    const blob = env.blobs.get(String(w.source))!;
    assert.equal(blob.type, "text/javascript");
    assert.equal(await blob.text(), `import ${JSON.stringify(CDN)};\n`);
    assert.deepEqual(env.revoked, [], "kept alive while the worker runs");
    h.release();
    assert.deepEqual(env.revoked, [String(w.source)]);

    // a URL object works the same
    const h2 = makeWorker(new URL(CDN));
    assert.equal(await env.blobs.get(String(FakeWorker.created[1].source))!.text(), `import ${JSON.stringify(CDN)};\n`);
    h2.release();

    // a relative URL on another origin cannot happen; a protocol-relative one can
    const h3 = makeWorker("//cdn.example/w.js");
    assert.equal(await env.blobs.get(String(FakeWorker.created[2].source))!.text(), `import ${JSON.stringify("https://cdn.example/w.js")};\n`);
    h3.release();
  } finally {
    env.restore();
  }
});

test("makeWorker: same-origin URLs, blob/data URLs and Worker objects are left alone", () => {
  const env = install("https://app.example");
  try {
    for (const src of ["https://app.example/static/worker.js", "/static/worker.js", "worker.js", new URL("https://app.example/w.js"), "blob:https://app.example/abc", "data:text/javascript,1"]) {
      const h = makeWorker(src);
      assert.equal(FakeWorker.created.at(-1)!.source, src, String(src));
      assert.deepEqual(FakeWorker.created.at(-1)!.options, { type: "module" });
      assert.equal(h.shimmedFor, undefined);
      h.release();
    }
    assert.equal(env.blobs.size, 0, "no Blob was made");
    assert.deepEqual(env.revoked, []);

    const mine = new FakeWorker("mine", {}) as unknown as Worker;
    const h = makeWorker(mine);
    assert.equal(h.worker, mine);
    assert.equal(env.blobs.size, 0);
  } finally {
    env.restore();
  }
});

test("makeWorker: the default URL (a file: URL in these tests) and a page without location keep the old behaviour", () => {
  const env = install("https://app.example");
  try {
    makeWorker();
    const src = FakeWorker.created.at(-1)!.source as URL;
    assert.ok(src instanceof URL && src.pathname.endsWith("/worker.js") && src.protocol === "file:");
    assert.equal(env.blobs.size, 0);
  } finally {
    env.restore();
  }
  const bare = install(undefined);
  try {
    makeWorker(CDN);
    assert.equal(FakeWorker.created.at(-1)!.source, CDN, "no page origin to compare with: used as given");
    assert.equal(bare.blobs.size, 0);
  } finally {
    bare.restore();
  }
});

test("makeWorker: an opaque page origin ('null') treats http(s) scripts as cross-origin", async () => {
  const env = install("null");
  try {
    const h = makeWorker("https://app.example/worker.js");
    assert.match(String(FakeWorker.created[0].source), /^blob:/);
    h.release();
  } finally {
    env.restore();
  }
});

test("makeWorker: a Worker constructor that throws revokes the Blob URL at once", () => {
  const env = install("https://app.example");
  try {
    FakeWorker.failToConstruct = true;
    assert.throws(() => makeWorker(CDN), { name: "SecurityError" });
    assert.equal(env.revoked.length, 1);
    assert.equal(env.blobs.size, 1);
    assert.equal(env.revoked[0], [...env.blobs.keys()][0]);
  } finally {
    env.restore();
  }
});

test("createDuyuWorker / createAntaliaWorker: the Blob URL lives until dispose, and a failed load revokes it", async () => {
  const env = install("https://app.example");
  try {
    const duyu = await createDuyuWorker("https://models.example/duyu.cpet", { worker: CDN });
    const w = FakeWorker.created[0];
    assert.match(String(w.source), /^blob:/);
    const load = w.posted[0] as Extract<WorkerRequest, { type: "load" }>;
    assert.equal(load.type, "load");
    assert.equal(load.source, "https://models.example/duyu.cpet");
    assert.deepEqual(env.revoked, []);
    await duyu.dispose();
    assert.ok(w.terminated);
    assert.deepEqual(env.revoked, [String(w.source)]);

    const tts = await createAntaliaWorker("https://models.example/antalia.cpet", { worker: new URL(CDN) });
    const w2 = FakeWorker.created[1];
    assert.deepEqual(env.revoked, [String(w.source)]);
    await tts.dispose();
    await tts.dispose(); // idempotent: revoked once
    assert.deepEqual(env.revoked, [String(w.source), String(w2.source)]);

    // load fails inside the worker: the client closes and the Blob URL goes
    FakeWorker.loadError = "boom";
    await assert.rejects(createDuyuWorker("https://models.example/x.cpet", { worker: CDN }), /boom/);
    const w3 = FakeWorker.created[2];
    assert.ok(w3.terminated);
    assert.equal(env.revoked.at(-1), String(w3.source));
    assert.equal(env.revoked.length, 3);

    // same-origin: nothing to revoke
    FakeWorker.loadError = undefined;
    const same = await createDuyuWorker("https://models.example/x.cpet", { worker: "https://app.example/worker.js" });
    await same.dispose();
    assert.equal(env.revoked.length, 3);
  } finally {
    env.restore();
  }
});

test("worker client: an error event of a shimmed worker mentions the cross-origin script", async () => {
  const env = install("https://app.example");
  try {
    const pending = createDuyuWorker("https://models.example/x.cpet", { worker: CDN });
    const w = FakeWorker.created[0];
    // the worker never answers: its script failed to load
    w.postMessage = () => {};
    w.dispatchEvent(Object.assign(new Event("error"), { message: "" }));
    await assert.rejects(pending, (e: Error) => /worker failed/.test(e.message) && e.message.includes(CDN) && /CORS/.test(e.message));
  } finally {
    env.restore();
  }
});

test("worker client: the load message is cloneable and its URLs are absolute against the page", async () => {
  const env = install("https://app.example");
  try {
    // a URL object, a relative string and a relative wasmPaths all become absolute page URLs
    const a = await createDuyuWorker(new URL("https://models.example/duyu.cpet"), { worker: "https://app.example/w.js", wasmPaths: "ort/", requestInit: { headers: { a: "b" }, signal: new AbortController().signal } });
    const loadA = FakeWorker.created[0].posted[0] as Extract<WorkerRequest, { type: "load" }>;
    assert.equal(loadA.source, "https://models.example/duyu.cpet");
    assert.doesNotThrow(() => structuredClone(loadA), "what is posted must be structured-cloneable");
    assert.equal(loadA.options.wasmPaths, "https://app.example/app/ort/");
    assert.deepEqual(loadA.options.requestInit, { headers: { a: "b" } });
    await a.dispose();

    const b = await createAntaliaWorker("packs/antalia.cpet", { worker: "https://app.example/w.js" });
    const loadB = FakeWorker.created[1].posted[0] as Extract<WorkerRequest, { type: "load" }>;
    assert.equal(loadB.source, "https://app.example/app/packs/antalia.cpet", "resolved against the page, not the worker script");
    await b.dispose();

    // bytes and Blobs are passed as they are
    const bytes = new Uint8Array([1, 2, 3]);
    const c = await createDuyuWorker(bytes, { worker: "https://app.example/w.js" });
    assert.equal((FakeWorker.created[2].posted[0] as Extract<WorkerRequest, { type: "load" }>).source, bytes);
    await c.dispose();

    // options that cannot be posted fail with a clear error, before any worker exists
    const before = FakeWorker.created.length;
    await assert.rejects(createDuyuWorker("https://m.example/x.cpet", { fetch: (() => {}) as never }), /"fetch" option cannot be used with a worker/);
    await assert.rejects(createAntaliaWorker("https://m.example/x.cpet", { ort: {} }), /"ort" option cannot be used with a worker/);
    assert.equal(FakeWorker.created.length, before);
  } finally {
    env.restore();
  }
});

test("DuyuWorker.transcribe: a view on a larger buffer is copied, an array spanning its buffer is transferred", async () => {
  const env = install("https://app.example");
  try {
    const stt = await createDuyuWorker("https://models.example/x.cpet", { worker: "https://app.example/w.js" });
    const w = FakeWorker.created[0];
    const sent: { message: WorkerRequest; transfer: Transferable[] | undefined }[] = [];
    (w as unknown as { postMessage: unknown }).postMessage = (message: WorkerRequest, transfer?: Transferable[]) => void sent.push({ message, transfer });

    const ring = new Float32Array(1000).fill(0.5);
    const view = ring.subarray(100, 200);
    void stt.transcribe(view).catch(() => {});
    assert.equal(ring.buffer.byteLength, 4000, "the caller's buffer is not detached");
    assert.equal(view.length, 100);
    const posted = (sent[0].message as Extract<WorkerRequest, { type: "call" }>).args[0] as Float32Array;
    assert.notEqual(posted.buffer, ring.buffer);
    assert.equal(posted.length, 100);
    assert.deepEqual(sent[0].transfer, [posted.buffer]);

    const whole = new Float32Array(50);
    void stt.transcribe(whole).catch(() => {});
    assert.equal((sent[1].message as Extract<WorkerRequest, { type: "call" }>).args[0], whole);
    assert.deepEqual(sent[1].transfer, [whole.buffer]);
  } finally {
    env.restore();
  }
});
