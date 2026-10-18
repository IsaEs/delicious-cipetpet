// Assembles the files that are attached to a GitHub Release (RELEASES.md) from an existing packs/ directory
// and the pinned onnxruntime-web in node_modules.
//
//   npx tsx tools/release-assets.ts [--packs packs] [--out release] [--version X.Y.Z] [--force] [--notes FILE] [--digest FILE]
//
// <out> gets flat files, no folders:
//   <name>.cpet                         the packs listed in <packs>/manifest.json, each verified against it
//   ort-wasm-simd-threaded.{mjs,wasm}   ONNX Runtime files for backend "wasm" (default), copied byte for byte
//   ort-wasm-simd-threaded.asyncify.*   ... for backend "webgpu"
//   cipetpet-release.json               what is in the release (see ReleaseManifest), deterministic
//   SHA256SUMS                          `sha256sum -c` format, LF only, lists everything except itself
//   LICENSE, NOTICE                     Apache-2.0 text; credits for the models and the ONNX Runtime MIT notice
// Running it twice on the same inputs gives byte-identical output. --notes writes the release notes
// (the template in RELEASES.md filled with the asset table) to FILE, which should not be inside <out>.
// --digest FILE writes {format, version, manifestSha256}: the SHA-256 of cipetpet-release.json. Write it to
// bin/release-digest.json before `npm publish`, and `cipetpet pull` then refuses a release whose manifest differs
// from what the npm package was published with (the package is the trust anchor outside the download).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { integrityFromHex, type Manifest } from "./build-packs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The ONNX Runtime files the library can load (src/runtime/ort.ts, CDN.md): backend "wasm" imports
 * onnxruntime-web/wasm (ort-wasm-simd-threaded.*), backend "webgpu" imports onnxruntime-web/webgpu
 * (the asyncify build). The package root's JSEP build (.jsep.*) and the .jspi.* build are never used. */
export const ORT_FILES: { name: string; backend: "wasm" | "webgpu" }[] = [
  { name: "ort-wasm-simd-threaded.asyncify.mjs", backend: "webgpu" },
  { name: "ort-wasm-simd-threaded.asyncify.wasm", backend: "webgpu" },
  { name: "ort-wasm-simd-threaded.mjs", backend: "wasm" },
  { name: "ort-wasm-simd-threaded.wasm", backend: "wasm" },
];

export const RELEASE_MANIFEST = "cipetpet-release.json";
export const SUMS_FILE = "SHA256SUMS";
export const GENERATOR = "cipetpet/tools/release-assets.ts";

export interface ReleaseAsset {
  name: string;
  bytes: number;
  sha256: string;
  kind: "pack" | "ort" | "doc";
  /** packs only */
  model?: string;
  variant?: string;
  integrity?: string;
  /** ort files only: the backend that loads them */
  backend?: "wasm" | "webgpu";
}

/** cipetpet-release.json */
export interface ReleaseManifest {
  format: 1;
  version: string;
  ortVersion: string;
  generator: string;
  assets: ReleaseAsset[];
}

const MIT_ORT = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** The NOTICE file of a release. The ONNX Runtime licence text is read from onnxruntime-web's LICENSE file
 * when the package ships one (1.30.0 does not), else the MIT text of the ONNX Runtime repository is used. */
export function noticeText(ortVersion: string, ortLicense?: string): string {
  const license = (ortLicense ?? MIT_ORT).replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
  return `cipetpet release files
======================

This release ships files from several projects. Each keeps its own licence.

cipetpet (the .cpet packs' container format, the pull command and these tools)
  Apache License 2.0, see the LICENSE file. https://github.com/IsaEs/delicious-cipetpet

Antalia-2 Mini (antalia-mini-*.cpet)
  Turkish text to speech by PatientDesk AI. Apache License 2.0.
  Source: https://huggingface.co/spaces/cloud0day3/antalia-mini
  The packs contain the model graphs and the text frontend data of that Space, converted into the .cpet container.
  The voice is synthetic; no real person's voice was used in training.

Duyu-small (duyu-small-*.cpet)
  Turkish and English speech recognition by KaanAydinli. Apache License 2.0.
  Source: https://huggingface.co/KaanAydinli/Duyu-small
  The packs contain the ONNX graphs, feature tables and tokenizer of that repository, converted into the .cpet
  container. Its encoder design (a Conformer applied in 3 shared refinement passes with a sparse acoustic memory)
  is taken from balbal, described by its author at https://erayy.com/balbal-blog.

ONNX Runtime ${ortVersion} (ort-wasm-simd-threaded*.mjs, ort-wasm-simd-threaded*.wasm)
  Copyright (c) Microsoft Corporation. MIT License. https://github.com/microsoft/onnxruntime
  The files are copied unchanged from the onnxruntime-web ${ortVersion} npm package. The licence text:

${license.replace(/^/gm, "  ").replace(/^ +$/gm, "")}`;
}

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export class ReleaseError extends Error {}

