// Runs tools/build-packs.ts on the real upstream files and checks the packs against the sources and
// against the Python reference (numpy + sentencepiece) for the parts the builder converts.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Pack } from "../src/pack/reader.js";
import { ANTALIA_VARIANTS } from "../tools/build-packs.js";
import { readNpy, readNpz } from "../tools/lib/npz.js";
import { parseSpm } from "../tools/lib/spm.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UP = join(ROOT, ".upstream");
const OUT = join(ROOT, ".test-out");
const PY = "/private/tmp/claude-501/-Users-gralwolf-VsCodeProjects-delicious-cipetpet/d113f043-f962-4e9c-b398-1221302c5e22/scratchpad/refvenv/bin/python";
const REFVENV_PY = process.env.REFVENV ? join(process.env.REFVENV, "bin/python") : PY;

const haveUpstream = existsSync(join(UP, "antalia-mini/models/manifest.json")) && existsSync(join(UP, "duyu-small/spm.model"));
const noUpstream = haveUpstream ? false : `.upstream model files missing in ${UP}`;
const noPython = existsSync(REFVENV_PY) ? noUpstream : `Python reference venv not found at ${REFVENV_PY} (set REFVENV)`;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const file = (p: string) => new Uint8Array(readFileSync(p));

function build(out: string, ...args: string[]): string {
  rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "tools/build-packs.ts"), "--out", out, ...args], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `build-packs failed:\n${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

function python(script: string): string {
  return execFileSync(REFVENV_PY, ["-I", "-c", script], { encoding: "utf8", maxBuffer: 64 << 20 });
}

const ONLY = ["--only", "antalia-mini-mixed,duyu-small-int8"];

test("build-packs: antalia-mini-mixed and duyu-small-int8 match their sources", { skip: noUpstream }, async () => {
  const out = join(OUT, "packs");
  const stdout = build(out, ...ONLY);
  assert.match(stdout, /antalia-mini-mixed\s+.*MiB\s+6\s+[0-9a-f]{64}/);
  assert.match(stdout, /duyu-small-int8\s+.*MiB\s+11\s+[0-9a-f]{64}/);
  const ortVersion = JSON.parse(readFileSync(join(ROOT, "node_modules/onnxruntime-web/package.json"), "utf8")).version;

  // ---- antalia
  const a = await Pack.fromBytes(file(join(out, "antalia-mini-mixed.cpet")));
  const manifest = JSON.parse(readFileSync(join(UP, "antalia-mini/models/manifest.json"), "utf8"));
  assert.deepEqual(a.model, {
    id: "antalia-mini", name: "Antalia-2 Mini", version: manifest.version, task: "text-to-speech", variant: "mixed",
    license: "Apache-2.0", source: "https://huggingface.co/spaces/cloud0day3/antalia-mini", languages: ["tr"],
  });
  assert.deepEqual(a.meta, { sampleRate: 48000, precision: ANTALIA_VARIANTS.mixed });
  assert.deepEqual(a.header.runtime, { onnxruntime: ortVersion });
  assert.deepEqual(a.list().map((e) => e.name), ["graphs/text.onnx", "graphs/cond.onnx", "graphs/flow.onnx", "graphs/vocoder.onnx", "frontend/data.json", "model/manifest.json"]);
  for (const e of a.list()) await a.bytes(e.name); // verifies every hash
  for (const [g, suffix] of Object.entries(ANTALIA_VARIANTS.mixed)) {
    const e = a.entry(`graphs/${g}.onnx`);
    assert.equal(e.type, "onnx");
    assert.equal(e.encoding, "raw");
    assert.equal(e.sha256, sha(file(join(UP, `antalia-mini/models/${g}${suffix}.onnx`))), `${g}${suffix}.onnx`);
  }
  const fe = a.entry("frontend/data.json");
  assert.equal(fe.encoding, "gzip");
  assert.equal(fe.type, "json");
  const feBytes = await a.bytes("frontend/data.json");
  assert.deepEqual(feBytes, new Uint8Array(gunzipSync(readFileSync(join(UP, "antalia-mini/assets/frontend-data.json.gz")))));
  assert.equal((await a.json<{ format: number }>("frontend/data.json")).format, 1);
  assert.deepEqual(await a.json("model/manifest.json"), manifest);

  // ---- duyu
  const d = await Pack.fromBytes(file(join(out, "duyu-small-int8.cpet")));
  assert.deepEqual(d.model, {
    id: "duyu-small", name: "Duyu-small", version: "1.0.0", task: "speech-recognition", variant: "int8",
    license: "Apache-2.0", source: "https://huggingface.co/KaanAydinli/Duyu-small", languages: ["tr", "en"],
  });
  assert.deepEqual(d.meta, { sampleRate: 16000 });
  assert.equal(d.header.runtime?.onnxruntime, ortVersion);
  for (const e of d.list()) await d.bytes(e.name);
  for (const g of ["encoder_pre", "encoder_pass", "encoder_post", "decoder"]) {
    assert.equal(d.entry(`graphs/${g}.onnx`).sha256, sha(file(join(UP, `duyu-small/int8/${g}.onnx`))), g);
  }
  const shapes: Record<string, number[]> = { fbank_window: [400], fbank_mel: [257, 80], pass_gates: [3], pass_embed: [3, 256] };
  for (const [name, shape] of Object.entries(shapes)) {
    const t = await d.tensor<Float32Array>(`tables/${name}`);
    assert.equal(t.dtype, "float32");
    assert.deepEqual(t.shape, shape, name);
    assert.ok(t.data instanceof Float32Array && t.data.length === shape.reduce((x, y) => x * y, 1));
  }
  assert.deepEqual(await d.bytes("model/engine.json"), file(join(UP, "duyu-small/engine.json")));
  assert.deepEqual(await d.bytes("model/config.json"), file(join(UP, "duyu-small/config.json")));
  const { pieces } = await d.json<{ pieces: [string, number][] }>("tokenizer/pieces.json");
  assert.equal(pieces.length, 2048);
  assert.deepEqual(pieces.slice(0, 10).map((p) => p[0]), ["<pad>", "<unk>", "<s>", "</s>", "<tr>", "<en>", "<mix>", "<cased>", "<plain>", "<0x00>"]);
  assert.deepEqual(pieces[9 + 255], ["<0xFF>", 6]);
});

test("build-packs: output is byte-identical across builds", { skip: noUpstream }, () => {
  const a = join(OUT, "packs-det-a"), b = join(OUT, "packs-det-b");
  build(a, ...ONLY);
  build(b, ...ONLY);
  for (const name of ["antalia-mini-mixed.cpet", "duyu-small-int8.cpet"]) {
    assert.equal(sha(file(join(a, name))), sha(file(join(b, name))), name);
    // also identical to the main test's build, when that ran first
    if (existsSync(join(OUT, "packs", name))) assert.equal(sha(file(join(a, name))), sha(file(join(OUT, "packs", name))), name);
  }
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test("build-packs: --embed-runtime adds the ORT wasm binary", { skip: noUpstream }, async () => {
  const out = join(OUT, "packs-rt");
  build(out, "--only", "duyu-small-q4", "--embed-runtime");
  const p = await Pack.fromBytes(file(join(out, "duyu-small-q4.cpet")));
  const e = p.entry("runtime/ort-wasm-simd-threaded.wasm");
  assert.equal(e.type, "wasm");
  assert.equal(e.encoding, "raw");
  assert.equal(e.sha256, sha(file(join(ROOT, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"))));
  for (const g of ["encoder_pre", "encoder_pass", "encoder_post", "decoder"])
    assert.equal(p.entry(`graphs/${g}.onnx`).sha256, sha(file(join(UP, `duyu-small/q4/${g}.onnx`))), g);
  await p.bytes(e.name);
  rmSync(out, { recursive: true, force: true });
});

test("build-packs: unknown --only names fail with a list of the available packs", { skip: noUpstream }, () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "tools/build-packs.ts"), "--out", join(OUT, "packs-bad"), "--only", "nope"], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown pack\(s\): nope \(available: antalia-mini-mixed, .*duyu-small-int8/);
});

test("spm.model parse matches sentencepiece (Python reference)", { skip: noPython }, () => {
  const ref = JSON.parse(python(`
