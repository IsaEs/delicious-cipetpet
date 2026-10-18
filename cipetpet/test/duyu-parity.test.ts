// Duyu-small fidelity: the TypeScript port against the Python engine (duyu_small, onnxruntime CPU).
//
// test/fixtures/duyu/reference.json and the *.f32 dumps are produced by test/ref/duyu_ref.py:
//   PYTHONPATH=../Duyu-small $REFVENV/bin/python test/ref/duyu_ref.py
//
// What is compared, and how strictly:
//   * front end and decoding logic, exactly: fbank (< 1e-4; measured 0), SentencePiece decode, numpy's
//     top-k / argsort tie order, float32 log_softmax (bit-identical), CTC greedy and forward score, chunk
//     bounds;
//   * "replay" (needs the Python venv): the Python engine records its CTC log-probs and every decoder call
//     (token rows in, last-position logits out); the TS beam search runs on those numbers and must request
//     the same token rows at every step and return the same ids, language and text, for every input,
//     quant and beam mode. Likewise the encoder chain (pass embeddings, gated refinement) is driven with the
//     Python graph outputs and must hand every graph a bit-identical input. This proves the logic
//     identical independently of ORT kernels;
//   * end to end (TS on ORT Web WASM vs Python on ORT CPU): the transcripts are NOT bit-identical to the
//     Python engine's, because the graphs do not give the same numbers on the two runtimes. For int8, ORT
//     CPU at optimisation level EXTENDED+ fuses DynamicQuantizeLinear + MatMulInteger (+ Mul) into fused
//     int8 kernels whose output differs from the unfused graph; ORT Web runs the unfused ops. Even against
//     ORT CPU at level BASIC the single encoder_post graph agrees to ~2e-6 on the same input, but through
//     the whole encoder chain the dynamic int8 quantisation amplifies tiny differences (log-probs differ by
//     up to ~1). For q4, MatMulNBits differs between the CPU and WASM kernels at every level (~0.4).
//     Most transcripts still agree (33 of 40 per quant). The ones that do not are listed in
//     KNOWN_NUMERIC_DIFFS below and reported as TODO with their diff; they are numerics, and the replay above
//     proves the search logic for them. Any case NOT on that list must match exactly, and the number of
//     matching cases must not drop below the recorded one, so a regression in fbank, chunking, the encoder
//     chain or the search still fails the suite.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pack } from "../src/pack/reader.js";
import { decodeWav } from "../src/audio/wav.js";
import { toMono } from "../src/audio/resample.js";
import { Fbank } from "../src/duyu/fbank.js";
import { ctcGreedyIds, ctcNll, logSoftmax, NEG } from "../src/duyu/ctc.js";
import { BeamSearch, numpyArgsort, numpyTopK } from "../src/duyu/beam.js";
import type { Special } from "../src/duyu/beam.js";
import { initRuntime } from "../src/runtime/ort.js";
import { SentencePieceDecoder, pyStrip } from "../src/duyu/tokenizer.js";
import type { PiecesJson } from "../src/duyu/tokenizer.js";
import { chunkBounds } from "../src/duyu/chunks.js";
import { DuyuSmall, runEncoder } from "../src/duyu/index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIX = join(ROOT, "test/fixtures/duyu");
const AUDIO = join(ROOT, "test/fixtures/audio");
const PACKS = { int8: join(ROOT, "packs/duyu-small-int8.cpet"), q4: join(ROOT, "packs/duyu-small-q4.cpet") };
const SR = 16000;
const DUYU_SRC = join(ROOT, "../Duyu-small");
// A python with numpy, onnxruntime and sentencepiece for the replay tests (and to regenerate the fixtures);
// without REFVENV_PYTHON those tests are skipped. With CI set, a skip fails the suite (see the end of the file).
const REFVENV_PYTHON = process.env.REFVENV_PYTHON ?? "";

