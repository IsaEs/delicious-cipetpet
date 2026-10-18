#!/usr/bin/env node
// Assembles the demo as a STATIC site for hosts without a server (GitHub Pages) into pages/:
//
//   pages/index.html, assets/…   the built app (scripts/build.mjs)
//   pages/coi-sw.js              service worker that adds COOP/COEP, so WASM threads work (static/coi-sw.js)
//   pages/packs/*.cpet           the model packs, pulled from this project's GitHub Release (cipetpet pull); the
//                                EMA Lightning pack too when the source has it (it is built locally: npm run packs)
//   pages/ort/ort-wasm-simd-threaded.{mjs,wasm}   ONNX Runtime's files
//   pages/api/config             what the demo server would answer: {proxy:false, defaultModel, packs:{file: integrity}}
//   pages/LICENSE, NOTICE        licences and credits that came with the release
//
// There is no chat proxy on a static host and no key anywhere: the page runs in echo mode, or the visitor
// types their own OpenRouter key or adds an OpenAI-compatible API (direct mode, kept in their browser only).
//
//   node scripts/build-pages.mjs [--packs-dir DIR] [--tag vX.Y.Z] [--out DIR] [--no-build]
//
//   default            pull the packs and ORT files from the GitHub Release of the cipetpet version in ../cipetpet
//   --packs-dir DIR    take them from a local folder instead (the packs/ folder of ../cipetpet, plus ORT files from
//                      its node_modules), for trying the site without a release

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = resolve(ROOT, "..", "cipetpet");
const CACHE = join(ROOT, ".pages-cache");
const ORT_FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
const DOC_FILES = ["LICENSE", "NOTICE"];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

const out = resolve(arg("--out") ?? join(ROOT, "pages"));
const packsDir = arg("--packs-dir") ? resolve(arg("--packs-dir")) : null;
const coreVersion = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")).version;
const tag = arg("--tag") ?? `v${coreVersion}`;

/** the packs the demo can ask for: the TTS pack and both STT precisions (see src/voice/cipetpet.ts) */
const PACKS = ["antalia-mini-mixed", "duyu-small-int8", "duyu-small-q4"];
/** packs the page can also use, copied when the source has them (releases before EMA Lightning was pinned do not carry
 * it); the page marks a voice whose pack is missing */
const OPTIONAL_PACKS = ["ema-lightning-fp32"];

const sri = (file) => `sha256-${createHash("sha256").update(readFileSync(file)).digest("base64")}`;
const mb = (n) => `${(n / 1048576).toFixed(2)} MiB`;

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

/** where the pack and ORT files are read from: a pulled release (cached in .pages-cache/), or a local folder */
function sourceFiles() {
  if (packsDir) {
    const ortDist = [join(CORE, "node_modules", "onnxruntime-web", "dist"), join(ROOT, "node_modules", "onnxruntime-web", "dist")].find((d) => existsSync(d));
    if (!ortDist) throw new Error("--packs-dir needs onnxruntime-web installed (npm install in ../cipetpet)");
    return { packs: (name) => join(packsDir, `${name}.cpet`), ort: (file) => join(ortDist, file), doc: (file) => [join(CORE, "..", file), join(CORE, file)].find((p) => existsSync(p)) ?? null, from: `local folder ${packsDir}` };
  }
  console.log(`pulling the release ${tag} (files already in .pages-cache/ are kept after their hash is checked)`);
  execFileSync(process.execPath, [join(CORE, "bin", "cipetpet.mjs"), "pull", "--dir", CACHE, "--tag", tag, "--packs", PACKS.join(",")], { stdio: "inherit" });
  for (const name of OPTIONAL_PACKS) {
    try {
      execFileSync(process.execPath, [join(CORE, "bin", "cipetpet.mjs"), "pull", "--dir", CACHE, "--tag", tag, "--packs", name], { stdio: "pipe" });
    } catch {
      console.log(`${name}: not in the release ${tag}; the page offers it but marks it as missing`);
    }
  }
  return { packs: (name) => join(CACHE, `${name}.cpet`), ort: (file) => join(CACHE, "ort", file), doc: (file) => (existsSync(join(CACHE, file)) ? join(CACHE, file) : null), from: `GitHub release ${tag}` };
}

if (!process.argv.includes("--no-build")) await build();
if (!existsSync(join(ROOT, "dist", "index.html"))) throw new Error("dist/ is missing: run npm run build first (or drop --no-build)");

const src = sourceFiles();
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// the app
const copyTree = (from, to) => {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, entry.name);
    const b = join(to, entry.name);
    if (entry.isDirectory()) copyTree(a, b);
    else copy(a, b);
  }
};
copyTree(join(ROOT, "dist"), out);
copy(join(ROOT, "static", "coi-sw.js"), join(out, "coi-sw.js"));
writeFileSync(join(out, ".nojekyll"), ""); // no Jekyll processing: serve every file as it is

// models and runtime
const integrity = {};
for (const name of PACKS) {
  const from = src.packs(name);
  if (!existsSync(from)) throw new Error(`missing ${from} (${src.from})`);
  copy(from, join(out, "packs", `${name}.cpet`));
  integrity[`${name}.cpet`] = sri(from);
}
for (const name of OPTIONAL_PACKS) {
  const from = src.packs(name);
  if (!existsSync(from)) continue;
  copy(from, join(out, "packs", `${name}.cpet`));
  integrity[`${name}.cpet`] = sri(from);
}
for (const file of ORT_FILES) {
  const from = src.ort(file);
  if (!existsSync(from)) throw new Error(`missing ${from} (${src.from})`);
  copy(from, join(out, "ort", file));
}
for (const file of DOC_FILES) {
  const from = src.doc(file);
  if (from) copy(from, join(out, file));
}

// what the demo server would answer; the page treats "proxy: false" as "no provider here": echo mode + bring your own
// key (OpenRouter or any OpenAI-compatible API)
const { DEFAULT_MODEL } = await import("../server/server.mjs");
mkdirSync(join(out, "api"), { recursive: true });
writeFileSync(join(out, "api", "config"), `${JSON.stringify({ proxy: false, defaultModel: DEFAULT_MODEL, provider: null, providers: [], packs: integrity })}\n`);

// summary
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else files.push([p.slice(out.length + 1), statSync(p).size]);
  }
};
walk(out);
const total = files.reduce((n, [, s]) => n + s, 0);
console.log(`\nstatic site in ${out.slice(ROOT.length + 1)}/ from ${src.from}: ${files.length} files, ${mb(total)}`);
for (const [name, size] of files.filter(([, s]) => s > 1048576).sort((a, b) => b[1] - a[1])) console.log(`  ${mb(size).padStart(10)}  ${name}`);
if (total > 900 * 1048576) console.warn("warning: close to GitHub Pages' 1 GB site limit");
