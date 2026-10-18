// Audio utilities: WAV codec, resampler, decodeAudio, and the browser-only guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeWav, encodeWav } from "../src/audio/wav.js";
import { resample, toMono } from "../src/audio/resample.js";
import { decodeAudio } from "../src/audio/decode.js";
import { MicRecorder } from "../src/audio/record.js";
import { playAudio, StreamPlayer } from "../src/audio/play.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/audio/", import.meta.url));
// A python with numpy for the comparison against numpy; without REFVENV_PYTHON that one test is skipped.
const REFVENV_PYTHON = process.env.REFVENV_PYTHON ?? "";

// ------------------------------------------------------------------------------------------- helpers
function tone(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const x = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return x;
}

/** amplitude of a sinusoid at `freq` (least-squares fit over the middle 60 %, away from the edges) */
function amplitude(y: Float32Array, freq: number, rate: number): number {
  const a = Math.floor(y.length * 0.2);
  const b = Math.floor(y.length * 0.8);
  let ys = 0, yc = 0, ss = 0, cc = 0;
  for (let i = a; i < b; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / rate);
    const c = Math.cos((2 * Math.PI * freq * i) / rate);
    ys += y[i] * s; yc += y[i] * c; ss += s * s; cc += c * c;
  }
  return Math.hypot(ys / ss, yc / cc);
}

function rmsMiddle(y: Float32Array): number {
  const a = Math.floor(y.length * 0.2);
  const b = Math.floor(y.length * 0.8);
  let s = 0;
  for (let i = a; i < b; i++) s += y[i] * y[i];
  return Math.sqrt(s / (b - a));
}

/** deterministic pseudo-random samples in [-1, 1) */
function noise(n: number, seed = 1): Float32Array {
  const x = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    x[i] = s / 2 ** 31 - 1;
  }
  return x;
}

/** builds a RIFF file from chunks, adding the pad byte after odd-sized chunks */
function riff(chunks: [string, Uint8Array, number?][]): Uint8Array {
  const parts: number[] = [];
  const tag = (s: string) => parts.push(...[...s].map((c) => c.charCodeAt(0)));
  const u32 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  tag("WAVE");
  for (const [id, body, declared] of chunks) {
    tag(id);
    u32(declared ?? body.length);
    parts.push(...body);
    if (body.length & 1) parts.push(0);
  }
  const out = new Uint8Array(8 + parts.length);
  out.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(out.buffer).setUint32(4, parts.length, true);
  out.set(parts, 8);
  return out;
}

function fmtChunk(format: number, channels: number, rate: number, bits: number, extensibleSubformat?: number): Uint8Array {
  const ext = extensibleSubformat !== undefined;
  const b = new Uint8Array(ext ? 40 : 16);
  const v = new DataView(b.buffer);
  const align = (channels * bits) / 8;
  v.setUint16(0, ext ? 0xfffe : format, true);
  v.setUint16(2, channels, true);
  v.setUint32(4, rate, true);
  v.setUint32(8, rate * align, true);
  v.setUint16(12, align, true);
  v.setUint16(14, bits, true);
  if (ext) {
    v.setUint16(16, 22, true); // cbSize
    v.setUint16(18, bits, true); // valid bits
    v.setUint32(20, channels === 2 ? 3 : 4, true); // channel mask
    // KSDATAFORMAT_SUBTYPE_* = {0000xxxx-0000-0010-8000-00aa00389b71}
    v.setUint16(24, extensibleSubformat, true);
    b.set([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 26);
  }
  return b;
}

// ------------------------------------------------------------------------------------------- WAV
test("encodeWav/decodeWav: 16-bit mono round trip", () => {
  const x = noise(4801);
  const wav = encodeWav(x, 16000);
  assert.equal(wav.length, 44 + 2 * x.length);
  const { sampleRate, channels } = decodeWav(wav);
  assert.equal(sampleRate, 16000);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].length, x.length);
  for (let i = 0; i < x.length; i++) {
    const want = Math.min(x[i], 32767 / 32768); // int16 tops out just below +1
    assert.ok(Math.abs(channels[0][i] - want) <= 0.5 / 32768 + 1e-9, `sample ${i}`);
  }

  // values on the int16 grid survive exactly; out-of-range values clip, NaN becomes 0
  const grid = Float32Array.from([0, 1 / 32768, -1, -32767 / 32768, 32767 / 32768, 0.5, -0.25]);
  assert.deepEqual(decodeWav(encodeWav(grid, 8000)).channels[0], grid);
  const clipped = decodeWav(encodeWav(Float32Array.from([1, 1.5, -1.5, NaN]), 8000)).channels[0];
  assert.deepEqual([...clipped], [32767 / 32768, 32767 / 32768, -1, 0]);
});

