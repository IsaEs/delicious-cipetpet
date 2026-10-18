// ONNX Runtime setup (src/runtime/ort.ts) and the small shared helpers in src/util.
//
// ORT's env is global to a process, so the wasmBinary scenarios run in fresh child processes: this file
// re-runs itself with CIPETPET_RUNTIME_CHILD=<scenario> and reads one JSON line back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { initRuntime, PACK_WASM_ENTRY } from "../src/runtime/ort.js";
import type { Runtime } from "../src/runtime/ort.js";
import type { Pack } from "../src/pack/reader.js";
import { SerialQueue } from "../src/util/queue.js";
import { isAbortError, throwIfAborted } from "../src/util/abort.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GRAPH = join(ROOT, ".upstream/duyu-small/int8/encoder_pre.onnx");
const ORT_WASM = join(ROOT, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm");
const SELF = fileURLToPath(import.meta.url);
const REFVENV_PYTHON =
  process.env.REFVENV_PYTHON ??
  "/private/tmp/claude-501/-Users-gralwolf-VsCodeProjects-delicious-cipetpet/d113f043-f962-4e9c-b398-1221302c5e22/scratchpad/refvenv/bin/python";

const FRAMES = 100;

/** deterministic fbank-like input for encoder_pre: [1, FRAMES, 160] */
function feats(): Float32Array {
  const x = new Float32Array(FRAMES * 160);
  let s = 12345;
  for (let i = 0; i < x.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    x[i] = (s / 2 ** 32) * 4 - 2;
  }
  return x;
}

async function runEncoderPre(rt: Runtime): Promise<{ dims: readonly number[]; data: Float32Array }> {
  const session = await rt.createSession(new Uint8Array(readFileSync(GRAPH)), "encoder_pre");
  try {
    const out = await session.run({ feats: new rt.ort.Tensor("float32", feats(), [1, FRAMES, 160]) });
    return { dims: out.x.dims, data: out.x.data as Float32Array };
  } finally {
    await session.release();
  }
}

/** the minimal Pack surface initRuntime uses (has / bytes / header.runtime) */
function fakePack(version: string | undefined, wasm: Uint8Array | null): Pack {
  return {
    header: { runtime: version ? { onnxruntime: version } : {} },
    has: (name: string) => name === PACK_WASM_ENTRY && wasm !== null,
    bytes: async (name: string) => {
      if (name !== PACK_WASM_ENTRY || !wasm) throw new Error(`no entry ${name}`);
      // a view into a larger buffer, like a raw entry of a real pack
      const big = new Uint8Array(wasm.length + 128);
      big.set(wasm, 64);
      return big.subarray(64, 64 + wasm.length);
    },
  } as unknown as Pack;
}

// ------------------------------------------------------------------------------------------- child side
const scenario = process.env.CIPETPET_RUNTIME_CHILD;
if (scenario) {
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
  const result: Record<string, unknown> = { scenario };
  try {
    const wasm = new Uint8Array(readFileSync(ORT_WASM));
    let rt: Runtime;
    if (scenario === "explicit") rt = await initRuntime({ wasmBinary: wasm });
    else if (scenario === "pack") rt = await initRuntime({}, fakePack("1.30.0", wasm));
    else if (scenario === "pack-mismatch") rt = await initRuntime({}, fakePack("1.29.0", wasm));
    else if (scenario === "pack-corrupt") {
      // right version, wrong bytes: if ORT really uses the pack's binary, session creation must fail
      const junk = new Uint8Array(4096);
      junk.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff]);
      rt = await initRuntime({}, fakePack("1.30.0", junk));
    } else if (scenario === "threads") rt = await initRuntime({ threads: 2 });
    else if (scenario === "threads-node-build") rt = await initRuntime({ threads: 2, ort: await import("onnxruntime-web") });
    else throw new Error(`unknown scenario ${scenario}`);
    const bin = rt.ort.env.wasm.wasmBinary as Uint8Array | undefined;
    result.threads = rt.threads;
    result.wasmBinaryBytes = bin ? bin.byteLength : null;
    result.wasmBinaryTight = bin ? bin.byteOffset === 0 && bin.byteLength === bin.buffer.byteLength : null;
    try {
      const out = await runEncoderPre(rt);
      result.dims = [...out.dims];
      result.finite = out.data.every(Number.isFinite);
    } catch (e) {
      result.sessionError = (e as Error).message;
    }
  } catch (e) {
    result.error = (e as Error).stack;
  }
  result.warnings = warnings;
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  process.exit(0); // ORT's worker threads (threads scenario) would keep the process alive
}

