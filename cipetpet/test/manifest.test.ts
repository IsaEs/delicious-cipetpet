// tools/build-packs.ts: packs/manifest.json (deterministic, no timestamps) and --hash-names.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openPack } from "../src/pack/reader.js";
import { buildManifest, hashedName, integrityFromHex, manifestText } from "../tools/build-packs.js";
import type { BuiltPack, Manifest } from "../tools/build-packs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".test-out/manifest");
const haveUpstream = existsSync(join(ROOT, ".upstream/antalia-mini/models/manifest.json"));
const noUpstream = haveUpstream ? false : ".upstream model files missing";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ortVersion = JSON.parse(readFileSync(join(ROOT, "node_modules/onnxruntime-web/package.json"), "utf8")).version;

function run(out: string, ...args: string[]): void {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "tools/build-packs.ts"), "--out", out, ...args], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `build-packs failed:\n${r.stderr}\n${r.stdout}`);
}

const fake = (name: string, hex: string, extra: Partial<BuiltPack> = {}): BuiltPack => ({
  name,
  file: `/some/dir/${name}.cpet`,
  bytes: 1234,
  entries: 6,
  sha256: hex,
  integrity: integrityFromHex(hex),
  model: name.startsWith("duyu") ? "duyu-small" : "antalia-mini",
  variant: name.split("-").at(-1)!,
  onnxruntime: "1.30.0",
  embedsRuntime: false,
  ...extra,
});

test("manifest: entries are sorted, carry every field in a fixed order and have no timestamps", () => {
  const a = "ab".repeat(32);
  const b = "01".repeat(32);
  const packs = [fake("duyu-small-q4", a), fake("antalia-mini-int8", b, { hashedFile: "/some/dir/antalia-mini-int8.01010101.cpet" })];
  const m = buildManifest(packs);
  assert.deepEqual(m.packs.map((p) => p.name), ["antalia-mini-int8", "duyu-small-q4"]);
  assert.deepEqual(Object.keys(m.packs[0]), ["name", "file", "bytes", "sha256", "integrity", "model", "variant", "onnxruntime", "embedsRuntime", "hashedFile"]);
  assert.deepEqual(Object.keys(m.packs[1]), ["name", "file", "bytes", "sha256", "integrity", "model", "variant", "onnxruntime", "embedsRuntime"]);
  assert.equal(m.packs[0].file, "antalia-mini-int8.cpet", "relative to the manifest");
  assert.equal(m.packs[0].hashedFile, "antalia-mini-int8.01010101.cpet");
  assert.equal(m.packs[1].integrity, `sha256-${Buffer.from(a, "hex").toString("base64")}`);
  assert.equal(hashedName("antalia-mini-int8", b), "antalia-mini-int8.01010101.cpet");

  // the input order does not matter, and the text is stable
  assert.equal(manifestText(buildManifest([...packs].reverse())), manifestText(m));
  const text = manifestText(m);
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(JSON.parse(text), m);
  assert.ok(!/\b(19|20)\d\d-\d\d-\d\d/.test(text) && !/"(time|date|generated|created|built|mtime)\w*"/i.test(text), "no timestamps");
});

