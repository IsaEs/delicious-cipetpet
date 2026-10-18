// DuyuSmall API behaviour: loading, validation, resampling, abort, serialised calls, dispose.
// Transcript fidelity against the Python engine is test/duyu-parity.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DuyuSmall } from "../src/duyu/index.js";
import { Pack } from "../src/pack/reader.js";
import { decodeWav } from "../src/audio/wav.js";
import { resample, toMono } from "../src/audio/resample.js";
import { isAbortError } from "../src/util/abort.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INT8 = join(ROOT, "packs/duyu-small-int8.cpet");
const ANTALIA = join(ROOT, "packs/antalia-mini-int8.cpet");
const AUDIO = join(ROOT, "test/fixtures/audio");
const skip = !existsSync(INT8) ? `${INT8} missing (npx tsx tools/build-packs.ts)` : false;

const manifest = new Map(
  readFileSync(join(AUDIO, "manifest.tsv"), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split("\t"))
    .map(([id, , text]) => [id, text]),
);
const clip = (id: string) => toMono(decodeWav(new Uint8Array(readFileSync(join(AUDIO, `${id}.wav`)))).channels);

let model: DuyuSmall;
before(async () => {
  if (!skip) model = await DuyuSmall.load(new Uint8Array(readFileSync(INT8)));
});
after(() => model?.dispose());

test("load from bytes: model info", { skip }, () => {
  const info = model.info;
  assert.equal(info.id, "duyu-small");
  assert.equal(info.task, "speech-recognition");
  assert.equal(info.variant, "int8");
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.backend, "wasm");
  assert.equal(info.packBytes, readFileSync(INT8).byteLength);
  assert.equal(info.onnxruntime, "1.30.0");
  assert.ok(info.threads >= 1);
  assert.ok(info.loadMs.fetch >= 0 && info.loadMs.init > 0);
});

test("load from a Blob and from an open Pack, with progress", { skip }, async () => {
  const bytes = readFileSync(INT8);
  const seen: number[] = [];
  const m1 = await DuyuSmall.load(new Blob([bytes]), { onProgress: (p) => seen.push(p.loaded) });
  try {
    assert.ok(seen.length > 0 && seen.at(-1) === bytes.byteLength);
    const r = await m1.transcribe(clip("clip01"));
    assert.equal(r.text, manifest.get("clip01"));
  } finally {
    await m1.dispose();
  }
  const m2 = await DuyuSmall.load(await Pack.fromBytes(new Uint8Array(bytes)));
  await m2.dispose();
});

test("a pack of another model is rejected with a clear error", { skip: skip || (!existsSync(ANTALIA) && "antalia pack missing") }, async () => {
  await assert.rejects(DuyuSmall.load(new Uint8Array(readFileSync(ANTALIA))), /needs a "duyu-small" pack, got "antalia-mini"/);
  await assert.rejects(DuyuSmall.load(new Uint8Array(64)), /not a \.cpet pack/);
});

test("transcribes a clip; result shape", { skip }, async () => {
  const audio = clip("clip04");
  const r = await model.transcribe(audio);
  assert.equal(r.text, manifest.get("clip04"));
  assert.equal(r.lang, "mix");
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].start, 0);
  assert.equal(r.segments[0].end, audio.length / 16000);
  assert.equal(r.segments[0].text, r.text);
  assert.ok(r.segments[0].tokens.length > 5);
  assert.equal(r.stats.chunks, 1);
  assert.equal(r.stats.mode, "attn");
  assert.equal(r.stats.seconds, audio.length / 16000);
  assert.ok(r.stats.computeMs > 0 && r.stats.encoderMs > 0 && r.stats.decoderMs > 0);
  assert.ok(Math.abs(r.stats.rtf - r.stats.computeMs / 1000 / r.stats.seconds) < 1e-9);

  const ctc = await model.transcribe(audio, { mode: "ctc", lang: "tr" });
  assert.equal(ctc.stats.mode, "ctc");
  assert.equal(ctc.stats.decoderMs, 0);
  assert.equal(ctc.lang, "tr");
  const auto = await model.transcribe(clip("clip05"), { lang: "auto" });
  assert.ok(["tr", "en", "mix"].includes(auto.lang));
});

test("resamples 48 kHz input (sampleRate option)", { skip }, async () => {
  const a16 = clip("clip01");
  const a48 = resample(a16, 16000, 48000);
  const r = await model.transcribe(a48, { sampleRate: 48000 });
  assert.equal(r.text, manifest.get("clip01"));
  assert.ok(Math.abs(r.stats.seconds - a16.length / 16000) < 1e-9);
  assert.ok(Math.abs(r.segments[0].end - a16.length / 16000) < 1e-9);
});

