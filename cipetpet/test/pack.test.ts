import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { crc32 } from "../src/pack/crc32.js";
import { gunzip, gzip, sha256, sha256Hex } from "../src/pack/codec.js";
import { Pack, fetchBytes, openPack } from "../src/pack/reader.js";
import { writePack } from "../src/pack/writer.js";
import { PACK_MAGIC, PACK_PREAMBLE } from "../src/pack/types.js";
import type { PackHeader, PackInput, PackProgress } from "../src/pack/types.js";

const enc = new TextEncoder();
const u8 = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const align64 = (n: number) => Math.ceil(n / 64) * 64;

const model = { id: "test-model", name: "Test", version: "0.0.1", task: "testing", variant: "v1" };

/** a payload that compresses well */
const jsonBytes = enc.encode(JSON.stringify({ words: Array.from({ length: 500 }, (_, i) => `word${i % 20}`) }));
const random = (n: number) => new Uint8Array(randomBytes(n));

const tensors = {
  f32: new Float32Array([1.5, -2.25, 3.125, Math.PI, 0, -0, 1e-30, 6]),
  f64: new Float64Array([Math.E, -1e300, 0.1]),
  i32: new Int32Array([1, -2, 2147483647, -2147483648, 7, 9]),
  i64: new BigInt64Array([1n, -1n, 9007199254740993n, -(2n ** 63n)]),
  u8: new Uint8Array([0, 1, 254, 255, 7]),
};

function sampleInput(): PackInput {
  return {
    model,
    runtime: { onnxruntime: "1.30.0" },
    meta: { sampleRate: 16000, nested: { a: [1, 2] } },
    entries: [
      { name: "graphs/a.onnx", type: "onnx", data: random(1000) },
      { name: "data/doc.json", type: "json", data: jsonBytes },
      { name: "data/note.txt", type: "text", data: enc.encode("merhaba dünya ğüşiöç"), encoding: "raw" },
      { name: "data/blob.bin", type: "bytes", data: random(333) },
      { name: "data/forced.bin", type: "bytes", data: random(100), encoding: "gzip" },
      { name: "data/empty", type: "bytes", data: new Uint8Array(0) },
      { name: "runtime/x.wasm", type: "wasm", data: random(77) },
      { name: "t/f32", type: "tensor", dtype: "float32", shape: [2, 4], data: u8(tensors.f32) },
      { name: "t/f64", type: "tensor", dtype: "float64", shape: [3], data: u8(tensors.f64) },
      { name: "t/i32", type: "tensor", dtype: "int32", shape: [3, 2], data: u8(tensors.i32) },
      { name: "t/i64", type: "tensor", dtype: "int64", shape: [4], data: u8(tensors.i64) },
      { name: "t/u8", type: "tensor", dtype: "uint8", shape: [5], data: u8(tensors.u8) },
      { name: "t/zeros", type: "tensor", dtype: "float32", shape: [256], data: new Uint8Array(1024), encoding: "gzip" },
      { name: "t/scalar0", type: "tensor", dtype: "int32", shape: [0, 3], data: new Uint8Array(0) },
    ],
  };
}

/** A pack file from a hand-made header (valid preamble and CRC), for reader validation tests. */
function craft(header: unknown, payload = new Uint8Array(0)): Uint8Array {
  const h = enc.encode(JSON.stringify(header));
  const d = align64(PACK_PREAMBLE + h.length);
  const out = new Uint8Array(d + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, PACK_MAGIC, true);
  dv.setUint16(4, 1, true);
  dv.setUint32(8, h.length, true);
  dv.setUint32(12, crc32(h), true);
  out.set(h, PACK_PREAMBLE);
  out.set(payload, d);
  return out;
}

function headerOf(file: Uint8Array): { header: PackHeader; data: number } {
  const dv = new DataView(file.buffer, file.byteOffset);
  const len = dv.getUint32(8, true);
  return { header: JSON.parse(new TextDecoder().decode(file.subarray(16, 16 + len))), data: align64(16 + len) };
}