test("manifest: integrity strings are SRI sha256 (43 base64 chars and '=')", () => {
  assert.match(integrityFromHex(sha(new Uint8Array([1, 2, 3]))), /^sha256-[A-Za-z0-9+/]{43}=$/);
  assert.equal(integrityFromHex(sha(new Uint8Array(0))), "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
});

test("build-packs: writes a deterministic manifest that matches the pack files, and --hash-names copies", { skip: noUpstream }, async () => {
  const a = join(OUT, "a");
  const b = join(OUT, "b");
  rmSync(OUT, { recursive: true, force: true });
  run(a, "--only", "antalia-mini-int8", "--hash-names");
  run(b, "--only", "antalia-mini-int8", "--hash-names");

  // same inputs, same bytes, same manifest, byte for byte
  const file = new Uint8Array(readFileSync(join(a, "antalia-mini-int8.cpet")));
  assert.deepEqual(file, new Uint8Array(readFileSync(join(b, "antalia-mini-int8.cpet"))));
  assert.equal(readFileSync(join(a, "manifest.json"), "utf8"), readFileSync(join(b, "manifest.json"), "utf8"));

  const m: Manifest = JSON.parse(readFileSync(join(a, "manifest.json"), "utf8"));
  assert.equal(m.format, "cipetpet-packs");
  assert.equal(m.version, 1);
  assert.equal(m.packs.length, 1);
  const p = m.packs[0];
  assert.deepEqual(
    { ...p },
    {
      name: "antalia-mini-int8",
      file: "antalia-mini-int8.cpet",
      bytes: file.length,
      sha256: sha(file),
      integrity: `sha256-${createHash("sha256").update(file).digest("base64")}`,
      model: "antalia-mini",
      variant: "int8",
      onnxruntime: ortVersion,
      embedsRuntime: false,
      hashedFile: `antalia-mini-int8.${sha(file).slice(0, 8)}.cpet`,
    },
  );
  assert.equal(readFileSync(join(a, "manifest.json"), "utf8"), manifestText(m));

  // the immutable name holds the same bytes, and the manifest's integrity loads the pack
  assert.deepEqual(new Uint8Array(readFileSync(join(a, p.hashedFile!))), file);
  const pack = await openPack(file, { integrity: p.integrity });
  assert.equal(pack.model.id, p.model);
  assert.equal(pack.model.variant, p.variant);
  assert.equal(pack.header.runtime?.onnxruntime, p.onnxruntime);
  assert.deepEqual(readdirSync(a).sort(), [p.hashedFile, p.file, "manifest.json"].sort());

  // without --hash-names there is no hashed file and no hashedFile field
  const c = join(OUT, "c");
  run(c, "--only", "antalia-mini-int8");
  const mc: Manifest = JSON.parse(readFileSync(join(c, "manifest.json"), "utf8"));
  assert.equal("hashedFile" in mc.packs[0], false);
  assert.deepEqual(readdirSync(c).sort(), ["antalia-mini-int8.cpet", "manifest.json"]);
  assert.deepEqual(new Uint8Array(readFileSync(join(c, "antalia-mini-int8.cpet"))), file, "--hash-names does not change the pack");
});

test("build-packs: --only updates its entries in an existing manifest and keeps the others", { skip: noUpstream }, () => {
  const out = join(OUT, "merge");
  rmSync(out, { recursive: true, force: true });
  run(out, "--only", "antalia-mini-int8");
  run(out, "--only", "antalia-mini-fp16");
  const m: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.deepEqual(m.packs.map((p) => p.name), ["antalia-mini-fp16", "antalia-mini-int8"]);
  const before = readFileSync(join(out, "manifest.json"), "utf8");
  run(out, "--only", "antalia-mini-int8"); // rebuilding changes nothing
  assert.equal(readFileSync(join(out, "manifest.json"), "utf8"), before);
  for (const p of m.packs) assert.equal(sha(new Uint8Array(readFileSync(join(out, p.file)))), p.sha256);
});

test("build-packs: --embed-runtime is recorded in the manifest", { skip: noUpstream }, async () => {
  const out = join(OUT, "embed");
  rmSync(out, { recursive: true, force: true });
  run(out, "--only", "antalia-mini-int8", "--embed-runtime");
  const m: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(m.packs[0].embedsRuntime, true);
  const pack = await openPack(new Uint8Array(readFileSync(join(out, m.packs[0].file))), { integrity: m.packs[0].integrity });
  assert.ok(pack.has("runtime/ort-wasm-simd-threaded.wasm"));
  assert.ok(m.packs[0].bytes > 20_000_000);
  rmSync(OUT, { recursive: true, force: true });
});
