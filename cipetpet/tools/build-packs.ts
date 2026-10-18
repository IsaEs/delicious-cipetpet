// Builds the .cpet packs from the upstream model files.
//
//   npx tsx tools/build-packs.ts [--out packs] [--only antalia-mini-mixed,duyu-small-int8] [--embed-runtime]
//                                [--hash-names] [--antalia DIR] [--duyu DIR] [--ema DIR]
//
// EMA Lightning's graphs come from ema-lightning-web's export (web/export_onnx.py, reproducible byte for byte from
// the Hugging Face weights) and its text normaliser from that project's normalizer-tr WebAssembly build. --ema takes
// a folder with those files: .upstream/ema-lightning (flat: the published export tedash34/ema-lightning-onnx,
// pinned in tools/upstream.lock.json and fetched by `npm run upstream`), ema-lightning-web's web/ folder (models/ +
// normalizer/pkg/) or a copy of its dist/. The default is the first of .upstream/ema-lightning and ../ema-lightning-web/web that holds a complete export;
// without one the ema-lightning pack is skipped (unless --only asks for it). An ema-lightning.json next to the files
// (the published export has one) gives the package version and the normalizer-tr version for the pack header.
//
// Packs are deterministic: the same inputs give byte-identical files (the printed SHA-256 shows it).
//
// Next to the packs it writes <out>/manifest.json: for each pack its file, size, SHA-256 (hex, and as the
// Subresource-Integrity string for PackLoadOptions.integrity), model id, variant and the ONNX Runtime
// version. The manifest is deterministic as well (no timestamps) and, with --only, updates just the
// selected entries of an existing manifest. --hash-names also writes every pack as
// <name>.<first 8 hex of its SHA-256>.cpet, a file name that never changes its content, for hosts that
// should serve it with "Cache-Control: immutable".
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { writePack } from "../src/pack/writer.js";
import type { PackInput, PackInputEntry, PackModelInfo } from "../src/pack/types.js";
import { readNpz } from "./lib/npz.js";
import { parseSpm } from "./lib/spm.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ANTALIA_GRAPHS = ["text", "cond", "flow", "vocoder"] as const;
export const DUYU_GRAPHS = ["encoder_pre", "encoder_pass", "encoder_post", "decoder"] as const;
export const EMA_GRAPHS = ["text", "sound", "decoder"] as const;
export const EMA_PACK = "ema-lightning-fp32";

/** Graph file suffix per Antalia graph for each pack variant. */
export const ANTALIA_VARIANTS: Record<string, Record<(typeof ANTALIA_GRAPHS)[number], string>> = {
  mixed: { text: "", cond: "", flow: "", vocoder: ".fp16" },
  fp32: { text: "", cond: "", flow: "", vocoder: "" },
  fp16: { text: ".fp16", cond: ".fp16", flow: ".fp16", vocoder: ".fp16" },
  int8: { text: ".int8", cond: ".int8", flow: ".int8", vocoder: ".int8" },
};
export const DUYU_VARIANTS = ["int8", "q4", "fp32"];

export interface BuildOptions {
  out: string;
  antaliaDir: string;
  duyuDir: string;
  /** ema-lightning-web's web/ folder (or its dist/); the EMA pack is skipped when it holds no export */
  emaDir?: string;
  /** pack names (e.g. "duyu-small-int8") to build; all when undefined */
  only?: string[];
  embedRuntime?: boolean;
  /** also write <name>.<8 hex of sha256>.cpet */
  hashNames?: boolean;
  /** node_modules/onnxruntime-web */
  ortDir?: string;
  log?: (line: string) => void;
}

export interface BuiltPack {
  name: string;
  file: string;
  bytes: number;
  entries: number;
  sha256: string;
  /** "sha256-<base64>", the value for PackLoadOptions.integrity */
  integrity: string;
  model: string;
  variant: string;
  onnxruntime: string;
  embedsRuntime: boolean;
  /** the <name>.<8 hex>.cpet file, with --hash-names */
  hashedFile?: string;
}

/** One pack in packs/manifest.json (file names are relative to the manifest). */
export interface ManifestPack {
  name: string;
  file: string;
  /** the immutable <name>.<8 hex of sha256>.cpet copy, when it was written (--hash-names) */
  hashedFile?: string;
  bytes: number;
  sha256: string;
  integrity: string;
  model: string;
  variant: string;
  onnxruntime: string;
  embedsRuntime: boolean;
}

export interface Manifest {
  format: "cipetpet-packs";
  version: 1;
  packs: ManifestPack[];
}