test("encodeWav/decodeWav: 32-bit float is lossless, with a fact chunk", () => {
  const x = noise(1000, 7).map((v) => v * 1.5); // floats may exceed [-1, 1]
  const wav = encodeWav(x, 48000, { bitDepth: 32 });
  const v = new DataView(wav.buffer);
  assert.equal(v.getUint16(20, true), 3); // WAVE_FORMAT_IEEE_FLOAT
  assert.equal(String.fromCharCode(...wav.subarray(36, 40)), "fact");
  const { sampleRate, channels } = decodeWav(wav);
  assert.equal(sampleRate, 48000);
  assert.deepEqual(channels[0], x);
});

test("encodeWav/decodeWav: stereo, 16 and 32 bit", () => {
  const l = noise(777, 3).map((v) => v * 0.9);
  const r = noise(777, 4).map((v) => v * 0.9);
  for (const bitDepth of [16, 32] as const) {
    const { channels } = decodeWav(encodeWav([l, r], 44100, { bitDepth }));
    assert.equal(channels.length, 2);
    const tol = bitDepth === 16 ? 0.5 / 32768 + 1e-9 : 0;
    for (let i = 0; i < l.length; i++) {
      assert.ok(Math.abs(channels[0][i] - l[i]) <= tol);
      assert.ok(Math.abs(channels[1][i] - r[i]) <= tol);
    }
  }
  assert.throws(() => encodeWav([l, r.subarray(1)], 16000), /differ in length/);
});

test("decodeWav: WAVE_FORMAT_EXTENSIBLE 24-bit stereo with LIST (odd size) and fact chunks", () => {
  const frames = [
    [0, -1],
    [0.5, -0.5],
    [8388607 / 8388608, 1 / 8388608],
  ];
  const data = new Uint8Array(frames.length * 6);
  let o = 0;
  for (const fr of frames) {
    for (const x of fr) {
      const s = Math.round(x * 8388608);
      data[o++] = s & 0xff;
      data[o++] = (s >> 8) & 0xff;
      data[o++] = (s >> 16) & 0xff;
    }
  }
  const list = new TextEncoder().encode("INFOISFT\x05\x00\x00\x00abcd\x00"); // 17 bytes: odd, needs a pad byte
  const fact = new Uint8Array([frames.length, 0, 0, 0]);
  const wav = riff([
    ["fmt ", fmtChunk(1, 2, 22050, 24, 1)],
    ["LIST", list],
    ["fact", fact],
    ["data", data],
  ]);
  const { sampleRate, channels } = decodeWav(wav);
  assert.equal(sampleRate, 22050);
  assert.deepEqual([...channels[0]], frames.map((f) => Math.fround(f[0])));
  assert.deepEqual([...channels[1]], frames.map((f) => Math.fround(f[1])));
});

test("decodeWav: 8-bit, 32-bit int, extensible float32, float64", () => {
  const u8 = decodeWav(riff([["fmt ", fmtChunk(1, 1, 8000, 8)], ["data", new Uint8Array([0, 128, 255])]]));
  assert.deepEqual([...u8.channels[0]], [-1, 0, 127 / 128]);

  const i32 = new Int32Array([-2147483648, 0, 1073741824]);
  const d32 = decodeWav(riff([["fmt ", fmtChunk(1, 1, 8000, 32)], ["data", new Uint8Array(i32.buffer)]]));
  assert.deepEqual([...d32.channels[0]], [-1, 0, 0.5]);

  const f32 = Float32Array.from([0.25, -0.75, 1.25]);
  const e32 = decodeWav(riff([["fmt ", fmtChunk(3, 1, 8000, 32, 3)], ["data", new Uint8Array(f32.buffer)]]));
  assert.deepEqual(e32.channels[0], f32);

  const f64 = Float64Array.from([0.1, -0.2, 0.3, -0.4]); // 2 channels x 2 frames
  const d64 = decodeWav(riff([["fmt ", fmtChunk(3, 2, 8000, 64)], ["data", new Uint8Array(f64.buffer)]]));
  assert.deepEqual([...d64.channels[0]], [Math.fround(0.1), Math.fround(0.3)]);
  assert.deepEqual([...d64.channels[1]], [Math.fround(-0.2), Math.fround(-0.4)]);
});

