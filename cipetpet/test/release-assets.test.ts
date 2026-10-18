// tools/release-assets.ts: the files of a GitHub Release, assembled from a (here: tiny, synthetic) packs/ directory.
// No network, no browser, no real models.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { assembleRelease, assetTable, digestText, noticeText, notesTemplate, ORT_FILES, renderNotes, ReleaseError, type ReleaseManifest } from "../tools/release-assets.js";
import { FAKE_ORT_VERSION, makeRelease, ROOT, TEST_OUT, writeFakeOrt, writeFakePacks, type SyntheticRelease } from "./helpers/synthetic-release.js";

const WORK = join(TEST_OUT, `release-assets-${process.pid}`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const readDir = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, sha(readFileSync(join(dir, f)))]));

let rel: SyntheticRelease;
before(async () => {
  rel = await makeRelease(join(WORK, "a"));
});
after(() => rmSync(WORK, { recursive: true, force: true }));

describe("release-assets", () => {
  test("writes flat files: packs, the four ORT files, manifest, SHA256SUMS, LICENSE, NOTICE", () => {
    const files = readdirSync(join(rel.work, "release")).sort();
    assert.deepEqual(files, [
      "LICENSE",
      "NOTICE",
      "SHA256SUMS",
      "antalia-mini-int8.cpet",
      "cipetpet-release.json",
      "duyu-small-int8.cpet",
      "duyu-small-q4.cpet",
      ...ORT_FILES.map((f) => f.name),
    ].sort());
    // the library loads ort-wasm-simd-threaded.* (backend wasm) and the asyncify build (backend webgpu), nothing else
    assert.deepEqual(ORT_FILES.map((f) => f.name).sort(), [
      "ort-wasm-simd-threaded.asyncify.mjs",
      "ort-wasm-simd-threaded.asyncify.wasm",
      "ort-wasm-simd-threaded.mjs",
      "ort-wasm-simd-threaded.wasm",
    ]);
  });

  test("cipetpet-release.json: version, ortVersion, sorted assets with kind, model, variant, integrity", () => {
    const text = readFileSync(join(rel.work, "release/cipetpet-release.json"), "utf8");
    assert.ok(text.endsWith("}\n"));
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), "no timestamps");
    const m = JSON.parse(text) as ReleaseManifest;
    assert.equal(m.format, 1);
    assert.equal(m.version, "0.1.0");
    assert.equal(m.ortVersion, FAKE_ORT_VERSION);
    assert.equal(m.generator, "cipetpet/tools/release-assets.ts");
    assert.deepEqual(Object.keys(m), ["format", "version", "ortVersion", "generator", "assets"]);
    const names = m.assets.map((a) => a.name);
    assert.deepEqual(names, [...names].sort());
    const byName = new Map(m.assets.map((a) => [a.name, a]));
    const pack = byName.get("duyu-small-q4.cpet")!;
    assert.equal(pack.kind, "pack");
    assert.equal(pack.model, "duyu-small");
    assert.equal(pack.variant, "q4");
    const bytes = readFileSync(join(rel.work, "release/duyu-small-q4.cpet"));
    assert.equal(pack.bytes, bytes.byteLength);
    assert.equal(pack.sha256, sha(bytes));
    assert.equal(pack.integrity, `sha256-${Buffer.from(pack.sha256, "hex").toString("base64")}`);
    const wasm = byName.get("ort-wasm-simd-threaded.wasm")!;
    assert.equal(wasm.kind, "ort");
    assert.equal(wasm.backend, "wasm");
    assert.equal(byName.get("ort-wasm-simd-threaded.asyncify.wasm")!.backend, "webgpu");
    assert.equal(byName.get("LICENSE")!.kind, "doc");
    assert.equal(byName.get("NOTICE")!.kind, "doc");
    assert.ok(!byName.has("SHA256SUMS") && !byName.has("cipetpet-release.json"), "the manifest does not list itself or SHA256SUMS");
    for (const a of m.assets) assert.equal(a.sha256, sha(readFileSync(join(rel.work, "release", a.name))), a.name);
  });

  test("ORT files are byte-identical to the onnxruntime-web files", () => {
    for (const f of ORT_FILES) {
      assert.deepEqual(readFileSync(join(rel.work, "release", f.name)), readFileSync(join(rel.ortDir, "dist", f.name)), f.name);
    }
  });

  test("SHA256SUMS is `sha256sum -c` input: LF only, sorted, one line per file, no self entry", () => {
    const text = readFileSync(join(rel.work, "release/SHA256SUMS"), "utf8");
    assert.ok(!text.includes("\r"));
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
    const lines = text.trimEnd().split("\n");
    for (const l of lines) assert.match(l, /^[0-9a-f]{64} {2}[A-Za-z0-9._-]+$/);
    const names = lines.map((l) => l.slice(66));
    assert.deepEqual(names, [...names].sort());
    assert.ok(!names.includes("SHA256SUMS"));
    assert.deepEqual(names, readdirSync(join(rel.work, "release")).filter((f) => f !== "SHA256SUMS").sort());
    for (const l of lines) assert.equal(l.slice(0, 64), sha(readFileSync(join(rel.work, "release", l.slice(66)))), l);
  });

  test("SHA256SUMS passes `shasum -a 256 -c` (when shasum or sha256sum exists)", (t) => {
    const tool = ["sha256sum", "shasum"].map((c) => ({ c, r: spawnSync(c, ["--version"]) })).find((x) => !x.r.error);
    if (!tool) return t.skip("neither sha256sum nor shasum found");
    const args = tool.c === "shasum" ? ["-a", "256", "-c", "SHA256SUMS"] : ["-c", "SHA256SUMS"];
    const r = spawnSync(tool.c, args, { cwd: join(rel.work, "release"), encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test("LICENSE is the Apache-2.0 text; NOTICE credits the models, balbal and ONNX Runtime (MIT)", () => {
    const dir = join(rel.work, "release");
    assert.deepEqual(readFileSync(join(dir, "LICENSE")), readFileSync(join(ROOT, "LICENSE")));
    assert.match(readFileSync(join(dir, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
    const notice = readFileSync(join(dir, "NOTICE"), "utf8");
    for (const s of ["Antalia-2 Mini", "PatientDesk AI", "Duyu-small", "KaanAydinli", "balbal", `ONNX Runtime ${FAKE_ORT_VERSION}`, "Microsoft Corporation", "Permission is hereby granted"]) {
      assert.ok(notice.includes(s), s);
    }
    assert.ok(!notice.includes("\r"));
    // a LICENSE file shipped by the package wins over the built-in text
    assert.ok(noticeText("1.0.0", "MY LICENSE TEXT\r\n").includes("  MY LICENSE TEXT\n"));
    // EMA Lightning (and normalizer-tr) are credited only when the release ships one of its packs
    assert.equal(noticeText("1.0.0", undefined, ["antalia-mini", "duyu-small"]), noticeText("1.0.0"));
    assert.doesNotMatch(noticeText("1.0.0"), /EMA Lightning/);
    assert.match(noticeText("1.0.0", undefined, ["ema-lightning"]), /EMA Lightning \(ema-lightning-\*\.cpet\)[\s\S]*normalizer-tr by Erdem Tuna/);
  });

  test("running twice gives byte-identical output (also from a second packs directory with the same content)", async () => {
    const again = await makeRelease(join(WORK, "b"));
    assert.deepEqual(readDir(join(again.work, "release")), readDir(join(rel.work, "release")));
    assert.equal(again.manifestText, rel.manifestText);
    assert.equal(again.sumsText, rel.sumsText);
  });

  test("a version can be given; the manifest records it", async () => {
    const v = await makeRelease(join(WORK, "v"), "2.3.4-rc.1");
    assert.equal((JSON.parse(v.manifestText) as ReleaseManifest).version, "2.3.4-rc.1");
    assert.throws(() => assembleRelease({ packsDir: v.packsDir, outDir: join(v.work, "o2"), version: "v1", ortDir: v.ortDir }), /bad version/);
  });

  test("a corrupted pack (hash differs from packs/manifest.json) stops the release and writes nothing", async () => {
    const work = join(WORK, "corrupt");
    const r = await makeRelease(work);
    const file = join(r.packsDir, "duyu-small-int8.cpet");
    const data = readFileSync(file);
    data[data.length - 3] ^= 0xff; // same size, different content
    writeFileSync(file, data);
    const out = join(work, "out2");
    assert.throws(() => assembleRelease({ packsDir: r.packsDir, outDir: out, ortDir: r.ortDir }), (e) => e instanceof ReleaseError && /duyu-small-int8\.cpet.*SHA-256 mismatch/.test(e.message));
    assert.throws(() => readdirSync(out), "the output directory was not even created");
    // a truncated pack and a missing pack are caught as well
    writeFileSync(file, data.subarray(0, data.length - 10));
    assert.throws(() => assembleRelease({ packsDir: r.packsDir, outDir: out, ortDir: r.ortDir }), /bytes on disk/);
    rmSync(file);
    assert.throws(() => assembleRelease({ packsDir: r.packsDir, outDir: out, ortDir: r.ortDir }), /missing/);
  });

  test("packs built for another onnxruntime version are refused", async () => {
    const work = join(WORK, "ortver");
    await writeFakePacks(join(work, "packs"), "7.7.7");
    writeFakeOrt(join(work, "ort"), "8.0.0");
    assert.throws(
      () => assembleRelease({ packsDir: join(work, "packs"), outDir: join(work, "out"), ortDir: join(work, "ort") }),
      /built for onnxruntime 7\.7\.7.*onnxruntime-web 8\.0\.0/,
    );
  });

  test("a missing ORT file or packs manifest is an error", async () => {
    const work = join(WORK, "missing");
    const r = await makeRelease(work);
    rmSync(join(r.ortDir, "dist/ort-wasm-simd-threaded.asyncify.wasm"));
    assert.throws(() => assembleRelease({ packsDir: r.packsDir, outDir: join(work, "o"), ortDir: r.ortDir }), /asyncify\.wasm not found/);
    assert.throws(() => assembleRelease({ packsDir: join(work, "nope"), outDir: join(work, "o"), ortDir: r.ortDir }), /manifest\.json not found/);
  });

  test("refuses a non-empty output directory without --force; --force only replaces a previous release", async () => {
    const work = join(WORK, "force");
    const r = await makeRelease(work);
    const out = join(work, "release");
    assert.throws(() => assembleRelease({ packsDir: r.packsDir, outDir: out, version: "0.1.0", ortDir: r.ortDir }), /not empty; pass --force/);
    // a stale file of the previous release disappears with --force
    writeFileSync(join(out, "stale.cpet"), "x");
    assembleRelease({ packsDir: r.packsDir, outDir: out, version: "0.1.0", ortDir: r.ortDir, force: true });
    assert.ok(!readdirSync(out).includes("stale.cpet"));
    assert.deepEqual(readDir(out), readDir(join(rel.work, "release")));
    // --force never empties a directory that is not a release (no cipetpet-release.json in it)
    const other = join(work, "documents");
    mkdirSync(other);
    writeFileSync(join(other, "precious.txt"), "keep");
    assert.throws(() => assembleRelease({ packsDir: r.packsDir, outDir: other, ortDir: r.ortDir, force: true }), /does not look like a previous release/);
    assert.equal(readFileSync(join(other, "precious.txt"), "utf8"), "keep");
    // nor the packs directory itself
    assert.throws(() => assembleRelease({ packsDir: r.packsDir, outDir: r.packsDir, ortDir: r.ortDir, force: true }), /must not contain each other/);
  });

  test("an empty existing output directory is fine", async () => {
    const work = join(WORK, "empty");
    const r = await makeRelease(work);
    const out = join(work, "empty-out");
    mkdirSync(out);
    assembleRelease({ packsDir: r.packsDir, outDir: out, ortDir: r.ortDir });
    assert.equal(readdirSync(out).length, 11);
  });

  test("release notes: the RELEASES.md template filled with the asset table", async () => {
    const doc = readFileSync(join(ROOT, "RELEASES.md"), "utf8");
    const tpl = notesTemplate(doc);
    for (const p of ["{{TAG}}", "{{VERSION}}", "{{ASSET_TABLE}}", "{{ORT_VERSION}}", "{{REPO}}"]) assert.ok(tpl.includes(p), `template has ${p}`);
    const work = join(WORK, "notes");
    const r = await makeRelease(work, "0.2.0");
    const notesPath = join(work, "notes.md");
    assembleRelease({ packsDir: r.packsDir, outDir: join(work, "o"), version: "0.2.0", ortDir: r.ortDir, notesPath });
    const notes = readFileSync(notesPath, "utf8");
    assert.ok(!/\{\{/.test(notes));
    assert.ok(notes.includes("v0.2.0") && notes.includes(r.ortVersion));
    assert.ok(notes.includes(assetTable(r.assets)));
    assert.match(notes, /\| `antalia-mini-int8\.cpet` \| antalia-mini int8 pack \| [\d,]+ \| [\d.]+ MiB \| `[0-9a-f]{64}` \|/);
    assert.throws(() => renderNotes("{{NOPE}}", { tag: "v1", version: "1", ortVersion: "1", repo: "a/b", table: "" }), /unknown placeholder/);
    assert.throws(() => notesTemplate("no markers"), /no <!-- release-notes:start -->/);
  });

  test("digestText: version and the SHA-256 of the manifest text, nothing else", () => {
    const d = JSON.parse(digestText("1.2.3", rel.manifestText));
    assert.deepEqual(d, { format: 1, version: "1.2.3", manifestSha256: sha(Buffer.from(rel.manifestText)) });
    assert.equal(d.manifestSha256, sha(readFileSync(join(rel.work, "release/cipetpet-release.json"))));
    assert.ok(digestText("1.2.3", rel.manifestText).endsWith("}\n"));
  });

  test("the command line (real node_modules/onnxruntime-web) prints a table; errors are one line and exit 1", async () => {
    const work = join(WORK, "cli");
    const realOrt = JSON.parse(readFileSync(join(ROOT, "node_modules/onnxruntime-web/package.json"), "utf8")).version as string;
    await writeFakePacks(join(work, "packs"), realOrt);
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "tools/release-assets.ts"), ...args], { cwd: ROOT, encoding: "utf8" });
    const out = join(work, "cli-out");
    const ok = run("--packs", join(work, "packs"), "--out", out, "--version", "0.1.0");
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`^release 0\\.1\\.0 \\(onnxruntime-web ${realOrt.replace(/\./g, "\\.")}\\)`));
    assert.match(ok.stdout, /^ort-wasm-simd-threaded\.wasm +ort +[\d.]+ MiB +[0-9a-f]{64}$/m);
    assert.match(ok.stdout, /^cipetpet-release\.json +manifest /m);
    assert.match(ok.stdout, /14 files|11 files/);
    const manifestSha = sha(readFileSync(join(out, "cipetpet-release.json")));
    assert.ok(ok.stdout.includes(`cipetpet-release.json sha256: ${manifestSha}`), "the manifest digest is printed");
    // --digest writes the file that goes into the npm package (bin/release-digest.json)
    const digestFile = join(work, "digest/release-digest.json");
    const withDigest = run("--packs", join(work, "packs"), "--out", out, "--force", "--digest", digestFile);
    assert.equal(withDigest.status, 0, withDigest.stderr);
    assert.deepEqual(JSON.parse(readFileSync(digestFile, "utf8")), { format: 1, version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version, manifestSha256: manifestSha });
    const again = run("--packs", join(work, "packs"), "--out", out);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /^release-assets: .* is not empty; pass --force/m);
    assert.equal(again.stderr.trim().split("\n").length, 1, "one line");
    assert.equal(run("--packs", join(work, "packs"), "--out", out, "--force").status, 0);
    // the synthetic packs above were built for the real ORT version; the fake 7.7.7 ones are refused
    await writeFakePacks(join(work, "packs7"), "7.7.7");
    const bad = run("--packs", join(work, "packs7"), "--out", join(work, "o7"));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /built for onnxruntime 7\.7\.7, node_modules has onnxruntime-web /);
    const unknown = run("--nope");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown argument --nope/);
  });
});