test("crc32 and sha256 match the reference values", async () => {
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4097]) {
    const b = random(n);
    const expect = hex(b);
    assert.equal(Buffer.from(sha256(b)).toString("hex"), expect, `js sha256, ${n} bytes`);
    assert.equal(await sha256Hex(b), expect, `subtle sha256, ${n} bytes`);
    // a view into a larger buffer hashes only the view
    const big = random(n + 20);
    big.set(b, 7);
    assert.equal(Buffer.from(sha256(big.subarray(7, 7 + n))).toString("hex"), expect);
    assert.equal(await sha256Hex(big.subarray(7, 7 + n)), expect);
  }
});

test("gzip round-trips and has a platform-neutral header", async () => {
  const z = await gzip(jsonBytes);
  assert.deepEqual([...z.subarray(0, 3)], [0x1f, 0x8b, 8]);
  assert.deepEqual([...z.subarray(4, 8)], [0, 0, 0, 0]);
  assert.equal(z[9], 0xff);
  assert.deepEqual(await gunzip(z), jsonBytes);
  assert.deepEqual(await gunzip(await gzip(new Uint8Array(0))), new Uint8Array(0));
  await assert.rejects(gunzip(z.subarray(0, z.length - 10)));
});

test("write -> read round trip: every entry type, encoding and dtype", async () => {
  const input = sampleInput();
  const file = await writePack(input);

  // preamble and layout
  const dv = new DataView(file.buffer);
  assert.equal(new TextDecoder().decode(file.subarray(0, 4)), "CPET");
  assert.equal(dv.getUint16(4, true), 1);
  assert.equal(dv.getUint16(6, true), 0);
  const { header, data } = headerOf(file);
  assert.equal(dv.getUint32(12, true), crc32(file.subarray(16, 16 + dv.getUint32(8, true))));
  assert.equal(data % 64, 0);
  for (let i = 16 + dv.getUint32(8, true); i < data; i++) assert.equal(file[i], 0, "header padding is zero");
  assert.equal(header.format, "cipetpet");
  assert.equal(header.generator, "cipetpet-pack 0.1.0");
  const last = header.entries[header.entries.length - 1];
  assert.equal(file.length, data + last.offset + last.storedSize, "file ends after the last payload");

  const pack = await Pack.fromBytes(file);
  assert.equal(pack.byteLength, file.length);
  assert.deepEqual(pack.model, model);
  assert.deepEqual(pack.meta, input.meta);
  assert.deepEqual(pack.header.runtime, { onnxruntime: "1.30.0" });
  assert.deepEqual(pack.list().map((e) => e.name), input.entries.map((e) => e.name));

  const enc = Object.fromEntries(pack.list().map((e) => [e.name, e.encoding]));
  assert.equal(enc["graphs/a.onnx"], "raw", "onnx defaults to raw");
  assert.equal(enc["runtime/x.wasm"], "raw", "wasm defaults to raw");
  assert.equal(enc["data/doc.json"], "gzip", "auto gzips compressible data");
  assert.equal(enc["data/blob.bin"], "raw", "auto keeps incompressible data raw");
  assert.equal(enc["data/forced.bin"], "gzip", "explicit gzip is honoured");
  assert.equal(enc["data/note.txt"], "raw", "explicit raw is honoured");
  assert.equal(enc["data/empty"], "raw");

  let prevEnd = 0;
  for (const e of pack.list()) {
    assert.equal(e.offset % 64, 0, `${e.name} offset aligned`);
    assert.ok(e.offset >= prevEnd, "payloads do not overlap");
    prevEnd = e.offset + e.storedSize;
    const src = input.entries.find((x) => x.name === e.name)!;
    assert.equal(e.size, src.data.length);
    assert.equal(e.sha256, hex(src.data));
    const got = await pack.bytes(e.name);
    assert.deepEqual(got, src.data, e.name);
    if (e.encoding === "raw") {
      assert.equal(got.buffer, file.buffer, `${e.name}: raw bytes are a view into the pack`);
      assert.equal(got.byteOffset, data + e.offset);
    }
  }

  assert.equal(await pack.text("data/note.txt"), "merhaba dünya ğüşiöç");
  assert.deepEqual(await pack.json("data/doc.json"), JSON.parse(new TextDecoder().decode(jsonBytes)));
  assert.equal((await pack.bytes("data/empty")).length, 0);

  const f32 = await pack.tensor<Float32Array>("t/f32");
  assert.ok(f32.data instanceof Float32Array);
  assert.deepEqual(f32.shape, [2, 4]);
  assert.equal(f32.dtype, "float32");
  assert.deepEqual(f32.data, tensors.f32);
  assert.notEqual(f32.data.buffer, file.buffer, "tensors are copies");
  const f64 = await pack.tensor<Float64Array>("t/f64");
  assert.ok(f64.data instanceof Float64Array);
  assert.deepEqual(f64.data, tensors.f64);
  const i32 = await pack.tensor<Int32Array>("t/i32");
  assert.ok(i32.data instanceof Int32Array);
  assert.deepEqual(i32.data, tensors.i32);
  const i64 = await pack.tensor<BigInt64Array>("t/i64");
  assert.ok(i64.data instanceof BigInt64Array);
  assert.deepEqual(i64.data, tensors.i64);
  const tu8 = await pack.tensor<Uint8Array>("t/u8");
  assert.deepEqual(tu8.data, tensors.u8);
  assert.notEqual(tu8.data.buffer, file.buffer);
  const zeros = await pack.tensor<Float32Array>("t/zeros");
  assert.equal(pack.entry("t/zeros").encoding, "gzip");
  assert.deepEqual(zeros.data, new Float32Array(256));
  const empty = await pack.tensor("t/scalar0");
  assert.equal(empty.data.length, 0);
  assert.deepEqual(empty.shape, [0, 3]);

  // mutating a returned shape does not touch the header
  f32.shape.push(9);
  assert.deepEqual(pack.entry("t/f32").shape, [2, 4]);

  await assert.rejects(pack.tensor("data/doc.json"), /not a tensor/);
  assert.equal(pack.has("graphs/a.onnx"), true);
  assert.equal(pack.has("nope"), false);
  assert.throws(() => pack.entry("graphs/missing.onnx"), /test-model-v1.*"graphs\/missing.onnx"/);
});