export interface AssembleOptions {
  /** directory with the .cpet files and manifest.json written by tools/build-packs.ts */
  packsDir: string;
  outDir: string;
  /** release version, default: package.json */
  version?: string;
  /** replace the contents of a previous release directory */
  force?: boolean;
  /** node_modules/onnxruntime-web */
  ortDir?: string;
  /** the Apache-2.0 text */
  licensePath?: string;
  /** write the release notes here */
  notesPath?: string;
  /** RELEASES.md, the source of the notes template */
  releasesDoc?: string;
  log?: (line: string) => void;
}

export interface AssembleResult {
  outDir: string;
  version: string;
  ortVersion: string;
  assets: ReleaseAsset[];
  manifestText: string;
  sumsText: string;
}

const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function isInside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !r.startsWith("/") && !/^[A-Za-z]:/.test(r));
}

/** The text of cipetpet-release.json for `assets` (sorted by name, fixed key order, trailing newline). */
export function releaseManifestText(version: string, ortVersion: string, assets: ReleaseAsset[]): string {
  const ordered = [...assets].sort(byName).map((a) => {
    const o: ReleaseAsset = { name: a.name, bytes: a.bytes, sha256: a.sha256, kind: a.kind };
    if (a.kind === "pack") {
      o.model = a.model;
      o.variant = a.variant;
      o.integrity = a.integrity;
    }
    if (a.kind === "ort") o.backend = a.backend;
    return o;
  });
  const m: ReleaseManifest = { format: 1, version, ortVersion, generator: GENERATOR, assets: ordered };
  return JSON.stringify(m, null, 2) + "\n";
}

/** `sha256sum -c` input: "<hex>  <name>" lines sorted by name, LF only. */
export function sumsFileText(files: { name: string; sha256: string }[]): string {
  return [...files].sort(byName).map((f) => `${f.sha256}  ${f.name}\n`).join("");
}

function mib(n: number): string {
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/** The markdown table of a release's assets, for the release notes. */
export function assetTable(assets: ReleaseAsset[]): string {
  const rows = [...assets].sort(byName).map((a) => {
    const what =
      a.kind === "pack" ? `${a.model} ${a.variant} pack` : a.kind === "ort" ? `ONNX Runtime, backend \`${a.backend}\`` : "licence text";
    return `| \`${a.name}\` | ${what} | ${a.bytes.toLocaleString("en-US")} | ${mib(a.bytes)} | \`${a.sha256}\` |`;
  });
  return ["| file | what | bytes | size | sha256 |", "| --- | --- | ---: | ---: | --- |", ...rows].join("\n");
}

/** The release-notes template from RELEASES.md: the text between the markers, without its code fence. */
export function notesTemplate(releasesDoc: string): string {
  const m = /<!-- release-notes:start -->\s*```[a-z]*\n([\s\S]*?)\n```\s*<!-- release-notes:end -->/.exec(releasesDoc);
  if (!m) throw new ReleaseError("RELEASES.md has no <!-- release-notes:start --> ... <!-- release-notes:end --> template block");
  return m[1] + "\n";
}

export function renderNotes(template: string, vars: { tag: string; version: string; ortVersion: string; repo: string; table: string }): string {
  const map: Record<string, string> = {
    TAG: vars.tag,
    VERSION: vars.version,
    ORT_VERSION: vars.ortVersion,
    REPO: vars.repo,
    ASSET_TABLE: vars.table,
  };
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (all, key: string) => (key in map ? map[key] : all));
  const left = /\{\{[A-Z_]+\}\}/.exec(out);
  if (left) throw new ReleaseError(`release notes template has an unknown placeholder ${left[0]}`);
  return out;
}

