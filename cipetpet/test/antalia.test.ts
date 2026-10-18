// AntaliaMini API behaviour: loading from every source, pack checks, option validation, streaming,
// the per-instance queue (serialised calls, early break, abort) and dispose. Numerical fidelity is
// test/antalia-parity.test.ts.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AntaliaMini } from "../src/antalia/index.js";
import { Pack } from "../src/pack/reader.js";
import { encodeWav, decodeWav } from "../src/audio/wav.js";
import type { SpeechChunk } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACK = join(ROOT, "packs/antalia-mini-mixed.cpet");
const PACK_INT8 = join(ROOT, "packs/antalia-mini-int8.cpet");
const DUYU_PACK = join(ROOT, "packs/duyu-small-q4.cpet");
const OUT = join(ROOT, ".test-out");
const skip = [PACK, PACK_INT8, DUYU_PACK].some((p) => !existsSync(p)) ? "packs missing (npx tsx tools/build-packs.ts)" : false;

const SHORT = "Merhaba, nasılsınız?";
const TWO = "Bugün hava çok güzel. Yarın sabah erkenden yola çıkacağız ve akşam Antalya'da olacağız, inşallah trafik olmaz.";
// three chunks: the first sentence alone (first chunk <= 80 characters), then the rest packed up to 300
const LONG =
  "Yarın İzmir'de hava parçalı bulutlu olacak. Öğleden sonra kuzeyden esen rüzgâr saatte 40 kilometreye kadar " +
  "çıkabilir, bu yüzden denize açılacak olanların dikkatli olması gerekiyor. Hafta sonu ise sağanak yağış " +
  "bekleniyor ve sıcaklıklar mevsim normallerinin altına düşecek. Uzmanlar, özellikle yaşlıların ve çocukların " +
  "sabah saatlerinde kalın giyinmesini, gün içinde bol su içmesini ve gereksiz yolculuklardan kaçınmasını öneriyor.";

const bytesOf = (p: string) => new Uint8Array(readFileSync(p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** rejects if `p` has not settled within `ms` (a stuck queue would otherwise hang the test run) */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms))),
  ]);
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const same = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