test("decodeWav: overlong data size is cut to the whole frames present; bad input is rejected", () => {
  const pcm = new Int16Array([1000, -1000, 2000, -2000, 3000]);
  const bytes = new Uint8Array(pcm.buffer).subarray(0, 9); // 4.5 samples: the half sample is dropped
  const wav = riff([["fmt ", fmtChunk(1, 1, 16000, 16)], ["data", bytes, 0xffffffff]]);
  // riff() appended a pad byte after the odd body; cut it so the file really ends mid-sample
  const got = decodeWav(wav.subarray(0, wav.length - 1)).channels[0];
  assert.deepEqual([...got], [1000, -1000, 2000, -2000].map((s) => s / 32768));

  // an unaligned view decodes too (with the pad byte the file holds 10 data bytes = 5 samples)
  const shifted = new Uint8Array(wav.length + 3);
  shifted.set(wav, 3);
  assert.equal(decodeWav(shifted.subarray(3)).channels[0].length, 5);

  assert.throws(() => decodeWav(new Uint8Array(64)), /not a WAV file/);
  assert.throws(() => decodeWav(riff([["data", new Uint8Array(4)]])), /no fmt chunk/);
  assert.throws(() => decodeWav(riff([["fmt ", fmtChunk(1, 1, 8000, 16)]])), /no data chunk/);
  assert.throws(
    () => decodeWav(riff([["fmt ", fmtChunk(6, 1, 8000, 8)], ["data", new Uint8Array(4)]])),
    /unsupported WAV encoding \(format 0x6, 8-bit\)/,
  );
});