test("tensor() aligns a raw payload that sits at an odd offset in its buffer", async () => {
  const file = await writePack({ model, entries: [{ name: "t", type: "tensor", dtype: "float64", shape: [3], data: u8(tensors.f64), encoding: "raw" }] });
  const shifted = new Uint8Array(file.length + 3);
  shifted.set(file, 3);
  const pack = await Pack.fromBytes(shifted.subarray(3));
  const t = await pack.tensor<Float64Array>("t");
  assert.equal(t.data.byteOffset % 8, 0);
  assert.deepEqual(t.data, tensors.f64);
});

test("writer output is deterministic", async () => {
  const input = sampleInput();
  const a = await writePack(input);
  const b = await writePack(input);
  assert.deepEqual(a, b);
});

test("writer rejects bad input", async () => {
  const one = (e: object) => writePack({ model, entries: [e as never] });
  await assert.rejects(writePack({ model, entries: [{ name: "a", type: "bytes", data: new Uint8Array(1) }, { name: "a", type: "bytes", data: new Uint8Array(1) }] }), /"a": duplicate/);
  await assert.rejects(one({ name: "t", type: "tensor", dtype: "float32", shape: [3], data: new Uint8Array(8) }), /needs 12 bytes/);
  await assert.rejects(one({ name: "t", type: "tensor", dtype: "float16", shape: [3], data: new Uint8Array(6) }), /dtype/);
  await assert.rejects(one({ name: "/abs", type: "bytes", data: new Uint8Array(1) }), /invalid name/);
  await assert.rejects(one({ name: "x", type: "weird", data: new Uint8Array(1) }), /unknown type/);
  await assert.rejects(one({ name: "x", type: "bytes", data: new Uint8Array(1), shape: [1] }), /only allowed on tensor/);
});