test("empty and very short audio give empty text", { skip }, async () => {
  for (const tailPad of [true, false]) {
    const r = await model.transcribe(new Float32Array(0), { tailPad });
    assert.equal(r.text, "");
    assert.equal(r.stats.seconds, 0);
    assert.equal(r.stats.rtf, 0);
    assert.deepEqual(r.segments.map((s) => [s.start, s.end, s.text]), [[0, 0, ""]]);
  }
  // fewer than two fbank frames without the tail pad: nothing reaches the graphs
  const short = await model.transcribe(new Float32Array(300).fill(0.1), { tailPad: false });
  assert.equal(short.text, "");
  assert.deepEqual(short.segments[0].tokens, []);
  const enc = await model.encode(new Float32Array(300));
  assert.equal(enc.frames, 0);
});

test("encode() gives the CTC log-probs at 25 frames per second", { skip }, async () => {
  const enc = await model.encode(new Float32Array(16000 * 2));
  assert.equal(enc.vocab, 2048);
  assert.equal(enc.dim, 256);
  assert.equal(enc.frames, 50); // 198 fbank frames -> 99 stacked -> 50 after the encoder's subsampling (ceil(99/2); the Python engine gives 50 too)
  assert.equal(enc.logp.length, enc.frames * enc.vocab);
  assert.equal(enc.h.length, enc.frames * enc.dim);
  let s = 0;
  for (let v = 0; v < enc.vocab; v++) s += Math.exp(enc.logp[v]);
  assert.ok(Math.abs(s - 1) < 1e-3);
});

test("invalid input and options are rejected", { skip }, async () => {
  const a = new Float32Array(1600);
  await assert.rejects(model.transcribe([0, 1] as unknown as Float32Array), TypeError);
  await assert.rejects(model.transcribe(new Float64Array(10) as unknown as Float32Array), TypeError);
  for (const sampleRate of [0, -1, NaN, Infinity]) await assert.rejects(model.transcribe(a, { sampleRate }), RangeError);
  for (const beam of [0, -1, 2.5, NaN]) await assert.rejects(model.transcribe(a, { beam }), /beam must be an integer/);
  await assert.rejects(model.transcribe(a, { beam: 4096 }), /beam must be an integer in \[1, 2048\]/);
  await assert.rejects(model.transcribe(a, { lang: "de" as "tr" }), /lang must be one of/);
  await assert.rejects(model.transcribe(a, { mode: "fast" as "ctc" }), /mode must be/);
  await assert.rejects(model.transcribe(a, { ctcWeight: 2 }), /ctcWeight/);
});

test("abort: before the call and while it runs; the model keeps working", { skip }, async () => {
  const audio = clip("clip08");
  await assert.rejects(model.transcribe(audio, { signal: AbortSignal.abort() }), (e) => isAbortError(e));

  const ac = new AbortController();
  const p = model.transcribe(audio, { signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, (e) => isAbortError(e, ac.signal));

  const reason = new Error("stop");
  const ac2 = new AbortController();
  const p2 = model.transcribe(audio, { signal: ac2.signal });
  ac2.abort(reason);
  await assert.rejects(p2, (e) => e === reason);

  const r = await model.transcribe(clip("clip01"));
  assert.equal(r.text, manifest.get("clip01"));
});

test("abort: a call still waiting in the queue rejects at once, without waiting for the running one", { skip }, async () => {
  const audio = clip("clip08");
  // a signal makes the running call yield to the event loop between graph runs (see checkAbort), so the timer can fire
  const running = model.transcribe(audio, { signal: new AbortController().signal });
  const ac = new AbortController();
  const queued = model.transcribe(audio, { signal: ac.signal });
  let runningDone = false;
  void running.then(() => (runningDone = true));
  setTimeout(() => ac.abort(), 0);
  await assert.rejects(queued, (e) => isAbortError(e, ac.signal));
  assert.equal(runningDone, false, "the queued call must reject before the running one has finished");
  assert.equal((await running).text, (await model.transcribe(audio)).text);
});

test("concurrent calls are serialised and each gets its own result", { skip }, async () => {
  const ids = ["clip01", "clip05", "clip04", "clip07"];
  const solo = new Map<string, string>();
  for (const id of ids) solo.set(id, (await model.transcribe(clip(id))).text);

  const order: string[] = [];
  const inputs = ids.map(clip);
  const results = await Promise.all(
    ids.map((id, i) =>
      model.transcribe(inputs[i]).then((r) => {
        order.push(id);
        return r.text;
      }),
    ),
  );
  // the caller may reuse its buffer as soon as transcribe() returns
  for (const a of inputs) a.fill(0);
  assert.deepEqual(results, ids.map((id) => solo.get(id)));
  assert.deepEqual(order, ids);
});

test("dispose waits for queued calls, then rejects new ones", { skip }, async () => {
  const m = await DuyuSmall.load(new Uint8Array(readFileSync(INT8)));
  const pending = m.transcribe(clip("clip01"));
  const disposed = m.dispose();
  assert.equal((await pending).text, manifest.get("clip01"));
  await disposed;
  await assert.rejects(m.transcribe(clip("clip01")), /disposed/);
  await assert.rejects(m.encode(new Float32Array(1600)), /disposed/);
  await m.dispose(); // idempotent
});
