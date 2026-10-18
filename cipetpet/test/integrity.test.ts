// PackLoadOptions.integrity: "sha256-<base64>" is handed to fetch and checked on the downloaded bytes here
// as well, so it also covers a custom fetch, the Cache API and packs given as bytes or a Blob.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { Pack, fetchBytes, openPack, verifyIntegrity } from "../src/pack/reader.js";
import { writePack } from "../src/pack/writer.js";
import type { PackInput } from "../src/pack/types.js";

const sri = (b: Uint8Array) => `sha256-${createHash("sha256").update(b).digest("base64")}`;
const URL1 = "https://models.example/antalia-mini-int8.cpet";

async function samplePack(seed = 1): Promise<Uint8Array> {
  const input: PackInput = {
    model: { id: "test-model", name: "Test", version: "0.0.1", task: "testing", variant: "v1" },
    entries: [{ name: "graphs/a.onnx", type: "onnx", data: new Uint8Array(randomBytes(2000)).fill(seed, 0, 16) }],
  };
  return writePack(input);
}

/** a fetch that serves `bytes` and records what it was asked */
function serving(bytes: Uint8Array, headers: Record<string, string> = { "content-length": String(bytes.length) }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(bytes.slice(), { status: 200, headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("integrity: a matching digest loads the pack and is passed to fetch", async () => {
  const file = await samplePack();
  const { fn, calls } = serving(file);
  const pack = await openPack(URL1, { fetch: fn, integrity: sri(file) });
  assert.equal(pack.byteLength, file.length);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.integrity, sri(file));
  // no integrity: the init has none
  const plain = serving(file);
  await openPack(URL1, { fetch: plain.fn });
  assert.equal(plain.calls[0].init?.integrity, undefined);
});

test("integrity: a mismatch fails with an error that names the URL, through a custom fetch", async () => {
  const file = await samplePack();
  const wrong = sri(new Uint8Array([1, 2, 3]));
  const { fn } = serving(file);
  await assert.rejects(
    openPack(URL1, { fetch: fn, integrity: wrong }),
    (e: Error) => {
      assert.match(e.message, /integrity check failed for https:\/\/models\.example\/antalia-mini-int8\.cpet/);
      assert.ok(e.message.includes(wrong), "names the expected digest");
      assert.ok(e.message.includes(sri(file)), "names the digest it got");
      return true;
    },
  );
  // one corrupted byte is enough
  const damaged = file.slice();
  damaged[damaged.length - 1] ^= 1;
  await assert.rejects(fetchBytes(URL1, { fetch: serving(damaged).fn, integrity: sri(file) }), /integrity check failed/);
});

test("integrity: several digests mean any of them; malformed values fail before any request", async () => {
  const file = await samplePack();
  const other = sri(new Uint8Array([9]));
  const { fn, calls } = serving(file);
  await fetchBytes(URL1, { fetch: fn, integrity: `${other} ${sri(file)}` });
  assert.equal(calls.length, 1);

  for (const bad of ["", "sha256-abc", "md5-xxxx", sri(file).replace("sha256-", "sha384-"), `${sri(file)} nonsense`, sri(file).slice(0, -1)]) {
    const spy = serving(file);
    await assert.rejects(fetchBytes(URL1, { fetch: spy.fn, integrity: bad }), TypeError, JSON.stringify(bad));
    assert.equal(spy.calls.length, 0);
  }
});

test("integrity: bytes and Blob sources are checked too", async () => {
  const file = await samplePack();
  const wrong = sri(new Uint8Array([7]));
  assert.ok((await Pack.fromBytes(file, { integrity: sri(file) })).byteLength > 0);
  await assert.rejects(Pack.fromBytes(file, { integrity: wrong }), /integrity check failed for the pack bytes/);
  assert.ok((await openPack(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer, { integrity: sri(file) })).byteLength > 0);

  const blob = new Blob([file as Uint8Array<ArrayBuffer>]);
  assert.ok((await openPack(blob, { integrity: sri(file) })).byteLength > 0);
  await assert.rejects(openPack(blob, { integrity: wrong }), /integrity check failed for the pack blob/);
  const named = new File([file as Uint8Array<ArrayBuffer>], "my.cpet");
  await assert.rejects(openPack(named, { integrity: wrong }), /integrity check failed for "my.cpet"/);

  await verifyIntegrity(file, sri(file), "x"); // resolves
  await assert.rejects(verifyIntegrity(file, wrong, "the thing"), /integrity check failed for the thing/);
});

test("integrity: works when the server compresses the response (digest is over the decoded body)", async () => {
  const file = await samplePack();
  const { fn } = serving(file, { "content-length": "123", "content-encoding": "gzip" });
  const progress: number[] = [];
  const got = await fetchBytes(URL1, { fetch: fn, integrity: sri(file), onProgress: (p) => progress.push(p.total) });
  assert.deepEqual(got, file);
  assert.equal(progress.at(-1), file.length);
});

test("integrity: a browser digest mismatch (fetch rejects with a TypeError) gets an explanatory error", async () => {
  const file = await samplePack();
  const rejecting = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  await assert.rejects(fetchBytes(URL1, { fetch: rejecting, integrity: sri(file) }), (e: Error) => {
    assert.match(e.message, /fetching https:\/\/models\.example\/antalia-mini-int8\.cpet failed: Failed to fetch .*SHA-256 mismatch/);
    assert.ok(e.cause instanceof TypeError);
    return true;
  });
  // without integrity the error is untouched
  await assert.rejects(fetchBytes(URL1, { fetch: rejecting }), (e: Error) => e instanceof TypeError && e.message === "Failed to fetch");
});

/** like a browser: a request that carries `integrity` rejects with a TypeError when the body does not match */
function browserLikeFetch(bytes: Uint8Array) {
  const calls: (string | undefined)[] = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    calls.push(init?.integrity);
    if (init?.integrity !== undefined && init.integrity !== sri(bytes)) throw new TypeError("Failed to fetch");
    return new Response(bytes.slice(), { status: 200, headers: { "content-length": String(bytes.length) } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("integrity: a browser digest mismatch is re-checked without the browser's check and reported precisely", async () => {
  const file = await samplePack();
  const wrong = sri(await samplePack(2));
  const { fn, calls } = browserLikeFetch(file);
  await assert.rejects(fetchBytes(URL1, { fetch: fn, integrity: wrong }), (e: Error) => {
    assert.match(e.message, /integrity check failed for https:\/\/models\.example\/antalia-mini-int8\.cpet/);
    assert.ok(e.message.includes(`expected ${wrong}`) && e.message.includes(`got ${sri(file)}`), e.message);
    return true;
  });
  assert.deepEqual(calls, [wrong, undefined]);
  // a matching digest never needs the second request
  const ok = browserLikeFetch(file);
  assert.deepEqual(await fetchBytes(URL1, { fetch: ok.fn, integrity: sri(file) }), file);
  assert.deepEqual(ok.calls, [sri(file)]);
  // nothing is cached for a mismatch
  const { api, log } = fakeCaches();
  (globalThis as { caches?: unknown }).caches = api;
  try {
    await assert.rejects(fetchBytes(URL1, { fetch: browserLikeFetch(file).fn, cache: true, integrity: wrong }), /integrity check failed/);
    assert.deepEqual(log, []);
  } finally {
    delete (globalThis as { caches?: unknown }).caches;
  }
});

/** a minimal Cache API: match / put / delete over a Map */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const log: string[] = [];
  const api = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const s = stores.get(name)!;
      return {
        async match(url: string) {
          return s.get(url)?.clone();
        },
        async put(url: string, res: Response) {
          log.push(`put ${url}`);
          s.set(url, res);
        },
        async delete(url: string) {
          log.push(`delete ${url}`);
          return s.delete(url);
        },
      };
    },
  };
  return { api, stores, log };
}

test("integrity: the Cache API path verifies what it caches and what it serves", async () => {
  const good = await samplePack(1);
  const other = await samplePack(2);
  const { api, stores, log } = fakeCaches();
  (globalThis as { caches?: unknown }).caches = api;
  try {
    // a download that fails the check is not cached
    await assert.rejects(fetchBytes(URL1, { fetch: serving(other).fn, cache: true, integrity: sri(good) }), /integrity check failed/);
    assert.equal(stores.get("cipetpet-packs")?.has(URL1), false);
    assert.deepEqual(log, []);

    // a verified one is
    const a = serving(good);
    assert.deepEqual(await fetchBytes(URL1, { fetch: a.fn, cache: true, integrity: sri(good) }), good);
    assert.equal(stores.get("cipetpet-packs")?.has(URL1), true);

    // served from the cache after verification: no request, one final progress report
    const b = serving(good);
    const progress: { loaded: number; total: number }[] = [];
    assert.deepEqual(await fetchBytes(URL1, { fetch: b.fn, cache: true, integrity: sri(good), onProgress: (p) => progress.push(p) }), good);
    assert.equal(b.calls.length, 0);
    assert.deepEqual(progress, [{ loaded: good.length, total: good.length }]);

    // the URL now serves another build (stale cache): the old copy is dropped and the new one downloaded
    log.length = 0;
    const c = serving(other);
    assert.deepEqual(await fetchBytes(URL1, { fetch: c.fn, cache: true, integrity: sri(other) }), other);
    assert.equal(c.calls.length, 1);
    assert.deepEqual(log, [`delete ${URL1}`, `put ${URL1}`]);
    // without an integrity option a cache hit is trusted as before
    const d = serving(good);
    assert.deepEqual(await fetchBytes(URL1, { fetch: d.fn, cache: true }), other);
    assert.equal(d.calls.length, 0);
  } finally {
    delete (globalThis as { caches?: unknown }).caches;
  }
});

test("cache: a response that is not a pack is not cached, and a cached copy that stopped parsing is dropped", async () => {
  const good = await samplePack(1);
  const html = new TextEncoder().encode("<!doctype html><title>SPA fallback</title>".repeat(20));
  const { api, stores, log } = fakeCaches();
  (globalThis as { caches?: unknown }).caches = api;
  try {
    // an HTML fallback with status 200 fails to parse and must not stay under the URL
    await assert.rejects(Pack.fromUrl(URL1, { fetch: serving(html).fn, cache: true }), /not a \.cpet pack/);
    assert.equal(stores.get("cipetpet-packs")?.has(URL1), false);
    assert.deepEqual(log, []);

    // a truncated body: same
    await assert.rejects(Pack.fromUrl(URL1, { fetch: serving(good.slice(0, 100)).fn, cache: true }), /pack/);
    assert.equal(stores.get("cipetpet-packs")?.has(URL1), false);

    // the fixed file loads afterwards (nothing poisoned the URL) and is cached
    const pack = await Pack.fromUrl(URL1, { fetch: serving(good).fn, cache: true });
    assert.equal(pack.byteLength, good.length);
    assert.equal(stores.get("cipetpet-packs")?.has(URL1), true);

    // a cache entry written earlier by a buggy version (or damaged) is deleted when it does not parse, so the retry downloads
    stores.get("cipetpet-packs")!.set(URL1, new Response(html.slice()));
    log.length = 0;
    await assert.rejects(Pack.fromUrl(URL1, { fetch: serving(good).fn, cache: true }), /not a \.cpet pack/);
    assert.deepEqual(log, [`delete ${URL1}`]);
    const again = serving(good);
    assert.equal((await Pack.fromUrl(URL1, { fetch: again.fn, cache: true })).byteLength, good.length);
    assert.equal(again.calls.length, 1);
  } finally {
    delete (globalThis as { caches?: unknown }).caches;
  }
});