test("reader rejects corrupt files with clear errors", async () => {
  const file = await writePack(sampleInput());
  const { data, header } = headerOf(file);
  const mutate = (f: (b: Uint8Array) => void) => {
    const b = file.slice();
    f(b);
    return b;
  };

  await assert.rejects(Pack.fromBytes(mutate((b) => (b[0] = 0x58))), /bad magic/);
  await assert.rejects(Pack.fromBytes(new Uint8Array(5)), /too short/);
  await assert.rejects(Pack.fromBytes(mutate((b) => (b[4] = 2))), /unsupported format version 2/);
  await assert.rejects(Pack.fromBytes(mutate((b) => (b[6] = 1))), /unknown flags/);
  await assert.rejects(Pack.fromBytes(mutate((b) => (b[16 + 20] ^= 0x01))), /CRC-32 mismatch/);
  await assert.rejects(Pack.fromBytes(file.subarray(0, 40)), /truncated header/);
  // truncated payload: the header is intact but the last entry no longer fits
  await assert.rejects(Pack.fromBytes(file.subarray(0, file.length - 1)), /test-model-v1: entry "t\/(zeros|scalar0)": payload .* lies outside the file/);

  // flipped payload byte of a raw entry: detected on read, naming the entry; verify:false skips the check
  const raw = header.entries.find((e) => e.name === "graphs/a.onnx")!;
  const bad = mutate((b) => (b[data + raw.offset + 10] ^= 0xff));
  const pack = await Pack.fromBytes(bad);
  await assert.rejects(pack.bytes("graphs/a.onnx"), /test-model-v1: entry "graphs\/a.onnx": SHA-256 mismatch/);
  assert.equal((await pack.bytes("data/doc.json")).length, jsonBytes.length, "other entries still read");
  const lax = await Pack.fromBytes(bad, { verify: false });
  assert.equal((await lax.bytes("graphs/a.onnx")).length, raw.size);

  // flipped byte in a gzip payload: corrupt stream or hash mismatch, either way an error naming the entry
  const gz = header.entries.find((e) => e.name === "data/doc.json")!;
  const badGz = await Pack.fromBytes(mutate((b) => (b[data + gz.offset + gz.storedSize - 5] ^= 0xff)));
  await assert.rejects(badGz.bytes("data/doc.json"), /entry "data\/doc.json"/);
});

test("reader validates the header's entries", async () => {
  const entry = { name: "a", type: "bytes", offset: 0, storedSize: 4, size: 4, encoding: "raw", sha256: hex(new Uint8Array(4)) };
  const h = (entries: object[], extra = {}) => ({ format: "cipetpet", version: 1, model, meta: {}, entries, ...extra });
  const four = new Uint8Array(4);

  const ok = await Pack.fromBytes(craft(h([entry], { futureKey: 1 }), four));
  assert.deepEqual(await ok.bytes("a"), four, "unknown header keys are ignored");

  await assert.rejects(Pack.fromBytes(craft(h([entry, entry]), four)), /entry "a": duplicate/);
  await assert.rejects(Pack.fromBytes(craft(h([{ ...entry, offset: 64 }]), four)), /outside the file/);
  await assert.rejects(Pack.fromBytes(craft(h([{ ...entry, offset: 3 }]), four)), /multiple of 64/);
  await assert.rejects(Pack.fromBytes(craft(h([{ ...entry, size: 5 }]), four)), /raw entry with storedSize/);
  await assert.rejects(Pack.fromBytes(craft(h([{ ...entry, encoding: "br" }]), four)), /unknown encoding/);
  await assert.rejects(Pack.fromBytes(craft(h([{ ...entry, sha256: "xyz" }]), four)), /invalid sha256/);
  await assert.rejects(Pack.fromBytes(craft(h([{ ...entry, type: "tensor", dtype: "float32", shape: [2] }]), four)), /needs 8 bytes, entry has 4/);
  await assert.rejects(Pack.fromBytes(craft(h([{ ...entry, type: "tensor", dtype: "bfloat16", shape: [2] }]), four)), /unknown tensor dtype/);
  await assert.rejects(Pack.fromBytes(craft({ ...h([]), format: "other" })), /"format" is not "cipetpet"/);
  await assert.rejects(Pack.fromBytes(craft({ ...h([]), version: 2 })), /does not match/);
  await assert.rejects(Pack.fromBytes(craft("not an object")), /format/);
});