import json, sentencepiece as spm
p = spm.SentencePieceProcessor(model_file=${JSON.stringify(join(UP, "duyu-small/spm.model"))})
print(json.dumps([[p.id_to_piece(i), p.get_score(i), p.is_byte(i), p.is_control(i), p.is_unknown(i), p.is_unused(i)]
                  for i in range(p.get_piece_size())]))
`)) as [string, number, boolean, boolean, boolean, boolean][];
  const pieces = parseSpm(file(join(UP, "duyu-small/spm.model")));
  assert.equal(pieces.length, ref.length);
  let bytes = 0;
  ref.forEach(([piece, score, isByte, isControl, isUnknown, isUnused], id) => {
    const p = pieces[id];
    assert.equal(p.piece, piece, `piece ${id}`);
    assert.equal(p.score, Math.fround(score), `score ${id}`);
    assert.equal(p.type === 6, isByte, `is_byte ${id} (${piece})`);
    assert.equal(p.type === 3, isControl, `is_control ${id} (${piece})`);
    assert.equal(p.type === 2, isUnknown, `is_unknown ${id} (${piece})`);
    assert.equal(p.type === 5, isUnused, `is_unused ${id} (${piece})`);
    if (isByte) bytes++;
  });
  assert.equal(bytes, 256);
});

test("npz tables match numpy (Python reference)", { skip: noPython }, () => {
  const ref = JSON.parse(python(`