interface Segment { start: number; end: number; ids: number[]; lang: number | null; text: string }
interface Case { quant: "int8" | "q4"; input: string; mode: string; text: string; segments: Segment[] }
interface Reference {
  versions: Record<string, string>;
  modes: { name: string; mode: "auto" | "ctc"; beam: number; lang: "tr" | "en" | "mix" | null }[];
  inputs: Record<string, number>;
  fbank: Record<string, { file: string; shape: number[] }>;
  fbank_noise_seed: number;
  ctc: Record<string, { file: string; shape: number[]; greedy: number[]; nll: { seq: number[]; nll: number | null }[] }>;
  tokenizer: { ids: number[]; decode: string; text: string }[];
  topk: { seed: number; K: number; V: number; kind: string; top: number[] }[];
  argsort: { seed: number; n: number; mod: number; order: number[] }[];
  logsoftmax: { seed: number; rows: number; cols: number; bits: string };
  cases: Case[];
}

const ref: Reference = JSON.parse(readFileSync(join(FIX, "reference.json"), "utf8"));
const missing = Object.values(PACKS).find((p) => !existsSync(p));
const skipPacks = missing ? `pack ${missing} missing (npx tsx tools/build-packs.ts)` : false;

function readF32(file: string): Float32Array {
  const b = readFileSync(join(FIX, file));
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** the 32-bit LCG of duyu_ref.py */
function* lcg(seed: number): Generator<number> {
  let s = seed >>> 0;
  for (;;) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    yield s;
  }
}
const next = (g: Generator<number>) => g.next().value as number;