test("fromBlob and openPack accept every source type", async () => {
  const file = await writePack(sampleInput());
  const blob = new Blob([file]);
  const fromBlob = await Pack.fromBlob(blob);
  assert.deepEqual(await fromBlob.bytes("graphs/a.onnx"), await (await Pack.fromBytes(file)).bytes("graphs/a.onnx"));

  const progress: PackProgress[] = [];
  const withProgress = await Pack.fromBlob(blob, { onProgress: (p) => progress.push(p) });
  assert.equal(withProgress.byteLength, file.length);
  assert.deepEqual(progress.at(-1), { loaded: file.length, total: file.length });

  const fromAb = await openPack(file.buffer.slice(file.byteOffset, file.byteOffset + file.length));
  assert.equal(fromAb.list().length, sampleInput().entries.length);
  assert.equal((await openPack(file)).byteLength, file.length);
  assert.equal((await openPack(blob)).byteLength, file.length);
  assert.equal(await openPack(fromBlob), fromBlob, "an open Pack is returned as is");
  const fetchFn = (async () => new Response(file)) as typeof fetch;
  assert.equal((await openPack("https://example.test/a.cpet", { fetch: fetchFn })).byteLength, file.length);
  assert.equal((await openPack(new URL("https://example.test/a.cpet"), { fetch: fetchFn })).byteLength, file.length);
  await assert.rejects(openPack(42 as never), TypeError);
});

/** A fetch that serves `bytes` as a stream in `chunk`-byte pieces, optionally waiting between them. */
function streamingFetch(bytes: Uint8Array, opts: { chunk?: number; delayMs?: number; headers?: Record<string, string>; status?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (at >= bytes.length) return ctrl.close();
        const n = Math.min(opts.chunk ?? 1000, bytes.length - at);
        ctrl.enqueue(bytes.slice(at, at + n));
        at += n;
      },
    });
    return new Response(body, { status: opts.status ?? 200, headers: opts.headers ?? { "content-length": String(bytes.length) } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("fromUrl streams with monotonic progress", async () => {
  const file = await writePack(sampleInput());
  const { fn, calls } = streamingFetch(file, { chunk: 777 });
  const progress: PackProgress[] = [];
  const pack = await Pack.fromUrl("https://example.test/p.cpet", {
    fetch: fn,
    onProgress: (p) => progress.push({ ...p }),
    requestInit: { headers: { "x-test": "1" } },
  });
  assert.equal(pack.byteLength, file.length);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].init?.headers, { "x-test": "1" });
  assert.ok(progress.length > file.length / 777, "one report per chunk");
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].loaded >= progress[i - 1].loaded, "monotonic");
  assert.ok(progress.every((p) => p.total === file.length));
  assert.deepEqual(progress.at(-1), { loaded: file.length, total: file.length });
  assert.deepEqual(await pack.bytes("data/doc.json"), jsonBytes);

  // errors on read name the URL
  assert.throws(() => pack.entry("zzz"), /https:\/\/example.test\/p.cpet: no entry "zzz"/);
});