function child(name: string): Record<string, unknown> {
  const r = spawnSync(process.execPath, ["--import", "tsx", SELF], {
    cwd: ROOT,
    env: { ...process.env, CIPETPET_RUNTIME_CHILD: name },
    encoding: "utf8",
    timeout: 120_000,
  });
  const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `child "${name}" printed no result (status ${r.status}):\n${r.stdout}\n${r.stderr}`);
  const res = JSON.parse(line.slice(7));
  assert.equal(res.error, undefined, res.error);
  return res;
}

// ------------------------------------------------------------------------------------------- tests
if (!scenario) {
  test("initRuntime: wasm defaults, and an int8 Duyu graph loads and runs", async () => {
    const rt = await initRuntime();
    assert.equal(rt.backend, "wasm");
    // Node has no crossOriginIsolated, so the default is one thread
    assert.equal(rt.crossOriginIsolated, false);
    assert.equal(rt.threads, 1);
    assert.equal(rt.ort.env.wasm.numThreads, 1);
    assert.equal(rt.ort.env.logLevel, "error");
    assert.equal(rt.version, "1.30.0");
    const { dims, data } = await runEncoderPre(rt);
    assert.deepEqual([...dims], [1, FRAMES / 2, 256]);
    assert.ok(data.every(Number.isFinite));
  });

  test("encoder_pre output matches Python onnxruntime (CPU)", async (t) => {
    if (!existsSync(REFVENV_PYTHON)) {
      t.skip(`reference Python venv not found at ${REFVENV_PYTHON}`);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "cipetpet-ort-"));
    try {
      writeFileSync(join(dir, "in.f32"), feats());
      const script = [
        "import sys, numpy as np, onnxruntime as ort",
        "x = np.fromfile(sys.argv[2], dtype='<f4').reshape(1, -1, 160)",
        "s = ort.InferenceSession(sys.argv[1], providers=['CPUExecutionProvider'])",
        "s.run(None, {'feats': x})[0].astype('<f4').tofile(sys.argv[3])",
      ].join("\n");
      execFileSync(REFVENV_PYTHON, ["-I", "-c", script, GRAPH, join(dir, "in.f32"), join(dir, "out.f32")]);
      const raw = readFileSync(join(dir, "out.f32"));
      const ref = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      const { data } = await runEncoderPre(await initRuntime());
      assert.equal(data.length, ref.length);
      let maxDiff = 0;
      let maxRef = 0;
      for (let i = 0; i < ref.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(data[i] - ref[i]));
        maxRef = Math.max(maxRef, Math.abs(ref[i]));
      }
      assert.ok(maxDiff <= 1e-3 * Math.max(1, maxRef), `max |diff| ${maxDiff} (max |ref| ${maxRef})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a later, conflicting configuration warns once and keeps the first", async (t) => {
    await initRuntime();
    const warn = t.mock.method(console, "warn", () => {});
    const rt = await initRuntime({ logLevel: "verbose", proxy: true, wasmPaths: "https://cdn.example/ort/" });
    assert.equal(rt.ort.env.logLevel, "error");
    assert.equal(rt.ort.env.wasm.proxy, false);
    assert.equal(rt.ort.env.wasm.wasmPaths, undefined);
    const msgs = warn.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(msgs.length, 3, msgs.join("\n"));
    assert.match(msgs[0], /already configured with wasmPaths = \(ORT default\); ignoring wasmPaths = "https:\/\/cdn\.example\/ort\/"/);
    assert.match(msgs[1], /proxy = false; ignoring proxy = true/);
    assert.match(msgs[2], /logLevel = "error"; ignoring logLevel = "verbose"/);
    const n = warn.mock.callCount();
    await initRuntime({ logLevel: "verbose" });
    assert.equal(warn.mock.callCount(), n, "the same conflict warns only once");
    // options equal to the configuration in force (or omitted) are not conflicts
    await initRuntime({ logLevel: "error", threads: 1, proxy: false });
    assert.equal(warn.mock.callCount(), n);
  });

  test("webgpu without navigator.gpu falls back to wasm with a warning", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const rt = await initRuntime({ backend: "webgpu" });
    assert.equal(rt.backend, "wasm");
    assert.ok(warn.mock.calls.some((c) => /WebGPU is not available/.test(String(c.arguments[0]))));
  });

  test("createSession names the graph in its errors; bad options are rejected", async () => {
    const rt = await initRuntime();
    await assert.rejects(rt.createSession(new Uint8Array([1, 2, 3, 4]), "bogus.onnx"), (e: Error) => {
      assert.match(e.message, /"bogus\.onnx" \(wasm\)/);
      assert.ok(e.cause);
      return true;
    });
    await assert.rejects(initRuntime({ ort: {} }), /not an onnxruntime-web module/);
    await assert.rejects(initRuntime({ backend: "webgl" as never }), /unknown backend/);
  });

  test("wasmBinary from options is handed to ORT (child process)", () => {
    const r = child("explicit");
    assert.equal(r.wasmBinaryBytes, readFileSync(ORT_WASM).byteLength);
    assert.deepEqual(r.dims, [1, FRAMES / 2, 256]);
    assert.equal(r.finite, true);
  });

  test("a pack's runtime binary is used when its ORT version matches (child process)", () => {
    const r = child("pack");
    assert.equal(r.wasmBinaryBytes, readFileSync(ORT_WASM).byteLength);
    assert.equal(r.wasmBinaryTight, true, "the view into the pack is copied out");
    assert.deepEqual(r.dims, [1, FRAMES / 2, 256]);
    assert.deepEqual(r.warnings, []);
  });

  test("a pack's binary really reaches ORT: a corrupt one breaks session creation (child process)", () => {
    const r = child("pack-corrupt");
    assert.equal(r.wasmBinaryBytes, 4096);
    assert.match(String(r.sessionError), /could not create an ONNX Runtime session for "encoder_pre"/);
  });

  test("a pack built for another ORT version: binary ignored with a warning (child process)", () => {
    const r = child("pack-mismatch");
    assert.equal(r.wasmBinaryBytes, null);
    assert.deepEqual(r.dims, [1, FRAMES / 2, 256]);
    const w = r.warnings as string[];
    assert.equal(w.length, 1);
    assert.match(w[0], /embeds the ONNX Runtime 1\.29\.0 binary but onnxruntime-web 1\.30\.0 is loaded/);
  });

  test("threads > 1 with the wasm build outside a browser: single-threaded with a hint (child process)", () => {
    const r = child("threads");
    assert.equal(r.threads, 1);
    assert.deepEqual(r.dims, [1, FRAMES / 2, 256]);
    const w = r.warnings as string[];
    assert.equal(w.length, 1);
    assert.match(w[0], /threads: 2 is not available with onnxruntime-web\/wasm outside a browser/);
  });

  test("threads with ORT's node build passed as `ort`: numThreads set, clamped to the cores (child process)", () => {
    const r = child("threads-node-build");
    assert.equal(r.threads, Math.min(2, navigator.hardwareConcurrency || 1));
    assert.deepEqual(r.dims, [1, FRAMES / 2, 256]);
    assert.equal(r.finite, true);
    assert.deepEqual(r.warnings, []);
  });

  // ----------------------------------------------------------------------------------------- util
  test("SerialQueue runs tasks one at a time, in order, and survives failures", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    let running = 0;
    const task = (name: string, ms: number, fail = false) => async () => {
      running++;
      assert.equal(running, 1, "two tasks overlapped");
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      running--;
      if (fail) throw new Error(name);
      return name;
    };
    const a = q.run(task("a", 20));
    const b = q.run(task("b", 1, true));
    const c = q.run(task("c", 5));
    assert.equal(q.size, 3);
    assert.equal(await a, "a");
    await assert.rejects(b, /b/);
    assert.equal(await c, "c");
    await q.idle();
    assert.equal(q.size, 0);
    assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  test("throwIfAborted / isAbortError", () => {
    throwIfAborted(undefined);
    const ac = new AbortController();
    throwIfAborted(ac.signal);
    ac.abort();
    assert.throws(() => throwIfAborted(ac.signal), (e: Error) => e.name === "AbortError");
    const custom = new AbortController();
    const reason = new Error("stop");
    custom.abort(reason);
    assert.throws(() => throwIfAborted(custom.signal), (e) => e === reason);
    assert.ok(isAbortError(reason, custom.signal));
    assert.ok(isAbortError(new DOMException("x", "AbortError")));
    assert.ok(!isAbortError(new Error("x")));
  });
}