/** "sha256-<base64>" for a hex SHA-256 digest. */
export function integrityFromHex(hex: string): string {
  return `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
}

export function hashedName(name: string, sha256: string): string {
  return `${name}.${sha256.slice(0, 8)}.cpet`;
}

/** The manifest for `packs`, sorted by name, entries with a fixed key order. */
export function buildManifest(packs: BuiltPack[]): Manifest {
  const sorted = [...packs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    format: "cipetpet-packs",
    version: 1,
    packs: sorted.map((p): ManifestPack => {
      const m: ManifestPack = {
        name: p.name,
        file: basename(p.file),
        bytes: p.bytes,
        sha256: p.sha256,
        integrity: p.integrity,
        model: p.model,
        variant: p.variant,
        onnxruntime: p.onnxruntime,
        embedsRuntime: p.embedsRuntime,
      };
      if (p.hashedFile) m.hashedFile = basename(p.hashedFile);
      return m;
    }),
  };
}

/** The text of a manifest file: stable, 2-space JSON with a trailing newline. */
export function manifestText(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

function mergeManifest(existing: Manifest | undefined, built: Manifest): Manifest {
  if (!existing || existing.format !== "cipetpet-packs" || !Array.isArray(existing.packs)) return built;
  const names = new Set(built.packs.map((p) => p.name));
  const kept = existing.packs.filter((p) => !names.has(p.name));
  return { ...built, packs: [...kept, ...built.packs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}

interface PackPlan {
  name: string;
  build: () => Promise<PackInput>;
}

const read = (path: string) => new Uint8Array(readFileSync(path));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function antaliaPlans(dir: string): PackPlan[] {
  const manifestPath = join(dir, "models/manifest.json");
  return Object.entries(ANTALIA_VARIANTS).map(([variant, precision]) => ({
    name: `antalia-mini-${variant}`,
    build: async () => {
      const manifest = json(manifestPath);
      const model: PackModelInfo = {
        id: "antalia-mini",
        name: "Antalia-2 Mini",
        version: String(manifest.version),
        task: "text-to-speech",
        variant,
        license: "Apache-2.0",
        source: "https://huggingface.co/spaces/cloud0day3/antalia-mini",
        languages: ["tr"],
      };
      const frontend = gunzipSync(readFileSync(join(dir, "assets/frontend-data.json.gz")));
      JSON.parse(frontend.toString("utf8")); // fail the build on a broken file, not the page
      const entries: PackInputEntry[] = [
        ...ANTALIA_GRAPHS.map((g): PackInputEntry => ({
          name: `graphs/${g}.onnx`,
          type: "onnx",
          data: read(join(dir, "models", `${g}${precision[g]}.onnx`)),
        })),
        { name: "frontend/data.json", type: "json", data: new Uint8Array(frontend), encoding: "gzip" },
        { name: "model/manifest.json", type: "json", data: read(manifestPath) },
      ];
      return { model, meta: { sampleRate: 48000, precision: { ...precision } }, entries };
    },
  }));
}

function duyuPlans(dir: string): PackPlan[] {
  return DUYU_VARIANTS.filter((v) => existsSync(join(dir, v))).map((variant) => ({
    name: `duyu-small-${variant}`,
    build: async () => {
      const model: PackModelInfo = {
        id: "duyu-small",
        name: "Duyu-small",
        version: "1.0.0",
        task: "speech-recognition",
        variant,
        license: "Apache-2.0",
        source: "https://huggingface.co/KaanAydinli/Duyu-small",
        languages: ["tr", "en"],
      };
      const fbank = readNpz(read(join(dir, "fbank.npz")), "fbank.npz");
      const passes = readNpz(read(join(dir, "passes.npz")), "passes.npz");
      const table = (z: ReturnType<typeof readNpz>, file: string, key: string, name: string): PackInputEntry => {
        const a = z.get(key);
        if (!a) throw new Error(`${file} has no array "${key}"`);
        const data = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
        return { name: `tables/${name}`, type: "tensor", dtype: "float32", shape: a.shape, data };
      };
      const engine = json(join(dir, "engine.json"));
      const pieces = parseSpm(read(join(dir, "spm.model")));
      if (engine.vocab_size !== undefined && pieces.length !== engine.vocab_size)
        throw new Error(`spm.model has ${pieces.length} pieces, engine.json says vocab_size ${engine.vocab_size}`);
      const piecesJson = JSON.stringify({ pieces: pieces.map((p) => [p.piece, p.type]) });

      const entries: PackInputEntry[] = [
        ...DUYU_GRAPHS.map((g): PackInputEntry => ({ name: `graphs/${g}.onnx`, type: "onnx", data: read(join(dir, variant, `${g}.onnx`)) })),
        table(fbank, "fbank.npz", "window", "fbank_window"),
        table(fbank, "fbank.npz", "mel", "fbank_mel"),
        table(passes, "passes.npz", "gates", "pass_gates"),
        table(passes, "passes.npz", "pass_embed", "pass_embed"),
        { name: "tokenizer/pieces.json", type: "json", data: new TextEncoder().encode(piecesJson) },
        { name: "model/engine.json", type: "json", data: read(join(dir, "engine.json")) },
        { name: "model/config.json", type: "json", data: read(join(dir, "config.json")) },
      ];
      return { model, meta: { sampleRate: 16000 }, entries };
    },
  }));
}

/** Where an EMA Lightning export keeps its files: web/{models/, normalizer/pkg/} or a dist/ copy (models/ + the
 * normaliser's .wasm at the top). null when `dir` holds no complete export. */
export function emaFiles(dir: string): { models: string; normalizer: string } | null {
  const models = [join(dir, "models"), dir].find((d) => ["config.json", ...EMA_GRAPHS.map((g) => `${g}.onnx`)].every((f) => existsSync(join(d, f))));
  const normalizer = [join(dir, "normalizer/pkg/normalizer_tr_wasm_bg.wasm"), join(dir, "normalizer_tr_wasm_bg.wasm")].find((f) => existsSync(f));
  return models && normalizer ? { models, normalizer } : null;
}

/** ema-lightning.json of a published export: which ema-lightning release and normalizer-tr build the files match. */
interface EmaProvenance {
  version?: string;
  normalizer?: { crate?: string; version?: string };
}

function emaProvenance(dir: string, files: { models: string }): EmaProvenance {
  for (const candidate of [join(files.models, "ema-lightning.json"), join(dir, "ema-lightning.json")]) {
    if (existsSync(candidate)) return json(candidate) as EmaProvenance;
  }
  return {};
}

/** The ema-lightning package version: ema-lightning.json, else the pyproject.toml next to the export, if any. */
function emaVersion(dir: string, provenance: EmaProvenance): string {
  if (typeof provenance.version === "string" && provenance.version) return provenance.version;
  for (const candidate of [join(dir, "pyproject.toml"), join(dir, "..", "pyproject.toml"), join(dir, "../..", "pyproject.toml")]) {
    if (!existsSync(candidate)) continue;
    const text = readFileSync(candidate, "utf8");
    if (!/^name\s*=\s*"ema-lightning"/m.test(text)) continue;
    const m = /^version\s*=\s*"([^"]+)"/m.exec(text);
    if (m) return m[1];
  }
  return "unknown";
}

function emaPlans(dir: string | undefined): PackPlan[] {
  const files = dir ? emaFiles(dir) : null;
  if (!dir || !files) return [];
  return [{
    name: EMA_PACK,
    build: async () => {
      const provenance = emaProvenance(dir, files);
      const model: PackModelInfo = {
        id: "ema-lightning",
        name: "EMA Lightning",
        version: emaVersion(dir, provenance),
        task: "text-to-speech",
        variant: "fp32",
        license: "Apache-2.0",
        source: "https://huggingface.co/canberkkkkkk/ema-lightning",
        languages: ["tr"],
      };
      const config = json(join(files.models, "config.json"));
      if (!Array.isArray(config.vocab) || !config.latent_dim || !config.steps || !config.hop || !config.sample_rate)
        throw new Error(`${join(files.models, "config.json")} is not an EMA Lightning config (vocab, latent_dim, steps, hop, sample_rate)`);
      const normalizer = read(files.normalizer);
      if (!WebAssembly.validate(normalizer)) throw new Error(`${files.normalizer} is not valid WebAssembly`);
      const entries: PackInputEntry[] = [
        ...EMA_GRAPHS.map((g): PackInputEntry => ({ name: `graphs/${g}.onnx`, type: "onnx", data: read(join(files.models, `${g}.onnx`)) })),
        { name: "model/config.json", type: "json", data: read(join(files.models, "config.json")) },
        // unlike ORT's binary, the normaliser is mostly data tables: gzip takes it to about a third
        { name: "frontend/normalizer.wasm", type: "wasm", data: normalizer, encoding: "auto" },
      ];
      const normalizerVersion = provenance.normalizer?.version;
      return { model, meta: { sampleRate: config.sample_rate, ...(normalizerVersion ? { normalizer: `normalizer-tr ${normalizerVersion}` } : {}) }, entries };
    },
  }];
}

/** Build the selected packs into `opts.out`. */
export async function buildPacks(opts: BuildOptions): Promise<BuiltPack[]> {
  const log = opts.log ?? (() => {});
  const ortDir = opts.ortDir ?? join(ROOT, "node_modules/onnxruntime-web");
  const ortVersion = String(json(join(ortDir, "package.json")).version);

  const plans = [...antaliaPlans(opts.antaliaDir), ...duyuPlans(opts.duyuDir), ...emaPlans(opts.emaDir)];
  if (opts.only) {
    const unknown = opts.only.filter((n) => !plans.some((p) => p.name === n));
    if (unknown.includes(EMA_PACK)) {
      throw new Error(`${EMA_PACK} needs an EMA Lightning export: npm run upstream (-> .upstream/ema-lightning), or --ema DIR (ema-lightning-web's web/ folder with models/ and normalizer/pkg/)${opts.emaDir ? `; ${opts.emaDir} has none` : ""}`);
    }
    if (unknown.length) throw new Error(`unknown pack(s): ${unknown.join(", ")} (available: ${plans.map((p) => p.name).join(", ")})`);
  }
  const selected = opts.only ? plans.filter((p) => opts.only!.includes(p.name)) : plans;
  const runtimeWasm = opts.embedRuntime ? read(join(ortDir, "dist/ort-wasm-simd-threaded.wasm")) : undefined;

  mkdirSync(opts.out, { recursive: true });
  const built: BuiltPack[] = [];
  for (const plan of selected) {
    const input = await plan.build();
    input.runtime = { onnxruntime: ortVersion };
    if (runtimeWasm) input.entries.push({ name: "runtime/ort-wasm-simd-threaded.wasm", type: "wasm", data: runtimeWasm });
    const bytes = await writePack(input);
    const file = join(opts.out, `${plan.name}.cpet`);
    writeFileSync(file, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pack: BuiltPack = {
      name: plan.name,
      file,
      bytes: bytes.byteLength,
      entries: input.entries.length,
      sha256,
      integrity: integrityFromHex(sha256),
      model: input.model.id,
      variant: input.model.variant,
      onnxruntime: ortVersion,
      embedsRuntime: !!runtimeWasm,
    };
    if (opts.hashNames) {
      pack.hashedFile = join(opts.out, hashedName(plan.name, sha256));
      writeFileSync(pack.hashedFile, bytes);
    }
    built.push(pack);
    log(`built ${file}${pack.hashedFile ? ` and ${basename(pack.hashedFile)}` : ""}`);
  }

  const manifestPath = join(opts.out, "manifest.json");
  let existing: Manifest | undefined;
  if (opts.only && existsSync(manifestPath)) {
    try {
      existing = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    } catch {
      existing = undefined; // unreadable: start over
    }
  }
  writeFileSync(manifestPath, manifestText(mergeManifest(existing, buildManifest(built))));
  log(`wrote ${manifestPath}`);
  return built;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function parseArgs(argv: string[]): BuildOptions {
  const opts: BuildOptions = {
    out: join(ROOT, "packs"),
    antaliaDir: join(ROOT, ".upstream/antalia-mini"),
    duyuDir: join(ROOT, ".upstream/duyu-small"),
    emaDir: [join(ROOT, ".upstream/ema-lightning"), join(ROOT, "../ema-lightning-web/web")].find((d) => emaFiles(d)),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--out") opts.out = resolve(value());
    else if (a === "--only") opts.only = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--embed-runtime") opts.embedRuntime = true;
    else if (a === "--hash-names") opts.hashNames = true;
    else if (a === "--antalia") opts.antaliaDir = resolve(value());
    else if (a === "--duyu") opts.duyuDir = resolve(value());
    else if (a === "--ema") opts.emaDir = resolve(value());
    else if (a === "--help" || a === "-h") {
      console.log("usage: tsx tools/build-packs.ts [--out packs] [--only name,...] [--embed-runtime] [--hash-names] [--antalia DIR] [--duyu DIR] [--ema DIR]");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = performance.now();
  const built = await buildPacks({ ...opts, log: (l) => console.error(l) });
  const w = Math.max(4, ...built.map((b) => b.name.length));
  console.log(`\n${"pack".padEnd(w)}  ${"size".padStart(10)}  entries  sha256`);
  for (const b of built) console.log(`${b.name.padEnd(w)}  ${formatSize(b.bytes).padStart(10)}  ${String(b.entries).padStart(7)}  ${b.sha256}`);
  console.log(`\n${built.length} pack(s) in ${opts.out} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`build-packs: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