test("fetchBytes: unknown or compressed length reports total 0, then the final size", async () => {
  const file = random(5000);
  const cases: Record<string, string>[] = [{}, { "content-length": "1234", "content-encoding": "gzip" }];
  for (const headers of cases) {
    const { fn } = streamingFetch(file, { chunk: 1024, headers });
    const progress: PackProgress[] = [];
    const got = await fetchBytes("https://example.test/x", { fetch: fn, onProgress: (p) => progress.push({ ...p }) });
    assert.deepEqual(got, file);
    assert.ok(progress.slice(0, -1).every((p) => p.total === 0));
    assert.deepEqual(progress.at(-1), { loaded: 5000, total: 5000 });
  }
  // a server that sends more than its Content-Length still yields every byte
  const { fn } = streamingFetch(file, { chunk: 999, headers: { "content-length": "100" } });
  assert.deepEqual(await fetchBytes("https://example.test/x", { fetch: fn }), file);
  // and fewer: the body is what arrived
  const short = streamingFetch(file, { chunk: 999, headers: { "content-length": "9000" } });
  assert.deepEqual(await fetchBytes("https://example.test/x", { fetch: short.fn }), file);
});

test("fetchBytes: HTTP errors", async () => {
  const { fn } = streamingFetch(new Uint8Array(3), { status: 404 });
  await assert.rejects(fetchBytes("https://example.test/missing.cpet", { fetch: fn }), /missing.cpet failed: HTTP 404/);
});

test("fetchBytes: abort before and during the download", async () => {
  const file = random(100_000);
  await assert.rejects(fetchBytes("https://example.test/x", { fetch: streamingFetch(file).fn, signal: AbortSignal.abort() }), { name: "AbortError" });

  const ctrl = new AbortController();
  const { fn } = streamingFetch(file, { chunk: 1000, delayMs: 5 });
  const progress: PackProgress[] = [];
  const p = fetchBytes("https://example.test/x", {
    fetch: fn,
    signal: ctrl.signal,
    onProgress: (q) => {
      progress.push(q);
      if (q.loaded >= 3000) ctrl.abort();
    },
  });
  await assert.rejects(p, { name: "AbortError" });
  assert.ok(progress.at(-1)!.loaded < file.length);

  // a custom reason is passed through
  const ctrl2 = new AbortController();
  const p2 = Pack.fromUrl("https://example.test/x", { fetch: streamingFetch(file, { delayMs: 5 }).fn, signal: ctrl2.signal });
  setTimeout(() => ctrl2.abort(new Error("user cancelled")), 20);
  await assert.rejects(p2, /user cancelled/);
});

test("fetchBytes: Cache API is used when present and skipped when not", async () => {
  const file = random(4096);
  // no `caches` in Node: cache: true is silently ignored
  assert.equal(typeof (globalThis as { caches?: unknown }).caches, "undefined");
  assert.deepEqual(await fetchBytes("https://example.test/c", { fetch: streamingFetch(file).fn, cache: true }), file);

  const stores = new Map<string, Map<string, Response>>();
  const fake = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const s = stores.get(name)!;
      return {
        async match(url: string) {
          return s.get(url)?.clone();
        },
        async put(url: string, res: Response) {
          s.set(url, res);
        },
      };
    },
  };
  (globalThis as { caches?: unknown }).caches = fake;
  try {
    const a = streamingFetch(file);
    assert.deepEqual(await fetchBytes("https://example.test/c", { fetch: a.fn, cache: true }), file);
    assert.equal(a.calls.length, 1);
    assert.ok(stores.get("cipetpet-packs")?.has("https://example.test/c"));
    const b = streamingFetch(file);
    const progress: PackProgress[] = [];
    assert.deepEqual(await fetchBytes("https://example.test/c", { fetch: b.fn, cache: true, onProgress: (p) => progress.push(p) }), file);
    assert.equal(b.calls.length, 0, "served from the cache");
    assert.deepEqual(progress.at(-1), { loaded: file.length, total: file.length });

    const c = streamingFetch(file);
    await fetchBytes("https://example.test/c", { fetch: c.fn, cache: "my-cache" });
    assert.equal(c.calls.length, 1, "a different cache name misses");
    assert.ok(stores.get("my-cache")?.has("https://example.test/c"));

    const d = streamingFetch(file);
    await fetchBytes("https://example.test/c", { fetch: d.fn });
    assert.equal(d.calls.length, 1, "cache: false (default) does not read the cache");
  } finally {
    delete (globalThis as { caches?: unknown }).caches;
  }
});
