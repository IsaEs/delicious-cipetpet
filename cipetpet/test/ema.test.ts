// EmaLightning: API behaviour (loading, pack checks, options, streaming, the per-instance queue, abort, dispose),
// loadTextToSpeech's dispatch, and fidelity: bit-identical audio and identical model text against ema-lightning-web's
// own browser port (web/src/core.js + its wasm-bindgen glue), when ../ema-lightning-web/web is checked out.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EmaLightning } from "../src/ema/index.js";
import { TurkishNormalizer } from "../src/ema/normalizer.js";
import { chunk, windows } from "../src/ema/engine.js";
import { AntaliaMini } from "../src/antalia/index.js";
import { loadTextToSpeech } from "../src/tts.js";
import { Pack } from "../src/pack/reader.js";
import { initRuntime } from "../src/runtime/ort.js";
import type { SpeechChunk } from "../src/types.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACK = join(ROOT, "packs/ema-lightning-fp32.cpet");
const ANTALIA_PACK = join(ROOT, "packs/antalia-mini-int8.cpet");
const WEB = join(ROOT, "../ema-lightning-web/web");
const skip = !existsSync(PACK) ? "ema-lightning pack missing (npx tsx tools/build-packs.ts --only ema-lightning-fp32 --ema DIR)" : false;
const skipParity = skip || (!existsSync(join(WEB, "src/core.js")) ? "../ema-lightning-web/web not checked out" : false);

const SHORT = "Merhaba, nasılsınız?";
const NUMBERS = "Toplantı 15 Temmuz'da saat 09:30'da başlayacak; bütçe 1.250.000 TL, %15 indirimle.";
// over 180 letters: cut into pieces at the last sentence end that fits, a pause after each
const LONG =
  "Yarın İzmir'de hava parçalı bulutlu olacak. Öğleden sonra kuzeyden esen rüzgâr saatte 40 kilometreye kadar " +
  "çıkabilir, bu yüzden denize açılacak olanların dikkatli olması gerekiyor. Hafta sonu ise sağanak yağış bekleniyor.";

const bytesOf = (p: string) => new Uint8Array(readFileSync(p));
const same = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe("EMA Lightning text chunks", () => {
  test("chunk(): short text is one piece; long text is cut at sentence ends with pauses, the last without", () => {
    assert.deepEqual(chunk("merhaba dünya", 1), [["merhaba dünya.", 0]]);
    const pieces = chunk("bir iki üç. ".repeat(30).trim(), 1);
    assert.ok(pieces.length > 1);
    assert.ok(pieces.every(([p]) => p.length <= 181 && /[.!?]$/.test(p)));
    assert.deepEqual(pieces.slice(0, -1).map(([, pause]) => pause), pieces.slice(0, -1).map(() => 0.25));
    assert.equal(pieces.at(-1)![1], 0);
    // a slower voice packs fewer letters per piece
    assert.ok(chunk("bir iki üç. ".repeat(30).trim(), 0.5).length > pieces.length);
    assert.deepEqual(chunk("... !!!", 1), []);
  });

  test("windows(): one second first, then four-second windows", () => {
    assert.deepEqual(windows(10, 25), [[0, 10]]);
    assert.deepEqual(windows(230, 25), [[0, 25], [25, 125], [125, 225], [225, 230]]);
    assert.deepEqual(windows(150), [[0, 100], [100, 150]]);
  });
});