describe("AntaliaMini", { skip }, () => {
  let tts: AntaliaMini;

  before(async () => {
    tts = await AntaliaMini.load(bytesOf(PACK), { threads: 1 });
  });

  after(async () => {
    await tts?.dispose();
  });

  test("load from bytes: info and defaults", () => {
    const { info } = tts;
    assert.equal(info.id, "antalia-mini");
    assert.equal(info.task, "text-to-speech");
    assert.equal(info.variant, "mixed");
    assert.equal(info.sampleRate, 48000);
    assert.equal(info.backend, "wasm");
    assert.equal(info.threads, 1);
    assert.equal(info.crossOriginIsolated, false);
    assert.equal(info.packBytes, readFileSync(PACK).byteLength);
    assert.equal(info.onnxruntime, "1.30.0");
    assert.ok(info.loadMs.fetch >= 0 && info.loadMs.init > 0);
    assert.deepEqual({ ...tts.defaults }, { steps: 8, cfg: 2, speed: 0.95, temperature: 0.6 });
    assert.ok(Object.isFrozen(tts.defaults));
  });

  test("load from a Blob, an open Pack and a URL (with progress)", async () => {
    const bytes = bytesOf(PACK_INT8);
    const fromBlob = await AntaliaMini.load(new Blob([bytes]));
    assert.equal(fromBlob.info.variant, "int8");
    const fromPack = await AntaliaMini.load(await Pack.fromBytes(bytes));
    assert.equal(fromPack.info.packBytes, bytes.byteLength);

    const server = createServer((_, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) });
      res.end(bytes);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const progress: number[] = [];
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/antalia-mini-int8.cpet`;
      const fromUrl = await AntaliaMini.load(url, { onProgress: (p) => progress.push(p.loaded / p.total) });
      assert.equal(fromUrl.info.variant, "int8");
      assert.equal(progress.at(-1), 1);
      // three loads of one pack give the same audio
      const a = await fromBlob.synthesize(SHORT, { seed: 5 });
      const b = await fromPack.synthesize(SHORT, { seed: 5 });
      const c = await fromUrl.synthesize(SHORT, { seed: 5 });
      assert.ok(same(a.audio, b.audio) && same(a.audio, c.audio));
      await fromUrl.dispose();
    } finally {
      server.close();
      await fromBlob.dispose();
      await fromPack.dispose();
    }
  });

  test("a pack of another model is refused with a clear error", async () => {
    await assert.rejects(AntaliaMini.load(bytesOf(DUYU_PACK)), (e: Error) => {
      assert.match(e.message, /needs an "antalia-mini" \(text-to-speech\) pack/);
      assert.match(e.message, /"duyu-small" \(speech-recognition, variant "q4"\)/);
      assert.match(e.message, /DuyuSmall/);
      return true;
    });
    await assert.rejects(AntaliaMini.load(new Uint8Array(100)), /not a \.cpet pack/);
  });

  test("an aborted load rejects with AbortError", async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(AntaliaMini.load(bytesOf(PACK_INT8), { signal: ac.signal }), { name: "AbortError" });
  });

  test("options are validated with clear errors", async () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ speed: 0 }, /options\.speed must be > 0, got 0/],
      [{ speed: -1 }, /options\.speed must be > 0/],
      [{ speed: NaN }, /options\.speed must be a finite number, got NaN/],
      [{ steps: 0 }, /options\.steps must be an integer >= 1, got 0/],
      [{ steps: 2.5 }, /options\.steps must be an integer >= 1/],
      [{ steps: "4" }, /options\.steps must be a finite number/],
      [{ cfg: Infinity }, /options\.cfg must be a finite number, got Infinity/],
      [{ temperature: -0.1 }, /options\.temperature must be >= 0/],
      [{ seed: 1.5 }, /options\.seed must be an integer/],
      [{ raw: "yes" }, /options\.raw must be a boolean/],
      [{ signal: {} }, /options\.signal must be an AbortSignal/],
    ];
    for (const [opts, msg] of bad) {
      await assert.rejects(tts.synthesize(SHORT, opts), msg, JSON.stringify(opts));
      await assert.rejects(tts.stream(SHORT, opts).next(), msg);
    }
    await assert.rejects(tts.synthesize(42 as unknown as string), /text must be a string/);
    assert.throws(() => tts.normalize(null as unknown as string), /text must be a string/);
    // the queue is not left held by a rejected call
    assert.ok((await within(tts.synthesize(SHORT, { steps: 1 }), 30_000, "synthesize after errors")).audio.length > 0);
  });

  test("normalize() gives model text; empty text gives no audio", async () => {
    assert.equal(tts.normalize("15 Ekim'de 1.250.000 TL ödendi."), "on beş ekim'de bir milyon iki yüz elli bin lira ödendi.");
    assert.equal(tts.normalize("   "), "");
    const r = await tts.synthesize("  ...  ");
    assert.equal(r.audio.length, 0);
    assert.equal(r.stats.chunks, 0);
    assert.equal(r.stats.seconds, 0);
    const chunks = [];
    for await (const c of tts.stream("")) chunks.push(c);
    assert.equal(chunks.length, 0);
  });

  test("synthesize(): 48 kHz audio, stats, deterministic per seed; written to .test-out/antalia-sample.wav", async () => {
    const r = await tts.synthesize(TWO, { seed: 0 });
    assert.equal(r.sampleRate, 48000);
    assert.equal(r.modelText, tts.normalize(TWO));
    assert.ok(r.audio.length > 48000 * 3, `${r.audio.length} samples`);
    assert.ok(r.audio.every((x) => Number.isFinite(x) && Math.abs(x) <= 1));
    assert.equal(r.stats.seconds, r.audio.length / 48000);
    assert.equal(r.stats.chunks, 2);
    assert.ok(r.stats.computeMs > 0 && r.stats.rtf > 0 && r.stats.rtf < 5);
    for (const k of ["normalize", "text", "cond", "flow", "vocoder", "istft", "post"] as const) assert.ok(r.stats.timings[k] >= 0, k);
    assert.ok(r.stats.timings.flow > 0);
    assert.ok(same(r.audio, (await tts.synthesize(TWO, { seed: 0 })).audio), "same seed, same audio");
    assert.ok(!same(r.audio, (await tts.synthesize(TWO, { seed: 1 })).audio), "another seed, other audio");

    mkdirSync(OUT, { recursive: true });
    const wav = encodeWav(r.audio, r.sampleRate);
    writeFileSync(join(OUT, "antalia-sample.wav"), wav);
    const back = decodeWav(wav);
    assert.equal(back.sampleRate, 48000);
    assert.equal(back.channels[0].length, r.audio.length);
  });

  test("stream() yields count chunks with indices, first sentence first; joined == synthesize()", async () => {
    const chunks: SpeechChunk[] = [];
    for await (const c of tts.stream(LONG, { seed: 3, steps: 4 })) chunks.push(c);
    assert.equal(chunks.length, 3);
    chunks.forEach((c, i) => {
      assert.equal(c.index, i);
      assert.equal(c.count, 3);
      assert.ok(c.audio.length > 0);
      assert.ok(c.timings.flow! > 0);
    });
    assert.equal(chunks[0].text, "yarın izmir'de hava parçalı bulutlu olacak.");
    assert.ok("normalize" in chunks[0].timings && !("normalize" in chunks[1].timings));
    assert.equal(chunks.map((c) => c.text).join(" "), tts.normalize(LONG));
    const whole = await tts.synthesize(LONG, { seed: 3, steps: 4 });
    assert.ok(same(concat(chunks.map((c) => c.audio)), whole.audio));
  });

  test("a stream holds the instance while iterated; breaking out early releases it", async () => {
    const it = tts.stream(LONG, { steps: 1 });
    const first = await it.next();
    assert.equal((first.value as SpeechChunk).index, 0);
    let done = false;
    const pending = tts.synthesize(SHORT, { steps: 1 }).then((r) => ((done = true), r));
    await sleep(300);
    assert.equal(done, false, "synthesize waits while the stream holds the instance");
    for await (const c of { [Symbol.asyncIterator]: () => it }) if (c.index >= 1) break;
    assert.ok((await within(pending, 30_000, "synthesize after break")).audio.length > 0);

    // a plain for-await with break, and one left by a throw
    for await (const _ of tts.stream(LONG, { steps: 1 })) break;
    await assert.rejects(
      (async () => {
        for await (const _ of tts.stream(LONG, { steps: 1 })) throw new Error("consumer failed");
      })(),
      /consumer failed/,
    );
    assert.ok((await within(tts.synthesize(SHORT, { steps: 1 }), 30_000, "synthesize after throw")).audio.length > 0);
  });

  test("concurrent synthesize() calls are serialised and each gives its own correct result", async () => {
    const a = await tts.synthesize(SHORT, { seed: 11 });
    const b = await tts.synthesize(TWO, { seed: 12, speed: 1.1 });
    const c = await tts.synthesize(SHORT, { seed: 13, steps: 2 });
    const order: string[] = [];
    const [ra, rb, rc] = await Promise.all([
      tts.synthesize(SHORT, { seed: 11 }).then((r) => (order.push("a"), r)),
      tts.synthesize(TWO, { seed: 12, speed: 1.1 }).then((r) => (order.push("b"), r)),
      tts.synthesize(SHORT, { seed: 13, steps: 2 }).then((r) => (order.push("c"), r)),
    ]);
    assert.ok(same(ra.audio, a.audio) && same(rb.audio, b.audio) && same(rc.audio, c.audio));
    assert.deepEqual(order, ["a", "b", "c"], "first come, first served");
  });

  test("abort mid-stream rejects with AbortError and releases the instance", async () => {
    const ac = new AbortController();
    const got: number[] = [];
    await assert.rejects(
      (async () => {
        for await (const c of tts.stream(LONG, { steps: 2, signal: ac.signal })) {
          got.push(c.index);
          ac.abort();
        }
      })(),
      { name: "AbortError" },
    );
    assert.deepEqual(got, [0]);

    // aborted while running inside a chunk (between graph runs)
    const ac2 = new AbortController();
    const p = tts.synthesize(LONG, { steps: 8, signal: ac2.signal });
    setTimeout(() => ac2.abort(), 50);
    await assert.rejects(p, { name: "AbortError" });

    // a reason that is not an AbortError becomes the cause of one
    const ac3 = new AbortController();
    ac3.abort(new Error("user left"));
    await assert.rejects(tts.synthesize(SHORT, { signal: ac3.signal }), (e: Error & { cause?: Error }) => e.name === "AbortError" && e.cause?.message === "user left");

    assert.ok((await within(tts.synthesize(SHORT, { steps: 1 }), 30_000, "synthesize after abort")).audio.length > 0);

    // a signal that never fires changes nothing in the audio (the checks only yield to the event loop)
    const plain = await tts.synthesize(TWO, { seed: 4 });
    assert.ok(same((await tts.synthesize(TWO, { seed: 4, signal: new AbortController().signal })).audio, plain.audio));
  });

  test("abort while waiting for the queue rejects at once; the running call is unaffected", async () => {
    const expected = await tts.synthesize(TWO, { seed: 2 });
    const running = tts.synthesize(TWO, { seed: 2 });
    const ac = new AbortController();
    const waiting = tts.synthesize(SHORT, { signal: ac.signal });
    const t0 = performance.now();
    ac.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    assert.ok(performance.now() - t0 < 100, "rejected without waiting for the running call");
    assert.ok(same((await running).audio, expected.audio));
    assert.ok((await within(tts.synthesize(SHORT, { steps: 1 }), 30_000, "synthesize after queued abort")).audio.length > 0);
  });

  test("dispose() waits for queued work, releases the sessions, and later calls throw", async () => {
    const model = await AntaliaMini.load(bytesOf(PACK_INT8));
    const running = model.synthesize(SHORT, { steps: 2 });
    const d1 = model.dispose();
    assert.equal(model.dispose(), d1, "dispose is idempotent");
    assert.ok((await running).audio.length > 0, "a call queued before dispose still completes");
    await d1;
    await assert.rejects(model.synthesize(SHORT), /has been disposed/);
    await assert.rejects(model.stream(SHORT).next(), /has been disposed/);
    assert.throws(() => model.normalize(SHORT), /has been disposed/);
  });
});