test("decodeWav matches numpy (wave + int16 / 32768) on clip01.wav", (t) => {
  if (!REFVENV_PYTHON || !existsSync(REFVENV_PYTHON)) {
    t.skip(`reference Python venv not found (set REFVENV_PYTHON to a python with numpy; got ${JSON.stringify(REFVENV_PYTHON)})`);
    return;
  }
  const wavPath = join(FIXTURES, "clip01.wav");
  const dir = mkdtempSync(join(tmpdir(), "cipetpet-wav-"));
  try {
    const out = join(dir, "clip01.f32");
    const script = [
      "import sys, wave, numpy as np",
      "w = wave.open(sys.argv[1], 'rb')",
      "assert w.getsampwidth() == 2",
      "x = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').reshape(-1, w.getnchannels())",
      "(x.astype(np.float64) / 32768.0).astype(np.float32).T.copy().tofile(sys.argv[2])",
      "print(w.getframerate(), w.getnchannels(), w.getnframes())",
    ].join("\n");
    const [rate, nch, frames] = execFileSync(REFVENV_PYTHON, ["-I", "-c", script, wavPath, out], { encoding: "utf8" })
      .trim()
      .split(" ")
      .map(Number);
    const raw = readFileSync(out);
    const ref = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

    const { sampleRate, channels } = decodeWav(readFileSync(wavPath));
    assert.equal(sampleRate, rate);
    assert.equal(channels.length, nch);
    assert.equal(channels[0].length, frames);
    for (let c = 0; c < nch; c++) assert.deepEqual(channels[c], ref.subarray(c * frames, (c + 1) * frames));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decodeWav reads every fixture clip as 16 kHz mono", () => {
  for (let i = 1; i <= 8; i++) {
    const name = `clip0${i}.wav`;
    const { sampleRate, channels } = decodeWav(readFileSync(join(FIXTURES, name)));
    assert.equal(sampleRate, 16000, name);
    assert.equal(channels.length, 1, name);
    assert.ok(channels[0].length > 16000, name);
  }
});

// ------------------------------------------------------------------------------------------- resampler
test("resample: a 1 kHz sine keeps its amplitude within 0.5 % (48k, 44.1k -> 16k; 16k -> 48k)", () => {
  for (const [from, to] of [[48000, 16000], [44100, 16000], [16000, 48000], [22050, 16000], [16000, 44100]]) {
    const x = tone(1000, from, 1, 0.5);
    const y = resample(x, from, to);
    assert.equal(y.length, Math.round((x.length * to) / from));
    const ratio = amplitude(y, 1000, to) / 0.5;
    assert.ok(Math.abs(ratio - 1) < 0.005, `${from} -> ${to}: amplitude ratio ${ratio}`);
  }
});

test("resample: an 11 kHz tone at 48k -> 16k is attenuated by more than 60 dB", () => {
  const x = tone(11000, 48000, 1, 0.5);
  const y = resample(x, 48000, 16000);
  const db = 20 * Math.log10(rmsMiddle(y) / rmsMiddle(x));
  assert.ok(db < -60, `11 kHz leaks through at ${db.toFixed(1)} dB`);
  // also above the output Nyquist at 44.1k -> 16k
  const z = tone(9000, 44100, 1, 0.5);
  const dbz = 20 * Math.log10(rmsMiddle(resample(z, 44100, 16000)) / rmsMiddle(z));
  assert.ok(dbz < -60, `9 kHz at 44.1k -> 16k leaks through at ${dbz.toFixed(1)} dB`);
});

test("resample: lengths, identity, non-integer rates, determinism", () => {
  const x = noise(12345, 9);
  for (const [from, to] of [[48000, 16000], [44100, 16000], [16000, 44100], [32000, 16000], [8000, 16000], [48000, 44100]]) {
    for (const n of [0, 1, 2, 3, 100, 12345]) {
      assert.equal(resample(x.subarray(0, n), from, to).length, Math.round((n * to) / from), `${n} @ ${from} -> ${to}`);
    }
  }
  const same = resample(x, 16000, 16000);
  assert.deepEqual(same, x);
  assert.notEqual(same, x); // a copy, not the input

  // a rate that is not an integer takes the per-sample kernel path; it must agree with an integer
  // rate a hair away
  const t = tone(1000, 48000, 0.5);
  const a = resample(t, 48000.000001, 16000);
  const b = resample(t, 48000, 16000);
  assert.equal(a.length, b.length);
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  assert.ok(maxDiff < 1e-4, `non-integer path differs by ${maxDiff}`);

  assert.deepEqual(resample(t, 48000, 16000), b);
  assert.throws(() => resample(t, 0, 16000), /bad resample rates/);
});

test("toMono averages channels", () => {
  const m = toMono([Float32Array.from([1, 0.5, -1]), Float32Array.from([0, 0.5, 1])]);
  assert.deepEqual([...m], [0.5, 0.5, 0]);
  const one = Float32Array.from([0.1]);
  assert.equal(toMono([one]), one);
});

// ------------------------------------------------------------------------------------------- decodeAudio
test("decodeAudio: WAV Blob / ArrayBuffer / Uint8Array -> mono at the target rate", async () => {
  const l = tone(1000, 44100, 1.5, 0.4);
  const r = tone(1000, 44100, 1.5, 0.2);
  const wav = encodeWav([l, r], 44100, { bitDepth: 32 });

  const fromBlob = await decodeAudio(new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }));
  assert.equal(fromBlob.sampleRate, 16000);
  assert.equal(fromBlob.audio.length, Math.round((l.length * 16000) / 44100));
  assert.equal(fromBlob.duration, fromBlob.audio.length / 16000);
  const amp = amplitude(fromBlob.audio, 1000, 16000);
  assert.ok(Math.abs(amp - 0.3) < 0.0015, `mono amplitude ${amp}`); // the average of 0.4 and 0.2

  const fromBuffer = await decodeAudio(wav.slice().buffer, 16000);
  const fromBytes = await decodeAudio(wav, 16000);
  assert.deepEqual(fromBuffer.audio, fromBlob.audio);
  assert.deepEqual(fromBytes.audio, fromBlob.audio);

  const at48 = await decodeAudio(wav, 48000);
  assert.equal(at48.sampleRate, 48000);
  assert.equal(at48.audio.length, Math.round((l.length * 48000) / 44100));
});

test("decodeAudio: a 16 kHz clip comes back unchanged; non-WAV without Web Audio fails clearly", async () => {
  const bytes = readFileSync(join(FIXTURES, "clip01.wav"));
  const { audio, duration } = await decodeAudio(new Blob([bytes]));
  assert.deepEqual(audio, decodeWav(bytes).channels[0]);
  assert.equal(duration, audio.length / 16000);

  const ogg = new Uint8Array(64);
  ogg.set([0x4f, 0x67, 0x67, 0x53]);
  await assert.rejects(decodeAudio(ogg), /only WAV can be decoded here/);
  await assert.rejects(decodeAudio("nope" as unknown as Uint8Array), /expects a Blob/);
});

// ------------------------------------------------------------------------------------------- browser-only
test("MicRecorder / playAudio / StreamPlayer fail clearly outside a browser", async () => {
  await assert.rejects(MicRecorder.start(), /MicRecorder needs a browser/);
  assert.throws(() => playAudio(new Float32Array(10), 16000), /needs the Web Audio API/);
  assert.throws(() => new StreamPlayer(48000), /needs the Web Audio API/);
});