describe("EmaLightning", { skip }, () => {
  let tts: EmaLightning;

  before(async () => {
    tts = await EmaLightning.load(bytesOf(PACK), { threads: 1 });
  });

  after(async () => {
    await tts?.dispose();
  });

  test("load from bytes: info and defaults", () => {
    const { info } = tts;
    assert.equal(info.id, "ema-lightning");
    assert.equal(info.name, "EMA Lightning");
    assert.equal(info.task, "text-to-speech");
    assert.equal(info.variant, "fp32");
    assert.equal(info.sampleRate, 48000);
    assert.equal(info.backend, "wasm");
    assert.equal(info.threads, 1);
    assert.equal(info.packBytes, readFileSync(PACK).byteLength);
    assert.ok(info.loadMs.init > 0);
    assert.deepEqual({ ...tts.defaults }, { speed: 1 });
    assert.ok(Object.isFrozen(tts.defaults));
  });

  test("packs of other models are refused with a clear error, both ways", async () => {
    await assert.rejects(EmaLightning.load(new Uint8Array(100)), /not a \.cpet pack/);
    if (!existsSync(ANTALIA_PACK)) return;
    await assert.rejects(EmaLightning.load(bytesOf(ANTALIA_PACK)), (e: Error) => {
      assert.match(e.message, /needs an "ema-lightning" \(text-to-speech\) pack/);
      assert.match(e.message, /AntaliaMini/);
      return true;
    });
    await assert.rejects(AntaliaMini.load(bytesOf(PACK)), /needs an "antalia-mini".*EmaLightning/);
  });

  test("loadTextToSpeech() loads the model the pack names; `expect` refuses the other one", async () => {
    const pack = await Pack.fromBytes(bytesOf(PACK));
    const loaded = await loadTextToSpeech(pack, { threads: 1 });
    try {
      assert.ok(loaded instanceof EmaLightning);
      const a = await loaded.synthesize(SHORT, { seed: 3 });
      const b = await tts.synthesize(SHORT, { seed: 3 });
      assert.ok(same(a.audio, b.audio));
    } finally {
      await loaded.dispose();
    }
    await assert.rejects(loadTextToSpeech(pack, {}, "antalia-mini"), /needs an "antalia-mini"/);
  });

  test("an aborted load rejects with AbortError", async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(EmaLightning.load(bytesOf(PACK), { signal: ac.signal }), { name: "AbortError" });
  });

  test("options are validated; Antalia's steps / cfg / temperature are accepted and change nothing", async () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ speed: 0.2 }, /options\.speed must be from 0\.25 to 4 for EMA Lightning, got 0\.2/],
      [{ speed: 5 }, /options\.speed must be from 0\.25 to 4/],
      [{ speed: NaN }, /options\.speed must be a finite number, got NaN/],
      [{ seed: 1.5 }, /options\.seed must be an integer/],
      [{ steps: "4" }, /options\.steps must be a finite number/],
      [{ raw: "yes" }, /options\.raw must be a boolean/],
    ];
    for (const [opts, re] of bad) await assert.rejects(tts.synthesize(SHORT, opts), re);
    const plain = await tts.synthesize(SHORT, { seed: 2 });
    const antaliaOptions = await tts.synthesize(SHORT, { seed: 2, steps: 1, cfg: 5, temperature: 0 });
    assert.ok(same(plain.audio, antaliaOptions.audio));
  });

  test("normalize() reads numbers and units out; raw skips the normaliser; empty text gives no audio", async () => {
    const text = tts.normalize(NUMBERS);
    assert.match(text, /^toplantı on beş temmuz'da saat dokuz otuzda/);
    assert.match(text, /yüzde on beş/);
    assert.doesNotMatch(text, /\d/);
    const raw = await tts.synthesize("Dr. 5 kişi", { raw: true });
    assert.equal(raw.modelText, "dr. kişi");
    const empty = await tts.synthesize("  ... ");
    assert.equal(empty.audio.length, 0);
    assert.equal(empty.stats.chunks, 0);
  });

  test("synthesize(): 48 kHz audio, stats, deterministic per seed, slower speed = longer audio", async () => {
    const a = await tts.synthesize(SHORT, { seed: 11 });
    const b = await tts.synthesize(SHORT, { seed: 11 });
    const c = await tts.synthesize(SHORT, { seed: 12 });
    assert.equal(a.sampleRate, 48000);
    assert.ok(a.audio.length > 0.5 * 48000 && a.audio.length < 4 * 48000);
    assert.ok(a.audio.every((x) => Number.isFinite(x) && Math.abs(x) <= 1.5));
    assert.ok(same(a.audio, b.audio));
    assert.ok(!same(a.audio, c.audio));
    assert.equal(a.stats.seconds, a.audio.length / 48000);
    assert.ok(a.stats.timings.text > 0 && a.stats.timings.flow > 0 && a.stats.timings.vocoder > 0);
    assert.equal(a.stats.timings.cond, 0);
    const slow = await tts.synthesize(SHORT, { seed: 11, speed: 0.5 });
    assert.ok(slow.audio.length > a.audio.length * 1.6);
  });

  test("stream(): the first chunk is one second; piece indices; joined == synthesize()", async () => {
    const chunks: SpeechChunk[] = [];
    for await (const c of tts.stream(LONG, { seed: 4 })) chunks.push(c);
    assert.equal(chunks[0].audio.length, 48000);
    const count = chunks[0].count;
    assert.ok(count >= 2);
    assert.deepEqual([...new Set(chunks.map((c) => c.index))], [...Array(count).keys()]);
    assert.ok(chunks.every((c) => c.count === count && c.text.length > 0));
    assert.ok(chunks[0].timings.normalize !== undefined && chunks.slice(1).every((c) => c.timings.normalize === undefined));
    const whole = await tts.synthesize(LONG, { seed: 4 });
    assert.ok(same(concat(chunks.map((c) => c.audio)), whole.audio));
  });

  test("a stream holds the instance; breaking out early releases it", async () => {
    const it = tts.stream(LONG, { seed: 1 });
    await it.next();
    let done = false;
    const queued = tts.synthesize(SHORT).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(done, false);
    await it.return(undefined);
    await queued;
    assert.equal(done, true);
  });

  test("abort mid-stream rejects with AbortError and releases the instance", async () => {
    const ac = new AbortController();
    const seen: number[] = [];
    await assert.rejects(
      (async () => {
        for await (const c of tts.stream(LONG, { signal: ac.signal })) {
          seen.push(c.index);
          ac.abort(new Error("stop"));
        }
      })(),
      { name: "AbortError" },
    );
    assert.equal(seen.length, 1);
    const after = await tts.synthesize(SHORT, { seed: 1 });
    assert.ok(after.audio.length > 0);
  });

  test("dispose() waits for queued work, then later calls throw", async () => {
    const own = await EmaLightning.load(bytesOf(PACK), { threads: 1 });
    const running = own.synthesize(SHORT);
    const disposed = own.dispose();
    assert.equal(own.dispose(), disposed);
    assert.ok((await running).audio.length > 0);
    await disposed;
    assert.throws(() => own.normalize(SHORT), /disposed/);
    await assert.rejects(own.synthesize(SHORT), /disposed/);
  });
});