function loadClip(name: string): Float32Array {
  const w = decodeWav(new Uint8Array(readFileSync(join(AUDIO, `${name}.wav`))));
  assert.equal(w.sampleRate, SR);
  return toMono(w.channels);
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** the same inputs duyu_ref.py builds */
function inputs(): Map<string, Float32Array> {
  const names = Array.from({ length: 8 }, (_, i) => `clip${String(i + 1).padStart(2, "0")}`);
  const m = new Map<string, Float32Array>();
  for (const n of names) m.set(n, loadClip(n));
  const parts: Float32Array[] = [];
  for (const n of [...names, ...names]) {
    if (parts.length) parts.push(new Float32Array(SR));
    parts.push(m.get(n)!);
  }
  m.set("long", concat(parts));
  m.set("silence", new Float32Array(SR / 2));
  for (const [k, v] of m) assert.equal(v.length, ref.inputs[k], `input ${k} length`);
  return m;
}

const pack = skipPacks ? null : await Pack.fromBytes(new Uint8Array(readFileSync(PACKS.int8)));
const wavs = inputs();

test("fbank matches features.py (max abs diff < 1e-4)", { skip: skipPacks }, async (t) => {
  const fb = new Fbank((await pack!.tensor<Float32Array>("tables/fbank_window")).data, (await pack!.tensor<Float32Array>("tables/fbank_mel")).data);
  const g = lcg(ref.fbank_noise_seed);
  const noise = new Float32Array(700);
  for (let i = 0; i < noise.length; i++) noise[i] = ((next(g) >>> 8) / 2 ** 24 * 2 - 1) * 0.1;
  const sources: Record<string, Float32Array> = { clip01: wavs.get("clip01")!, clip05: wavs.get("clip05")!, noise700: noise, noise300: noise.subarray(0, 300) };
  for (const [name, { file, shape }] of Object.entries(ref.fbank)) {
    const want = readF32(file);
    const got = fb.compute(sources[name]);
    assert.deepEqual([got.frames, 160], shape, `${name} shape`);
    let max = 0;
    for (let i = 0; i < want.length; i++) max = Math.max(max, Math.abs(got.data[i] - want[i]));
    t.diagnostic(`${name}: [${shape}] max abs diff ${max.toExponential(2)}`);
    assert.ok(max < 1e-4, `${name}: max abs diff ${max}`);
  }
});

test("tokenizer decode matches sentencepiece (and decode_ids)", { skip: skipPacks }, async (t) => {
  const tok = new SentencePieceDecoder(await pack!.json<PiecesJson>("tokenizer/pieces.json"));
  const eng = await pack!.json<{ pad: number; bos: number; eos: number; lang: Record<string, number>; style: Record<string, number> }>("model/engine.json");
  const drop = new Set([eng.pad, eng.bos, eng.eos, ...Object.values(eng.lang), ...Object.values(eng.style)]);
  for (const c of ref.tokenizer) {
    assert.equal(tok.decode(c.ids), c.decode, `decode(${JSON.stringify(c.ids)})`);
    assert.equal(pyStrip(tok.decode(c.ids.filter((i) => !drop.has(i)))), c.text, `decode_ids(${JSON.stringify(c.ids)})`);
  }
  t.diagnostic(`${ref.tokenizer.length} id sequences`);
});

/** duyu_ref.py gen_cand */
function genCand(seed: number, K: number, V: number, kind: string): Float64Array {
  const g = lcg(seed);
  const n = K * V;
  const out = new Float64Array(n);
  if (kind.startsWith("step")) {
    const scores = new Float64Array(K).fill(NEG);
    scores[0] = 0;
    if (kind === "step1") {
      const alive = K > 3 ? 3 : 1;
      for (let k = 0; k < alive; k++) scores[k] = (-(next(g) >>> 8) / 2 ** 24) * 3;
    }
    const logp = new Float32Array(n);
    for (let i = 0; i < n; i++) logp[i] = (-(next(g) >>> 8) / 2 ** 24) * 20;
    const keep = new Float64Array(V).fill(NEG);
    for (const id of kind === "step0auto" ? [4, 5, 6] : [6]) keep[id] = 0;
    for (let k = 0; k < K; k++) {
      for (let v = 0; v < V; v++) {
        const lp = kind === "step1" ? (v === 7 ? 0 : Math.fround(NEG)) : logp[k * V + v] + keep[v];
        out[k * V + v] = scores[k] + lp;
      }
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const s = next(g);
    if (kind === "ties") out[i] = -(s % 7);
    else if (kind === "few") out[i] = -(s % 3) * 0.5;
    else if (kind === "neg") out[i] = s % 10 ? NEG : -(s % 1000) / 8;
    else if (kind === "mixed") out[i] = [NEG, 2 * NEG, -(s >>> 8) / 2 ** 24, -1.0][s % 4];
    else throw new Error(kind);
  }
  return out;
}

test("numpyTopK reproduces np.argpartition + np.argsort, ties included", () => {
  for (const c of ref.topk) {
    const got = [...numpyTopK(genCand(c.seed, c.K, c.V, c.kind), c.K)];
    assert.deepEqual(got, c.top, `seed ${c.seed} K ${c.K} V ${c.V} ${c.kind}`);
  }
  for (const c of ref.argsort) {
    const g = lcg(c.seed);
    const v = Array.from({ length: c.n }, () => -(next(g) % c.mod));
    assert.deepEqual([...numpyArgsort(v)], c.order, `argsort n ${c.n} mod ${c.mod}`);
  }
});

test("logSoftmax reproduces numpy's float32 log_softmax", (t) => {
  const { seed, rows, cols, bits } = ref.logsoftmax;
  const g = lcg(seed);
  const x = new Float32Array(rows * cols);
  for (let i = 0; i < x.length; i++) x[i] = ((next(g) >>> 8) / 2 ** 24) * 30 - 15;
  const b = Buffer.from(bits, "base64");
  const want = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const got = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) logSoftmax(x, r * cols, cols, got, r * cols);
  let exact = 0;
  let max = 0;
  for (let i = 0; i < want.length; i++) {
    if (Object.is(got[i], want[i])) exact++;
    max = Math.max(max, Math.abs(got[i] - want[i]));
  }
  t.diagnostic(`${exact}/${want.length} bit-identical, max abs diff ${max}`);
  assert.equal(exact, want.length);
});

test("CTC greedy and CTC forward score on the Python log-probs", () => {
  for (const [name, c] of Object.entries(ref.ctc)) {
    const logp = readF32(c.file);
    const [T, V] = c.shape;
    assert.deepEqual(ctcGreedyIds(logp, T, V, 0), c.greedy, `${name} greedy`);
    for (const { seq, nll } of c.nll) {
      const got = ctcNll(logp, T, V, seq, 0);
      if (nll === null) assert.equal(got, Infinity, `${name} nll of ${seq.length} tokens should be +inf`);
      else if (seq.length === 0) assert.equal(got, nll, `${name} empty-sequence nll (float32 sum) must be exact`);
      else assert.ok(Math.abs(got - nll) <= 1e-12 * Math.abs(nll), `${name} nll ${got} vs ${nll}`);
    }
  }
});

test("chunk bounds match audio.chunks", () => {
  for (const name of wavs.keys()) {
    const want = ref.cases.find((c) => c.input === name)!.segments.map((s) => [s.start, s.end]);
    assert.deepEqual(chunkBounds(wavs.get(name)!), want, name);
  }
  assert.equal(chunkBounds(wavs.get("long")!).length, 3);
});

const tally = { int8: { same: 0, diff: [] as string[] }, q4: { same: 0, diff: [] as string[] } };

/** Transcripts that differ from the Python engine through ORT kernel numerics only (measured; see the header). */
const KNOWN_NUMERIC_DIFFS: Record<"int8" | "q4", ReadonlySet<string>> = {
  int8: new Set(["clip02 beam1-tr", "clip05 beam5-auto", "clip05 ctc", "clip07 beam1-tr", "long beam5-mix", "long beam5-auto", "long ctc"]),
  q4: new Set(["clip05 beam5-mix", "clip05 beam5-auto", "clip05 beam1-tr", "clip06 beam1-tr", "clip07 beam5-mix", "long beam1-tr", "long ctc"]),
};
/** how many of the 40 transcripts per quant match the Python engine exactly (the rest is KNOWN_NUMERIC_DIFFS) */
const MIN_IDENTICAL = 33;

for (const quant of ["int8", "q4"] as const) {
  describe(`DuyuSmall ${quant} vs the Python engine`, { skip: skipPacks }, () => {
    let model: DuyuSmall;
    before(async () => {
      model = await DuyuSmall.load(new Uint8Array(readFileSync(PACKS[quant])));
    });
    after(async () => {
      await model?.dispose();
      const { same, diff } = tally[quant];
      console.log(`# ${quant} end to end: ${same}/${same + diff.length} transcripts identical to the Python engine${diff.length ? `; numerics-only differences: ${diff.join(", ")}` : ""}`);
    });

    if (quant === "int8") {
      test("CTC log-probs (encoder output) close to onnxruntime CPU", async (t) => {
        for (const [name, c] of Object.entries(ref.ctc)) {
          const wav = wavs.get(name)!;
          const x = new Float32Array(wav.length + 0.4 * SR);
          x.set(wav);
          const enc = await model.encode(x);
          assert.deepEqual([enc.frames, enc.vocab], c.shape);
          const want = readF32(c.file);
          const [T, V] = c.shape;
          let max = 0;
          let sum = 0;
          let argmaxSame = 0;
          for (let i = 0; i < want.length; i++) {
            const d = Math.abs(enc.logp[i] - want[i]);
            sum += d;
            if (d > max) max = d;
          }
          for (let f = 0; f < T; f++) {
            let a = 0;
            let b = 0;
            for (let v = 1; v < V; v++) {
              if (enc.logp[f * V + v] > enc.logp[f * V + a]) a = v;
              if (want[f * V + v] > want[f * V + b]) b = v;
            }
            if (a === b) argmaxSame++;
          }
          const mean = sum / want.length;
          t.diagnostic(`${name}: [${c.shape}] max abs diff ${max.toExponential(2)}, mean ${mean.toExponential(2)}, frame argmax equal ${argmaxSame}/${T}`);
          // ORT CPU's fused int8 kernels vs ORT Web's unfused ones (see the header): loose sanity bounds only
          assert.ok(argmaxSame >= 0.9 * T, `${name}: frame argmax differs from the Python engine in ${T - argmaxSame} of ${T} frames`);
        }
      });
    }

    const modes = new Map(ref.modes.map((m) => [m.name, m]));
    for (const c of ref.cases.filter((k) => k.quant === quant)) {
      test(`${c.input} ${c.mode}`, async (t) => {
        const m = modes.get(c.mode)!;
        const r = await model.transcribe(wavs.get(c.input)!, { mode: m.mode, beam: m.beam, lang: m.lang ?? "auto" });
        // chunking happens before any graph runs: always exact
        assert.deepEqual(r.segments.map((s) => [Math.round(s.start * SR), Math.round(s.end * SR)]), c.segments.map((s) => [s.start, s.end]));
        assert.equal(r.stats.mode, m.mode === "ctc" ? "ctc" : "attn");
        assert.equal(r.stats.chunks, c.segments.length);
        const names: Record<number, string> = { 4: "tr", 5: "en", 6: "mix" };
        const same =
          r.text === c.text &&
          r.segments.every((s, i) => s.text === c.segments[i].text && s.tokens.join() === c.segments[i].ids.join()) &&
          (c.segments[0].lang === null || r.lang === names[c.segments[0].lang]);
        if (same) {
          tally[quant].same++;
          return;
        }
        const key = `${c.input} ${c.mode}`;
        tally[quant].diff.push(key);
        const lines: string[] = [];
        for (const [i, s] of r.segments.entries()) {
          if (s.tokens.join() !== c.segments[i].ids.join()) lines.push(`chunk ${i}: TS ${JSON.stringify(s.text)} vs Python ${JSON.stringify(c.segments[i].text)}`);
        }
        if (!KNOWN_NUMERIC_DIFFS[quant].has(key)) {
          assert.fail(`${quant} ${key} differs from the Python engine and is not a known numerics-only case:\n${lines.join("\n")}\nTS text: ${JSON.stringify(r.text)}\nPython text: ${JSON.stringify(c.text)}`);
        }
        for (const line of lines) t.diagnostic(line);
        t.todo("differs from the Python engine through ORT kernel numerics (ORT CPU fused int8 / MatMulNBits vs ORT Web); the replay test covers this case's logic");
      });
    }

    // runs after the 40 cases above (tests of one suite run in order)
    test("at least as many transcripts match the Python engine as were recorded", () => {
      const { same, diff } = tally[quant];
      assert.ok(same >= MIN_IDENTICAL, `only ${same} of ${same + diff.length} transcripts match the Python engine (recorded: at least ${MIN_IDENTICAL}); differing: ${diff.join(", ")}`);
    });
  });
}

// ------------------------------------------------------------------------------------------------ replay

interface ReplayStep { K: number; L: number; tokens: number; logits: number }
interface ReplayIndex {
  chunks: { start: number; end: number; T: number; V: number; logp: number }[];
  modes: Record<string, { beam: number; lang: string | null; chunks: { ids: number[]; lang: number; text: string; steps: ReplayStep[] }[] }>;
}

const noVenv = !REFVENV_PYTHON || !existsSync(REFVENV_PYTHON) ? `reference Python venv not found (set REFVENV_PYTHON to a python with numpy, onnxruntime, sentencepiece; got ${JSON.stringify(REFVENV_PYTHON)})` : !existsSync(DUYU_SRC) ? `${DUYU_SRC} missing` : false;
const noUpstream = !existsSync(join(ROOT, ".upstream/duyu-small/engine.json")) ? ".upstream/duyu-small missing" : false;

describe("replay: the TS search on the Python engine's numbers", { skip: skipPacks || noVenv || noUpstream }, () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cipetpet-duyu-replay-"));
    execFileSync(REFVENV_PYTHON, [join(ROOT, "test/ref/duyu_ref.py"), "--replay", dir], {
      env: { ...process.env, PYTHONPATH: DUYU_SRC },
      cwd: dir,
      stdio: ["ignore", "ignore", "inherit"],
    });
  });
  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const load = (base: string) => {
    const index = JSON.parse(readFileSync(join(dir, `${base}.json`), "utf8"));
    const b = readFileSync(join(dir, `${base}.bin`));
    const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    return { index, f32: new Float32Array(buf), i32: new Int32Array(buf) };
  };

  for (const quant of ["int8", "q4"] as const) {
    test(`${quant}: every input and mode`, async (t) => {
      const eng = await pack!.json<Special & { max_positions: number; vocab_size: number }>("model/engine.json");
      const tok = new SentencePieceDecoder(await pack!.json<PiecesJson>("tokenizer/pieces.json"));
      const drop = new Set([eng.pad, eng.bos, eng.eos, ...Object.values(eng.lang), ...Object.values(eng.style)]);
      const decodeIds = (ids: number[]) => pyStrip(tok.decode(ids.filter((i) => !drop.has(i))));
      let searches = 0;
      let steps = 0;
      for (const input of wavs.keys()) {
        const { index, f32, i32 } = load(`${quant}-${input}`) as { index: ReplayIndex; f32: Float32Array; i32: Int32Array };
        assert.deepEqual(index.chunks.map((c) => [c.start, c.end]), chunkBounds(wavs.get(input)!), `${input} chunks`);
        // CTC mode: greedy over the same log-probs, compared with the transcript in reference.json
        const ctcCase = ref.cases.find((c) => c.quant === quant && c.input === input && c.mode === "ctc")!;
        index.chunks.forEach((c, i) => {
          const logp = f32.subarray(c.logp, c.logp + c.T * c.V);
          assert.deepEqual(ctcGreedyIds(logp, c.T, c.V, eng.pad), ctcCase.segments[i].ids, `${input} ctc chunk ${i}`);
        });
        for (const [mode, m] of Object.entries(index.modes)) {
          for (const [i, want] of m.chunks.entries()) {
            const c = index.chunks[i];
            let step = 0;
            const search = new BeamSearch(
              async (tokens, K, L) => {
                const s = want.steps[step++];
                assert.ok(s, `${input} ${mode} chunk ${i}: more decoder calls than Python (${want.steps.length})`);
                assert.deepEqual([K, L], [s.K, s.L], `${input} ${mode} chunk ${i} step ${step - 1}: batch shape`);
                const rows = Array.from(tokens, Number);
                assert.deepEqual(rows, Array.from(i32.subarray(s.tokens, s.tokens + K * L)), `${input} ${mode} chunk ${i} step ${step - 1}: token rows`);
                return f32.slice(s.logits, s.logits + K * eng.vocab_size);
              },
              eng,
              eng.max_positions,
              eng.vocab_size,
            );
            const r = await search.search(f32.subarray(c.logp, c.logp + c.T * c.V), c.T, { beam: m.beam, lang: m.lang });
            assert.equal(step, want.steps.length, `${input} ${mode} chunk ${i}: decoder calls`);
            assert.deepEqual(r.ids, want.ids, `${input} ${mode} chunk ${i}: ids`);
            assert.equal(r.lang, want.lang, `${input} ${mode} chunk ${i}: language`);
            assert.equal(decodeIds(r.ids), want.text, `${input} ${mode} chunk ${i}: text`);
            searches++;
            steps += step;
          }
        }
      }
      t.diagnostic(`${searches} searches, ${steps} decoder steps replayed with identical token rows and results`);
    });

    test(`${quant}: encoder chain (pass embeddings, gates) on the Python graph outputs`, async () => {
      const qpack = await Pack.fromBytes(new Uint8Array(readFileSync(PACKS[quant])));
      const gates = (await qpack.tensor<Float32Array>("tables/pass_gates")).data;
      const embed = (await qpack.tensor<Float32Array>("tables/pass_embed")).data;
      for (const name of ["clip01", "clip05"]) {
        type Call = { graph: string; in: number; inShape: number[]; out: number; outShape: number[] };
        const { index, f32 } = load(`${quant}-encoder-${name}`) as {
          index: { calls: Call[]; h: number; hShape: number[]; logp: number; logpShape: number[] };
          f32: Float32Array;
        };
        const size = (shape: number[]) => shape.reduce((a, b) => a * b, 1);
        const first = index.calls[0];
        const feats = { data: f32.slice(first.in, first.in + size(first.inShape)), frames: first.inShape[1] };
        let i = 0;
        const enc = await runEncoder(feats, gates, embed, async (graph, data, dims) => {
          const c = index.calls[i++];
          assert.equal(graph, c.graph, `${name} call ${i - 1}`);
          assert.deepEqual(dims, c.inShape, `${name} call ${i - 1} (${graph}) input shape`);
          // bit-identical graph inputs: the float32 elementwise math matches numpy's
          assert.ok(
            Buffer.from(data.buffer, data.byteOffset, data.byteLength).equals(Buffer.from(f32.buffer, c.in * 4, data.byteLength)),
            `${name} call ${i - 1} (${graph}): input differs from the Python engine's`,
          );
          return { data: f32.slice(c.out, c.out + size(c.outShape)), dims: c.outShape };
        });
        assert.equal(i, index.calls.length);
        assert.ok(enc);
        assert.deepEqual(enc.h, f32.subarray(index.h, index.h + size(index.hShape)));
        assert.deepEqual(enc.logp, f32.subarray(index.logp, index.logp + size(index.logpShape)));
      }
    });

    test(`${quant}: encoder_post on ORT Web vs ORT CPU at optimisation levels BASIC and ALL`, async (t) => {
      const qpack = await Pack.fromBytes(new Uint8Array(readFileSync(PACKS[quant])));
      const { index, f32 } = load(`${quant}-post`) as { index: { shape: number[]; outShape: number[]; x: number; BASIC: number; ALL: number }; f32: Float32Array };
      const rt = await initRuntime({});
      const session = await rt.createSession(await qpack.bytes("graphs/encoder_post.onnx"), "encoder_post");
      try {
        const n = index.shape.reduce((a, b) => a * b, 1);
        const out = await session.run({ x: new rt.ort.Tensor("float32", f32.slice(index.x, index.x + n), index.shape) });
        const got = out.log_probs.data as Float32Array;
        const m = index.outShape.reduce((a, b) => a * b, 1);
        const diff = (off: number) => {
          let max = 0;
          for (let i = 0; i < m; i++) max = Math.max(max, Math.abs(got[i] - f32[off + i]));
          return max;
        };
        const basic = diff(index.BASIC);
        const all = diff(index.ALL);
        t.diagnostic(`max abs diff vs ORT CPU: BASIC ${basic.toExponential(2)}, ALL ${all.toExponential(2)}`);
        // int8: the WASM build runs the same unfused ops as ORT CPU at BASIC
        if (quant === "int8") assert.ok(basic < 1e-4, `int8 encoder_post vs ORT CPU BASIC: ${basic}`);
      } finally {
        await session.release();
      }
    });
  }
});

// With CI set, a missing pack, venv or upstream folder must not turn the fidelity tests into silent skips.
// (Set CIPETPET_ALLOW_PARITY_SKIP=1 to run without them on purpose.)
const hidden = skipPacks || noVenv || noUpstream;
if (hidden && process.env.CI && process.env.CIPETPET_ALLOW_PARITY_SKIP !== "1") {
  test("CI: the Duyu parity tests must not be skipped", () => {
    assert.fail(`the end-to-end and replay parity tests would be skipped: ${hidden}. Build the packs (npm run packs), fill .upstream, set REFVENV_PYTHON.`);
  });
}