/** Builds the release directory. Throws ReleaseError for anything that does not check out. */
export function assembleRelease(opts: AssembleOptions): AssembleResult {
  const log = opts.log ?? (() => {});
  const packsDir = resolve(opts.packsDir);
  const outDir = resolve(opts.outDir);
  const ortDir = resolve(opts.ortDir ?? join(ROOT, "node_modules/onnxruntime-web"));
  const pkg = readJson(join(ROOT, "package.json"));
  const version = opts.version ?? String(pkg.version);
  if (!SEMVER.test(version)) throw new ReleaseError(`bad version "${version}" (expected X.Y.Z)`);

  // ---- packs
  const manifestPath = join(packsDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new ReleaseError(`${manifestPath} not found (run npm run packs first)`);
  const manifest = readJson(manifestPath) as Manifest;
  if (manifest.format !== "cipetpet-packs" || manifest.version !== 1 || !Array.isArray(manifest.packs) || manifest.packs.length === 0) {
    throw new ReleaseError(`${manifestPath} is not a cipetpet-packs manifest with packs`);
  }

  // ---- ONNX Runtime
  const ortPkgPath = join(ortDir, "package.json");
  if (!existsSync(ortPkgPath)) throw new ReleaseError(`${ortPkgPath} not found (run npm ci)`);
  const ortVersion = String(readJson(ortPkgPath).version);

  const assets: ReleaseAsset[] = [];
  const sources = new Map<string, string>(); // asset name -> file to copy
  const seen = new Set<string>();
  const add = (a: ReleaseAsset, src: string) => {
    if (!/^[A-Za-z0-9._-]+$/.test(a.name) || a.name.startsWith(".")) throw new ReleaseError(`unsafe asset name ${JSON.stringify(a.name)}`);
    if (seen.has(a.name.toLowerCase())) throw new ReleaseError(`duplicate asset name ${a.name}`);
    seen.add(a.name.toLowerCase());
    assets.push(a);
    sources.set(a.name, src);
  };

  for (const p of manifest.packs) {
    const src = join(packsDir, p.file);
    if (basename(p.file) !== p.file) throw new ReleaseError(`manifest lists ${p.file}: not a plain file name`);
    if (!existsSync(src)) throw new ReleaseError(`pack ${p.file} is listed in ${manifestPath} but missing`);
    if (p.onnxruntime !== ortVersion) {
      throw new ReleaseError(`pack ${p.file} was built for onnxruntime ${p.onnxruntime}, node_modules has onnxruntime-web ${ortVersion} (rebuild the packs)`);
    }
    const data = readFileSync(src);
    const sha = sha256Hex(data);
    if (data.byteLength !== p.bytes) throw new ReleaseError(`pack ${p.file}: ${data.byteLength} bytes on disk, manifest says ${p.bytes}`);
    if (sha !== p.sha256) throw new ReleaseError(`pack ${p.file}: SHA-256 mismatch (disk ${sha}, manifest ${p.sha256}); rebuild the packs`);
    const integrity = integrityFromHex(sha);
    if (p.integrity !== integrity) throw new ReleaseError(`pack ${p.file}: manifest integrity ${p.integrity} does not match its sha256`);
    add({ name: p.file, bytes: data.byteLength, sha256: sha, kind: "pack", model: p.model, variant: p.variant, integrity }, src);
  }

  for (const f of ORT_FILES) {
    const src = join(ortDir, "dist", f.name);
    if (!existsSync(src)) throw new ReleaseError(`${src} not found (onnxruntime-web ${ortVersion})`);
    const data = readFileSync(src);
    add({ name: f.name, bytes: data.byteLength, sha256: sha256Hex(data), kind: "ort", backend: f.backend }, src);
  }

  // ---- docs
  const licensePath = resolve(opts.licensePath ?? join(ROOT, "LICENSE"));
  if (!existsSync(licensePath)) throw new ReleaseError(`${licensePath} not found`);
  const licenseBytes = readFileSync(licensePath);
  if (!licenseBytes.toString("utf8").includes("Apache License")) throw new ReleaseError(`${licensePath} is not the Apache-2.0 text`);
  const ortLicensePath = join(ortDir, "LICENSE");
  const notice = Buffer.from(noticeText(ortVersion, existsSync(ortLicensePath) ? readFileSync(ortLicensePath, "utf8") : undefined), "utf8");
  const docSources = new Map<string, Buffer>([
    ["LICENSE", licenseBytes],
    ["NOTICE", notice],
  ]);
  for (const [name, data] of docSources) add({ name, bytes: data.byteLength, sha256: sha256Hex(data), kind: "doc" }, "");

  const manifestText = releaseManifestText(version, ortVersion, assets);
  const sumsText = sumsFileText([...assets, { name: RELEASE_MANIFEST, sha256: sha256Hex(Buffer.from(manifestText)) }]);

  // ---- output directory
  if (isInside(outDir, packsDir) || isInside(packsDir, outDir)) throw new ReleaseError("--out and --packs must not contain each other");
  if (isInside(outDir, ortDir) || isInside(outDir, ROOT)) throw new ReleaseError(`refusing to use ${outDir} as the output directory`);
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory()) throw new ReleaseError(`${outDir} exists and is not a directory`);
    const entries = readdirSync(outDir);
    if (entries.length > 0) {
      if (!opts.force) throw new ReleaseError(`${outDir} is not empty; pass --force to replace its contents`);
      if (!entries.includes(RELEASE_MANIFEST)) {
        throw new ReleaseError(`${outDir} is not empty and does not look like a previous release (no ${RELEASE_MANIFEST}); not deleting anything`);
      }
      for (const e of entries) rmSync(join(outDir, e), { recursive: true, force: true });
    }
  }
  mkdirSync(outDir, { recursive: true });

  try {
    for (const a of assets) {
      const dest = join(outDir, a.name);
      const doc = docSources.get(a.name);
      if (doc) writeFileSync(dest, doc);
      else {
        copyFileSync(sources.get(a.name)!, dest);
        // copy check: what landed in <out> is what was verified
        const after = sha256Hex(readFileSync(dest));
        if (after !== a.sha256) throw new ReleaseError(`${a.name}: copy differs from the source (${after} vs ${a.sha256})`);
      }
    }
    writeFileSync(join(outDir, RELEASE_MANIFEST), manifestText);
    writeFileSync(join(outDir, SUMS_FILE), sumsText);
  } catch (e) {
    for (const f of readdirSync(outDir)) rmSync(join(outDir, f), { recursive: true, force: true });
    throw e;
  }

  const sorted = [...assets].sort(byName);
  if (opts.notesPath) {
    const docPath = opts.releasesDoc ?? join(ROOT, "RELEASES.md");
    const repoUrl = String(pkg.repository?.url ?? "");
    const repo = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(repoUrl)?.[1] ?? "IsaEs/delicious-cipetpet";
    const notes = renderNotes(notesTemplate(readFileSync(docPath, "utf8")), {
      tag: `v${version}`,
      version,
      ortVersion,
      repo,
      table: assetTable(sorted),
    });
    mkdirSync(dirname(resolve(opts.notesPath)), { recursive: true });
    writeFileSync(opts.notesPath, notes);
    log(`wrote release notes to ${opts.notesPath}`);
  }
  return { outDir, version, ortVersion, assets: sorted, manifestText, sumsText };
}