describe("EmaLightning fidelity against ema-lightning-web's browser port", { skip: skipParity }, () => {
  let tts: EmaLightning;
  // web/src/core.js's Pipeline, on the same ORT module and graphs, with the wasm-bindgen glue's normalizer
  let reference: { stream(text: string, o: { speed: number; seed: number }): AsyncGenerator<Float32Array>; frontend: { run(t: string): string } };
  let glue: { normalize(text: string): string };
  let ours: TurkishNormalizer;

  before(async () => {
    tts = await EmaLightning.load(bytesOf(PACK), { threads: 1 });
    // the ORT module (and thread setting) the library runs on: another build of ORT is not bit-identical
    const { ort } = await initRuntime({ threads: 1 });
    const wasm = bytesOf(join(WEB, "normalizer/pkg/normalizer_tr_wasm_bg.wasm"));
    const bindgen = await import(pathToFileURL(join(WEB, "normalizer/pkg/normalizer_tr_wasm.js")).href);
    bindgen.initSync({ module: wasm });
    glue = new bindgen.TurkishNormalizer();
    ours = await TurkishNormalizer.create(wasm);
    const core = await import(pathToFileURL(join(WEB, "src/core.js")).href);
    const pack = await Pack.fromBytes(bytesOf(PACK));
    const files: Record<string, string> = { "config.json": "model/config.json", "text.onnx": "graphs/text.onnx", "sound.onnx": "graphs/sound.onnx", "decoder.onnx": "graphs/decoder.onnx" };
    reference = await core.load(ort, (name: string) => pack.bytes(files[name]), (text: string) => glue.normalize(text));
  });

  after(async () => {
    await tts?.dispose();
    ours?.free();
  });

  test("the normalizer binding gives what wasm-bindgen's glue gives (results and errors)", () => {
    const corpus = [
      "", "Merhaba", NUMBERS, LONG, "Dr. Ayşe 12,5 kg un aldı.", "Kod: 00042", "TBMM'de 3/4 oranında", "5 km/sa · 3 °C",
      "😀 emoji ve ﬁ ligatür", "İSTANBUL ve ıIiİ", "x".repeat(20000), "1".repeat(5000), "́́", "a\u0000b",
    ];
    const outcome = (f: () => string) => {
      try {
        return { ok: f() };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };
    for (const text of corpus) assert.deepEqual(outcome(() => ours.normalize(text)), outcome(() => glue.normalize(text)), JSON.stringify(text.slice(0, 40)));
  });

  test("model text is identical to core.js's Frontend", () => {
    for (const text of [SHORT, NUMBERS, LONG, "“Tırnak” – tire… ve ’kesme’", "  çok   boşluk\t\nve‎yön ", "\uD800 yalnız vekil"]) {
      assert.equal(tts.normalize(text), reference.frontend.run(text), text);
    }
  });

  test("audio is bit-identical to core.js for every text, seed and speed", async () => {
    const cases: [string, number, number][] = [
      [SHORT, 0, 1],
      [NUMBERS, 7, 1],
      [LONG, 2 ** 31 - 1, 1],
      [LONG, 3, 0.5],
      [SHORT, 5, 2.5],
      ["Bir.", 1, 1],
    ];
    for (const [text, seed, speed] of cases) {
      const want: Float32Array[] = [];
      for await (const audio of reference.stream(text, { speed, seed })) want.push(audio);
      const got = await tts.synthesize(text, { seed, speed });
      assert.ok(same(got.audio, concat(want)), `${JSON.stringify(text.slice(0, 30))} seed ${seed} speed ${speed}`);
    }
  });
});
