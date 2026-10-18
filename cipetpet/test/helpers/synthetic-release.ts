// A tiny fake "packs/ + onnxruntime-web" pair and a release built from it with the real tools, for the tests of
// tools/release-assets.ts and bin/cipetpet.mjs. Nothing here needs the real models or the network.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePack } from "../../src/pack/writer.js";
import { buildManifest, integrityFromHex, manifestText, type BuiltPack } from "../../tools/build-packs.js";
import { assembleRelease, ORT_FILES, type AssembleResult } from "../../tools/release-assets.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const TEST_OUT = join(ROOT, ".test-out");
export const FAKE_ORT_VERSION = "7.7.7";

/** Deterministic pseudo-random bytes (the same seed gives the same bytes). */
export function bytesFor(seed: string, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let block = createHash("sha256").update(seed).digest();
  for (let i = 0; i < n; i += 32) {
    out.set(block.subarray(0, Math.min(32, n - i)), i);
    block = createHash("sha256").update(block).digest();
  }
  return out;
}

export interface FakePack {
  name: string;
  model: "antalia-mini" | "duyu-small";
  variant: string;
  size: number;
}

export const FAKE_PACKS: FakePack[] = [
  { name: "antalia-mini-int8", model: "antalia-mini", variant: "int8", size: 3000 },
  { name: "duyu-small-int8", model: "duyu-small", variant: "int8", size: 5000 },
  { name: "duyu-small-q4", model: "duyu-small", variant: "q4", size: 4000 },
];

/** onnxruntime-web look-alike: package.json and dist/ with the four files release-assets.ts ships. */
export function writeFakeOrt(dir: string, version = FAKE_ORT_VERSION): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "onnxruntime-web", version, license: "MIT" }));
  for (const f of ORT_FILES) writeFileSync(join(dir, "dist", f.name), bytesFor(`${version}/${f.name}`, f.name.endsWith(".wasm") ? 6000 : 700));
}

/** Real (tiny) .cpet packs and the packs/manifest.json build-packs.ts would write for them. */
export async function writeFakePacks(dir: string, ortVersion = FAKE_ORT_VERSION, packs = FAKE_PACKS): Promise<BuiltPack[]> {
  mkdirSync(dir, { recursive: true });
  const built: BuiltPack[] = [];
  for (const p of packs) {
    const bytes = await writePack({
      model: { id: p.model, name: p.model, version: "1.0.0", task: p.model === "antalia-mini" ? "text-to-speech" : "speech-recognition", variant: p.variant },
      runtime: { onnxruntime: ortVersion },
      meta: {},
      entries: [{ name: "graphs/x.onnx", type: "onnx", data: bytesFor(p.name, p.size) }],
    });
    const file = join(dir, `${p.name}.cpet`);
    writeFileSync(file, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    built.push({
      name: p.name,
      file,
      bytes: bytes.byteLength,
      entries: 1,
      sha256,
      integrity: integrityFromHex(sha256),
      model: p.model,
      variant: p.variant,
      onnxruntime: ortVersion,
      embedsRuntime: false,
    });
  }
  writeFileSync(join(dir, "manifest.json"), manifestText(buildManifest(built)));
  return built;
}

export interface SyntheticRelease extends AssembleResult {
  /** the directory holding packs/ and ort/ sources */
  work: string;
  packsDir: string;
  ortDir: string;
}

/** Builds fake packs + fake onnxruntime-web under `work` and assembles a release in `work/release`. */
export async function makeRelease(work: string, version = "0.1.0", ortVersion = FAKE_ORT_VERSION): Promise<SyntheticRelease> {
  rmSync(work, { recursive: true, force: true });
  const packsDir = join(work, "packs");
  const ortDir = join(work, "node_modules/onnxruntime-web");
  await writeFakePacks(packsDir, ortVersion);
  writeFakeOrt(ortDir, ortVersion);
  const r = assembleRelease({ packsDir, outDir: join(work, "release"), version, ortDir, licensePath: join(ROOT, "LICENSE") });
  return { ...r, work, packsDir, ortDir };
}