/** The text of bin/release-digest.json for a release. */
export function digestText(version: string, manifestText: string): string {
  return JSON.stringify({ format: 1, version, manifestSha256: sha256Hex(Buffer.from(manifestText)) }, null, 2) + "\n";
}

function usage(): string {
  return "usage: tsx tools/release-assets.ts [--packs packs] [--out release] [--version X.Y.Z] [--force] [--notes FILE] [--digest FILE]";
}

function main(): void {
  const argv = process.argv.slice(2);
  const opts: AssembleOptions = { packsDir: join(ROOT, "packs"), outDir: join(ROOT, "release") };
  let digestPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new ReleaseError(`${a} needs a value`);
      return v;
    };
    if (a === "--packs") opts.packsDir = resolve(value());
    else if (a === "--out") opts.outDir = resolve(value());
    else if (a === "--version") opts.version = value();
    else if (a === "--notes") opts.notesPath = resolve(value());
    else if (a === "--digest") digestPath = resolve(value());
    else if (a === "--force") opts.force = true;
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      return;
    } else throw new ReleaseError(`unknown argument ${a}\n${usage()}`);
  }
  const t0 = performance.now();
  const r = assembleRelease({ ...opts, log: (l) => console.error(l) });
  if (digestPath) {
    mkdirSync(dirname(digestPath), { recursive: true });
    writeFileSync(digestPath, digestText(r.version, r.manifestText));
    console.error(`wrote ${digestPath}`);
  }
  const files = [
    ...r.assets,
    { name: RELEASE_MANIFEST, bytes: Buffer.byteLength(r.manifestText), sha256: sha256Hex(Buffer.from(r.manifestText)), kind: "manifest" },
    { name: SUMS_FILE, bytes: Buffer.byteLength(r.sumsText), sha256: "-", kind: "sums" },
  ];
  const w = Math.max(...files.map((f) => f.name.length));
  console.log(`release ${r.version} (onnxruntime-web ${r.ortVersion}) in ${r.outDir}\n`);
  console.log(`${"file".padEnd(w)}  ${"kind".padEnd(8)}  ${"size".padStart(11)}  sha256`);
  for (const f of files) console.log(`${f.name.padEnd(w)}  ${f.kind.padEnd(8)}  ${mib(f.bytes).padStart(11)}  ${f.sha256 === "-" ? "-" : f.sha256}`);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  console.log(`\ncipetpet-release.json sha256: ${sha256Hex(Buffer.from(r.manifestText))}  (cipetpet pull --manifest-sha256)`);
  console.log(`${files.length} files, ${mib(total)} in total (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(`release-assets: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