import json, hashlib, numpy as np
out = {}
for f in ("fbank", "passes"):
    z = np.load(${JSON.stringify(join(UP, "duyu-small"))} + "/" + f + ".npz")
    for k in z.files:
        a = np.ascontiguousarray(z[k], dtype="<f4")
        out[f + "/" + k] = [list(a.shape), hashlib.sha256(a.tobytes()).hexdigest()]
print(json.dumps(out))
`)) as Record<string, [number[], string]>;
  for (const f of ["fbank", "passes"]) {
    const z = readNpz(file(join(UP, `duyu-small/${f}.npz`)));
    for (const [k, a] of z) {
      const [shape, hash] = ref[`${f}/${k}`];
      assert.deepEqual(a.shape, shape, `${f}/${k}`);
      assert.equal(sha(new Uint8Array(a.data.buffer)), hash, `${f}/${k}`);
    }
    assert.equal(z.size, Object.keys(ref).filter((k) => k.startsWith(f + "/")).length);
  }
});

test("npz / npy reader: deflated archives, float64 / float16 and header versions 1-3", { skip: noPython }, () => {
  const dir = join(OUT, "npz");
  mkdirSync(dir, { recursive: true });
  const ref = JSON.parse(python(`
import json, numpy as np
d = ${JSON.stringify(dir)}
a = (np.arange(6, dtype=np.float32).reshape(2, 3) / 7).astype(np.float32)
b = np.array([1e-3, -2.5, 1e10, 0.1], dtype=np.float64)
c = np.array([0.5, -1.25, 65504, 6e-8], dtype=np.float16)
np.savez_compressed(d + "/c.npz", a=a, b=b, c=c)
for v in (1, 2, 3):
    with open(d + f"/v{v}.npy", "wb") as f:
        np.lib.format.write_array(f, a, version=(v, 0))
print(json.dumps({k: [list(x.shape), x.astype(np.float32).ravel().tolist()] for k, x in dict(a=a, b=b, c=c).items()}))
`)) as Record<string, [number[], number[]]>;
  const z = readNpz(file(join(dir, "c.npz")));
  for (const [k, [shape, values]] of Object.entries(ref)) {
    const a = z.get(k)!;
    assert.deepEqual(a.shape, shape, k);
    assert.deepEqual([...a.data], values, k);
  }
  assert.equal(z.get("b")!.descr, "<f8");
  assert.equal(z.get("c")!.descr, "<f2");
  for (const v of [1, 2, 3]) {
    const a = readNpy(file(join(dir, `v${v}.npy`)));
    assert.deepEqual(a.shape, [2, 3]);
    assert.deepEqual([...a.data], ref.a[1], `v${v}`);
  }
  rmSync(dir, { recursive: true, force: true });
});
