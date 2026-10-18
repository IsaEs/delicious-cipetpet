// bin/cipetpet.mjs (pull, verify) run as a child process against a local mock of GitHub: release downloads that
// 302 to a second path on another origin (like release-assets.githubusercontent.com), Range ignored, no HEAD, and
// a small API. The release is a synthetic one made with the real tools/release-assets.ts. No network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { FAKE_ORT_VERSION, makeRelease, ROOT, TEST_OUT, writeFakeOrt, type SyntheticRelease } from "./helpers/synthetic-release.js";
import { makeCert } from "./helpers/tls.js";

const WORK = join(TEST_OUT, `pull-cli-${process.pid}`);
// The CLI runs from a copy with its package.json but WITHOUT bin/release-digest.json. A maintainer who made the real digest for
// a release (RELEASES.md, "for maintainers") would otherwise turn every synthetic release below, which is also version 0.1.0,
// into a digest mismatch (exit 3). The test that needs a digest makes its own copy of the CLI.
const CLI_PKG = join(TEST_OUT, `pull-cli-bin-${process.pid}`);
const INSTALLED = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
mkdirSync(join(CLI_PKG, "bin"), { recursive: true });
copyFileSync(join(ROOT, "bin/cipetpet.mjs"), join(CLI_PKG, "bin/cipetpet.mjs"));
copyFileSync(join(ROOT, "package.json"), join(CLI_PKG, "package.json"));
const CLI = join(CLI_PKG, "bin/cipetpet.mjs");

interface Hit {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

let rel: SyntheticRelease;
let files: Map<string, Buffer>; // release file name -> body served
let server: Server;
let port = 0;
let hits: Hit[] = [];
let behaviours: Map<string, (req: IncomingMessage, res: ServerResponse) => void>;

const base = () => `http://127.0.0.1:${port}/dl/`;
const otherOrigin = () => `http://localhost:${port}`; // same server, other origin: stands in for the CDN host
const assetHits = () => hits.filter((h) => (h.path.startsWith("/dl/") && !h.path.endsWith("cipetpet-release.json")) || h.path.startsWith("/cdn/"));

function handle(req: IncomingMessage, res: ServerResponse): unknown {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  hits.push({ method: req.method ?? "", path: url.pathname, headers: req.headers });
  const custom = behaviours.get(url.pathname);
  if (custom) return custom(req, res);
  const send = (status: number, body: string | Buffer, type = "application/octet-stream") => {
    res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
    res.end(body); // a Range request header is simply ignored
  };
  if (req.method === "HEAD") return send(405, "");
  // GitHub has the tag v0.1.0, and one for the installed version (the default tag), both with the synthetic release
  const dl = new RegExp(`^/(?:dl|gh/o/r/releases/download/(v0\\.1\\.0|v${INSTALLED.replace(/\./g, "\\.")}))/([^/]+)$`).exec(url.pathname);
  if (dl) {
    dl[1] = dl[2];
    if (!files.has(dl[1])) return send(404, "not found", "text/plain");
    if (dl[1] === "cipetpet-release.json") return send(200, files.get(dl[1])!, "application/json");
    // like github.com: 302 to a signed URL on another host, with its own path
    res.writeHead(302, { location: `${otherOrigin()}/cdn/abc123/${dl[1]}?sig=xyz` });
    return res.end();
  }
  const cdn = /^\/cdn\/abc123\/([^/]+)$/.exec(url.pathname);
  if (cdn && files.has(cdn[1])) return send(200, files.get(cdn[1])!);
  if (url.pathname === "/api/repos/o/r/releases/latest") return send(200, JSON.stringify({ tag_name: "v0.1.0" }), "application/json");
  if (url.pathname === "/api/repos/o/r/releases") return send(200, JSON.stringify([{ tag_name: "v0.1.0" }, { tag_name: "v0.0.9" }]), "application/json");
  if (url.pathname === "/redirected-api/latest") return send(200, JSON.stringify({ tag_name: "v0.1.0" }), "application/json");
  send(404, "not found", "text/plain");
}

before(async () => {
  rel = await makeRelease(join(WORK, "src"));
  server = createServer(handle);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  await new Promise((ok) => server.close(ok));
  rmSync(WORK, { recursive: true, force: true });
  rmSync(CLI_PKG, { recursive: true, force: true });
});
beforeEach(() => {
  files = new Map(readdirSync(join(rel.work, "release")).map((f) => [f, readFileSync(join(rel.work, "release", f))]));
  behaviours = new Map();
  hits = [];
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], opts: { cwd?: string; env?: Record<string, string>; script?: string } = {}): Promise<Run> {
  return new Promise((ok, fail) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...opts.env };
    const child = spawn(process.execPath, [opts.script ?? CLI, ...args], { cwd: opts.cwd ?? WORK, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (code) => ok({ code, stdout, stderr }));
  });
}

let n = 0;
/** a fresh consumer project folder; the pull target is <project>/public/cipetpet */
function project(): { cwd: string; dir: string } {
  const cwd = join(WORK, `p${n++}`);
  mkdirSync(cwd, { recursive: true });
  return { cwd, dir: join(cwd, "public/cipetpet") };
}

const listing = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
        .sort();
const noPartFiles = (dir: string) => assert.deepEqual(listing(dir).filter((f) => f.includes(".part")), [], "no .part files left");
const pull = (p: { cwd: string }, ...extra: string[]) => cli(["pull", "--base-url", base(), "--tag", "v0.1.0", ...extra], { cwd: p.cwd });

describe("cipetpet pull", () => {
  test("happy path: default packs, ORT files and docs land in the documented layout; redirects are followed", async () => {
    const p = project();
    const r = await pull(p);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(listing(p.dir), [
      "LICENSE",
      "NOTICE",
      "antalia-mini-int8.cpet",
      "cipetpet-release.json",
      "duyu-small-int8.cpet",
      "ort/ort-wasm-simd-threaded.mjs",
      "ort/ort-wasm-simd-threaded.wasm",
    ]);
    for (const f of ["antalia-mini-int8.cpet", "duyu-small-int8.cpet", "LICENSE"]) assert.deepEqual(readFileSync(join(p.dir, f)), files.get(f), f);
    assert.deepEqual(readFileSync(join(p.dir, "ort/ort-wasm-simd-threaded.wasm")), files.get("ort-wasm-simd-threaded.wasm"));
    assert.deepEqual(readFileSync(join(p.dir, "cipetpet-release.json")), files.get("cipetpet-release.json"), "the manifest is stored as published");
    assert.ok(hits.some((h) => h.path.startsWith("/cdn/abc123/antalia-mini-int8.cpet")), "followed the 302 to the second path");
    assert.ok(hits.every((h) => h.method === "GET"), "no HEAD needed");
    assert.match(r.stdout, /AntaliaMini\.load\("\/cipetpet\/antalia-mini-int8\.cpet", \{ wasmPaths: "\/cipetpet\/ort\/" \}\)/);
    assert.match(r.stdout, /DuyuSmall\.load\("\/cipetpet\/duyu-small-int8\.cpet", \{ wasmPaths: "\/cipetpet\/ort\/" \}\)/);
    assert.match(r.stdout, /import \{ AntaliaMini, DuyuSmall \} from "cipetpet";/);
    assert.match(r.stdout, /cipetpet verify --dir public\/cipetpet/);
    noPartFiles(p.dir);
  });

  test("a folder outside public/ gets a note instead of a made-up URL", async () => {
    const p = project();
    const r = await pull(p, "--dir", "static/models", "--no-ort", "--no-docs");
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listing(join(p.cwd, "static/models")), ["antalia-mini-int8.cpet", "cipetpet-release.json", "duyu-small-int8.cpet"]);
    assert.match(r.stdout, /not inside a "public" folder/);
    assert.match(r.stdout, new RegExp(`wasmPaths: "https://cdn\\.jsdelivr\\.net/npm/onnxruntime-web@${FAKE_ORT_VERSION.replace(/\./g, "\\.")}/dist/"`), "--no-ort: the snippet says where ORT comes from");
    assert.ok(!r.stdout.includes('wasmPaths: "/'), "no pulled ORT folder is claimed");
    const nested = project();
    const r2 = await pull(nested, "--dir", "app/public/models/cipetpet", "--no-ort", "--no-docs", "--packs", "duyu-small-q4");
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stdout, /DuyuSmall\.load\("\/models\/cipetpet\/duyu-small-q4\.cpet", \{ wasmPaths: "https:\/\/cdn\.jsdelivr\.net\//);
  });

  test("--packs, --models, --webgpu and --no-docs choose the files", async () => {
    const p = project();
    const r = await pull(p, "--packs", "duyu-small-q4.cpet,antalia-mini-int8", "--webgpu", "--no-docs");
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listing(p.dir), [
      "antalia-mini-int8.cpet",
      "cipetpet-release.json",
      "duyu-small-q4.cpet",
      "ort/ort-wasm-simd-threaded.asyncify.mjs",
      "ort/ort-wasm-simd-threaded.asyncify.wasm",
      "ort/ort-wasm-simd-threaded.mjs",
      "ort/ort-wasm-simd-threaded.wasm",
    ]);
    const m = project();
    const r2 = await pull(m, "--models", "duyu", "--no-ort", "--no-docs");
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(listing(m.dir), ["cipetpet-release.json", "duyu-small-int8.cpet"]);
    const bad = await pull(project(), "--packs", "nope");
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /pack "nope" is not in this release \(available: antalia-mini-int8, duyu-small-int8, duyu-small-q4\)/);
    const badModel = await pull(project(), "--models", "whisper");
    assert.equal(badModel.code, 1);
  });

  test("files that are already there with the right hash are skipped (and a repeat works with no server at all)", async () => {
    const p = project();
    assert.equal((await pull(p)).code, 0);
    hits = [];
    const again = await pull(p);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(assetHits().length, 0, "only the manifest was requested");
    assert.match(again.stdout, /ok +antalia-mini-int8\.cpet +\(already there/);
    assert.match(again.stdout, /0 file\(s\) written/);
    // nothing listens on that port any more: the local manifest says what the files must be
    const dead = createServer();
    await new Promise<void>((ok) => dead.listen(0, "127.0.0.1", ok));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise((ok) => dead.close(ok));
    const offline = await cli(["pull", "--base-url", `http://127.0.0.1:${deadPort}/dl/`, "--tag", "v0.1.0"], { cwd: p.cwd });
    assert.equal(offline.code, 0, offline.stdout + offline.stderr);
    assert.match(offline.stdout, /offline .*using .*cipetpet-release\.json/);
    // ... but a missing file cannot come from nowhere: exit 2 with a way out
    rmSync(join(p.dir, "duyu-small-int8.cpet"));
    const missing = await cli(["pull", "--base-url", `http://127.0.0.1:${deadPort}/dl/`, "--tag", "v0.1.0"], { cwd: p.cwd });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /offline and missing or changed: duyu-small-int8\.cpet/);
    assert.match(missing.stderr, /--ort-from-node-modules/);
    assert.match(missing.stderr, /--base-url/);
  });

  test("a changed file is replaced; --force downloads everything again", async () => {
    const p = project();
    assert.equal((await pull(p, "--no-ort", "--no-docs")).code, 0);
    writeFileSync(join(p.dir, "antalia-mini-int8.cpet"), "tampered");
    hits = [];
    const fixed = await pull(p, "--no-ort", "--no-docs");
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.match(fixed.stdout, /downloaded +antalia-mini-int8\.cpet .*replaces a file with a different hash/);
    assert.deepEqual(readFileSync(join(p.dir, "antalia-mini-int8.cpet")), files.get("antalia-mini-int8.cpet"));
    assert.equal(hits.filter((h) => h.path.startsWith("/cdn/")).length, 1, "only the changed file was fetched");
    hits = [];
    const forced = await pull(p, "--no-ort", "--no-docs", "--force");
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(hits.filter((h) => h.path.startsWith("/cdn/")).length, 2, "--force fetches both packs again");
  });

  test("hash mismatch: exit 3, the file is not in place and no .part is left", async () => {
    const p = project();
    const bad = Buffer.from(files.get("duyu-small-int8.cpet")!);
    bad[100] ^= 1; // same length, other content
    files.set("duyu-small-int8.cpet", bad);
    const r = await pull(p);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /^cipetpet: duyu-small-int8\.cpet: SHA-256 mismatch/m);
    assert.ok(!existsSync(join(p.dir, "duyu-small-int8.cpet")));
    assert.ok(!existsSync(join(p.dir, "cipetpet-release.json")), "the manifest is written only after every file passed");
    noPartFiles(p.dir);
    // a good file that was already there is kept, a bad download never replaces it
    const q = project();
    assert.equal((await pull(q, "--packs", "antalia-mini-int8", "--no-ort", "--no-docs")).code, 0);
    const bad2 = Buffer.from(files.get("antalia-mini-int8.cpet")!);
    bad2[10] ^= 1;
    files.set("antalia-mini-int8.cpet", bad2);
    writeFileSync(join(q.dir, "antalia-mini-int8.cpet"), "old");
    const r2 = await pull(q, "--packs", "antalia-mini-int8", "--no-ort", "--no-docs");
    assert.equal(r2.code, 3);
    assert.equal(readFileSync(join(q.dir, "antalia-mini-int8.cpet"), "utf8"), "old", "an existing file is untouched by a failed download");
    noPartFiles(q.dir);
  });

  test("truncated body (connection cut) -> exit 2; short chunked body -> exit 3; longer body -> exit 3; none leaves files", async () => {
    const full = files.get("duyu-small-int8.cpet")!;
    behaviours.set("/cdn/abc123/duyu-small-int8.cpet", (_req, res) => {
      res.writeHead(200, { "content-length": full.length });
      res.write(full.subarray(0, 1000));
      setTimeout(() => res.destroy(), 20);
    });
    const p = project();
    const cut = await pull(p, "--packs", "duyu-small-int8", "--no-ort", "--no-docs");
    assert.equal(cut.code, 2, cut.stdout + cut.stderr);
    assert.match(cut.stderr, /download interrupted|terminated|closed/i);
    assert.deepEqual(listing(p.dir), []);

    behaviours.set("/cdn/abc123/duyu-small-int8.cpet", (_req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.end(full.subarray(0, full.length - 7));
    });
    const short = await pull(p, "--packs", "duyu-small-int8", "--no-ort", "--no-docs");
    assert.equal(short.code, 3);
    assert.match(short.stderr, new RegExp(`got ${full.length - 7} bytes, the manifest says ${full.length}`));
    assert.deepEqual(listing(p.dir), []);

    behaviours.set("/cdn/abc123/duyu-small-int8.cpet", (_req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.end(Buffer.concat([full, Buffer.alloc(50)]));
    });
    const long = await pull(p, "--packs", "duyu-small-int8", "--no-ort", "--no-docs");
    assert.equal(long.code, 3);
    assert.match(long.stderr, /more than the \d+ bytes the manifest lists/);
    assert.deepEqual(listing(p.dir), []);

    behaviours.set("/cdn/abc123/duyu-small-int8.cpet", (_req, res) => {
      res.writeHead(200, { "content-length": full.length + 5 });
      res.end(Buffer.concat([full, Buffer.alloc(5)]));
    });
    const announced = await pull(p, "--packs", "duyu-small-int8", "--no-ort", "--no-docs");
    assert.equal(announced.code, 3);
    assert.match(announced.stderr, /announces \d+ bytes, the manifest says/);
    assert.deepEqual(listing(p.dir), []);
  });

  test("timeouts: a server that never answers, and one that stops sending, end in exit 2 (CIPETPET_TIMEOUT_MS)", async () => {
    const env = { CIPETPET_TIMEOUT_MS: "400" };
    const full = files.get("duyu-small-int8.cpet")!;
    // no response headers at all (connect/header timeout)
    behaviours.set("/dl/cipetpet-release.json", () => {});
    const t0 = Date.now();
    const none = await cli(["pull", "--base-url", base(), "--tag", "v0.1.0"], { cwd: project().cwd, env });
    assert.equal(none.code, 2, none.stderr);
    assert.match(none.stderr, /cannot reach 127\.0\.0\.1:\d+: timed out/);
    assert.ok(Date.now() - t0 < 5000, "gave up quickly");
    behaviours.delete("/dl/cipetpet-release.json");
    // headers and some bytes, then silence (idle timeout)
    behaviours.set("/cdn/abc123/duyu-small-int8.cpet", (_req, res) => {
      res.writeHead(200, { "content-length": full.length });
      res.write(full.subarray(0, 500));
    });
    const p = project();
    const stall = await cli(["pull", "--base-url", base(), "--tag", "v0.1.0", "--packs", "duyu-small-int8", "--no-ort", "--no-docs"], { cwd: p.cwd, env });
    assert.equal(stall.code, 2, stall.stderr);
    assert.match(stall.stderr, /timed out \(download interrupted\)/);
    assert.deepEqual(listing(p.dir), []);
  });

  test("HTTP errors: 404 on the manifest names the URL; 500 on a pack is exit 2", async () => {
    const p = project();
    files.delete("cipetpet-release.json");
    const r = await pull(p);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /HTTP 404 from http:\/\/127\.0\.0\.1:\d+\/dl\/cipetpet-release\.json/);
    assert.deepEqual(listing(p.dir), []);
    files.set("cipetpet-release.json", readFileSync(join(rel.work, "release/cipetpet-release.json")));
    behaviours.set("/cdn/abc123/antalia-mini-int8.cpet", (_req, res) => {
      res.writeHead(500);
      res.end("oops");
    });
    const r2 = await pull(p, "--no-ort", "--no-docs");
    assert.equal(r2.code, 2);
    assert.match(r2.stderr, /antalia-mini-int8\.cpet: HTTP 500/);
    noPartFiles(p.dir);
  });

  test("a tag without a release: exit 2, and the existing tags are listed when the API answers", async () => {
    const p = project();
    const env = { CIPETPET_GITHUB_API: `http://127.0.0.1:${port}/api/`, CIPETPET_GITHUB_URL: `http://127.0.0.1:${port}/gh` };
    const r = await cli(["pull", "--repo", "o/r", "--tag", "v9.9.9"], { cwd: p.cwd, env });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /release v9\.9\.9 of o\/r not found\. Existing releases: v0\.1\.0, v0\.0\.9\./);
    assert.deepEqual(listing(p.dir), []);
    // API down: still exit 2 with a plain message
    const r2 = await cli(["pull", "--repo", "o/r", "--tag", "v9.9.9"], { cwd: p.cwd, env: { ...env, CIPETPET_GITHUB_API: "http://127.0.0.1:1/api/" } });
    assert.equal(r2.code, 2);
    assert.match(r2.stderr, /not found\. \(the GitHub API did not answer/);
  });

  test("--tag latest resolves through the API; the default tag is the installed version", async () => {
    const p = project();
    const env = { CIPETPET_GITHUB_API: `http://127.0.0.1:${port}/api/`, CIPETPET_GITHUB_URL: `http://127.0.0.1:${port}/gh` };
    const r = await cli(["pull", "--repo", "o/r", "--tag", "latest", "--no-ort", "--no-docs", "--packs", "antalia-mini-int8"], { cwd: p.cwd, env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /latest release of o\/r: v0\.1\.0/);
    assert.ok(hits.some((h) => h.path === "/gh/o/r/releases/download/v0.1.0/cipetpet-release.json"));
    const q = project();
    hits = [];
    const d = await cli(["pull", "--repo", "o/r", "--no-ort", "--no-docs", "--packs", "antalia-mini-int8"], { cwd: q.cwd, env });
    const installed = INSTALLED;
    assert.ok(hits.some((h) => h.path === `/gh/o/r/releases/download/v${installed}/cipetpet-release.json`), `asked for v${installed}`);
    // the synthetic release is version 0.1.0: under another installed version's tag it is refused as a mismatch
    if (installed === "0.1.0") assert.equal(d.code, 0, d.stderr);
    else {
      assert.equal(d.code, 3, d.stdout + d.stderr);
      assert.match(d.stderr, new RegExp(`is for cipetpet 0\\.1\\.0, not ${installed.replace(/\./g, "\\.")}`));
    }
    // --base-url disables the API, so "latest" cannot be resolved
    const bad = await cli(["pull", "--base-url", base(), "--tag", "latest"], { cwd: q.cwd });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--tag latest needs the GitHub API/);
  });

  test("a manifest for another version than the tag is an integrity failure", async () => {
    const r = await cli(["pull", "--base-url", base(), "--tag", "v0.2.0"], { cwd: project().cwd });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /is for cipetpet 0\.1\.0, not 0\.2\.0/);
  });

  test("redirect loop: capped at 5 redirects, exit 2", async () => {
    behaviours.set("/dl/duyu-small-int8.cpet", (req, res) => {
      res.writeHead(302, { location: `${req.headers.host ? "http://" + req.headers.host : ""}/dl/duyu-small-int8.cpet` });
      res.end();
    });
    const p = project();
    const r = await pull(p, "--packs", "duyu-small-int8", "--no-ort", "--no-docs");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /too many redirects \(more than 5\)/);
    assert.equal(hits.filter((h) => h.path === "/dl/duyu-small-int8.cpet").length, 6, "the first request and five redirects");
    assert.deepEqual(listing(p.dir), []);
  });

  test("path traversal and odd names in the manifest are rejected before anything is fetched or written", async () => {
    const good = JSON.parse(readFileSync(join(rel.work, "release/cipetpet-release.json"), "utf8"));
    const names = ["../evil.cpet", "a/b.cpet", ".hidden.cpet", "..", "evil\\x.cpet", "x y.cpet", "%2e%2e%2fevil.cpet", "cipetpet-release.json", ""];
    for (const name of names) {
      const m = structuredClone(good);
      m.assets[3] = { ...m.assets[3], name }; // duyu-small-int8.cpet (assets are sorted by name)
      files.set("cipetpet-release.json", Buffer.from(JSON.stringify(m)));
      const p = project();
      hits = [];
      const r = await pull(p);
      assert.equal(r.code, 3, `${JSON.stringify(name)}: ${r.stderr}`);
      assert.match(r.stderr, /unsafe asset name|asset named cipetpet-release\.json|duplicate asset/, name);
      assert.equal(assetHits().length, 0, "no asset was requested");
      assert.deepEqual(listing(p.dir), []);
      assert.ok(!existsSync(join(p.cwd, "evil.cpet")) && !existsSync(join(p.dir, "..", "evil.cpet")));
    }
    // other manifest defects
    const defects: [string, (m: any) => void, RegExp][] = [
      ["bad hash", (m) => (m.assets[3].sha256 = "xyz"), /bad sha256/],
      ["negative size", (m) => (m.assets[3].bytes = -1), /bad size/],
      ["huge size", (m) => (m.assets[3].bytes = 2 ** 40), /bad size/],
      ["unknown kind", (m) => (m.assets[3].kind = "script"), /unknown kind/],
      ["pack without .cpet", (m) => (m.assets[3].name = "evil.exe"), /must end in \.cpet/],
      ["future format", (m) => (m.format = 2), /unsupported format 2/],
      ["duplicate", (m) => (m.assets[4].name = m.assets[3].name), /duplicate asset/],
      ["no assets", (m) => (m.assets = []), /bad assets list/],
    ];
    for (const [label, edit, re] of defects) {
      const m = structuredClone(good);
      edit(m);
      files.set("cipetpet-release.json", Buffer.from(JSON.stringify(m)));
      const r = await pull(project());
      assert.equal(r.code, 3, `${label}: ${r.stderr}`);
      assert.match(r.stderr, re, label);
    }
    files.set("cipetpet-release.json", Buffer.from("not json"));
    assert.equal((await pull(project())).code, 3);
  });

  test("a manifest over 1 MB is refused", async () => {
    files.set("cipetpet-release.json", Buffer.alloc(1024 * 1024 + 1, 32));
    const r = await pull(project());
    assert.equal(r.code, 3);
    assert.match(r.stderr, /larger than 1048576 bytes/);
    behaviours.set("/dl/cipetpet-release.json", (_req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.end(Buffer.alloc(2 * 1024 * 1024, 32));
    });
    const r2 = await pull(project());
    assert.equal(r2.code, 3);
    assert.match(r2.stderr, /larger than 1048576 bytes/);
  });

  test("the GitHub token goes to the API only: not to a redirect target on another origin, not to downloads", async () => {
    const env = {
      CIPETPET_GITHUB_API: `http://127.0.0.1:${port}/api/`,
      CIPETPET_GITHUB_URL: `http://127.0.0.1:${port}/gh`,
      GITHUB_TOKEN: "ghp_secret_token_value",
    };
    // the API answers releases/latest with a redirect to another origin
    behaviours.set("/api/repos/o/r/releases/latest", (_req, res) => {
      res.writeHead(302, { location: `${otherOrigin()}/redirected-api/latest` });
      res.end();
    });
    const p = project();
    const r = await cli(["pull", "--repo", "o/r", "--tag", "latest", "--no-ort", "--no-docs", "--packs", "antalia-mini-int8"], { cwd: p.cwd, env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const api = hits.find((h) => h.path === "/api/repos/o/r/releases/latest")!;
    assert.equal(api.headers.authorization, "Bearer ghp_secret_token_value", "the API request carries the token");
    const redirected = hits.find((h) => h.path === "/redirected-api/latest")!;
    assert.ok(redirected, "the redirect was followed");
    assert.equal(redirected.headers.authorization, undefined, "Authorization dropped on the other origin");
    for (const h of hits.filter((x) => !x.path.startsWith("/api/"))) assert.equal(h.headers.authorization, undefined, `${h.path} got no token`);
    assert.ok(!r.stdout.includes("ghp_secret") && !r.stderr.includes("ghp_secret"), "the token is never printed");
    // GH_TOKEN works too; the override for the API host must be local
    const bad = await cli(["pull", "--tag", "latest"], { cwd: p.cwd, env: { CIPETPET_GITHUB_API: "https://evil.example/", GITHUB_TOKEN: "t" } });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /CIPETPET_GITHUB_API must point to localhost/);
  });

  test("--dry-run fetches the manifest but writes nothing, not even the folder", async () => {
    const p = project();
    const r = await pull(p, "--dry-run");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would download +antalia-mini-int8\.cpet/);
    assert.match(r.stdout, /would download +ort\/ort-wasm-simd-threaded\.wasm/);
    assert.match(r.stdout, /dry run: nothing was written/);
    assert.equal(existsSync(join(p.cwd, "public")), false);
    assert.equal(assetHits().length, 0, "no asset was downloaded");
  });

  test("--list shows the release and what is already in the folder, and downloads nothing", async () => {
    const p = project();
    assert.equal((await pull(p, "--packs", "antalia-mini-int8", "--no-ort", "--no-docs")).code, 0);
    writeFileSync(join(p.dir, "duyu-small-q4.cpet"), "different");
    hits = [];
    const r = await pull(p, "--list");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^antalia-mini-int8\.cpet +pack +[\d.]+ KiB +ok +\(default\)$/m);
    assert.match(r.stdout, /^duyu-small-int8\.cpet +pack .* - +\(default\)$/m);
    assert.match(r.stdout, /^duyu-small-q4\.cpet +pack .* DIFFERENT$/m);
    assert.match(r.stdout, /^ort\/ort-wasm-simd-threaded\.asyncify\.wasm +ort /m);
    assert.equal(assetHits().length, 0);
  });

  test("--ort-from-node-modules copies the ORT files (checked against the manifest) and downloads none", async () => {
    const p = project();
    writeFakeOrt(join(p.cwd, "node_modules/onnxruntime-web"), FAKE_ORT_VERSION);
    const r = await pull(p, "--ort-from-node-modules", "--no-docs", "--packs", "antalia-mini-int8");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /copied +ort\/ort-wasm-simd-threaded\.wasm/);
    assert.deepEqual(readFileSync(join(p.dir, "ort/ort-wasm-simd-threaded.mjs")), files.get("ort-wasm-simd-threaded.mjs"));
    assert.ok(hits.every((h) => !h.path.includes("ort-wasm")), "the ORT files were not requested from the server");
    // a file in node_modules that is not the release's file is refused
    const q = project();
    writeFakeOrt(join(q.cwd, "node_modules/onnxruntime-web"), FAKE_ORT_VERSION);
    writeFileSync(join(q.cwd, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"), "patched");
    const r2 = await pull(q, "--ort-from-node-modules", "--no-docs", "--packs", "antalia-mini-int8");
    assert.equal(r2.code, 3);
    assert.match(r2.stderr, /does not match the release's ort-wasm-simd-threaded\.wasm/);
    assert.ok(!existsSync(join(q.dir, "ort/ort-wasm-simd-threaded.wasm")));
  });

  test("--ort-from-node-modules with another onnxruntime-web version than the manifest's: exit 3", async () => {
    const p = project();
    writeFakeOrt(join(p.cwd, "node_modules/onnxruntime-web"), "6.6.6");
    const r = await pull(p, "--ort-from-node-modules", "--no-docs");
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /needs onnxruntime-web 7\.7\.7, found .*6\.6\.6/);
    assert.deepEqual(listing(p.dir), [], "nothing was pulled before the check");
    const r2 = await pull(p, "--ort-from-node-modules", "--no-ort");
    assert.equal(r2.code, 1);
  });

  test("a symlinked subfolder cannot lead the download out of --dir", async () => {
    const p = project();
    const outside = join(p.cwd, "outside");
    mkdirSync(outside);
    mkdirSync(p.dir, { recursive: true });
    symlinkSync(outside, join(p.dir, "ort"));
    const r = await pull(p, "--no-docs");
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /outside .*public\/cipetpet/);
    assert.deepEqual(readdirSync(outside), [], "nothing was written outside");
    assert.ok(!existsSync(join(p.dir, "cipetpet-release.json")));
  });

  test("usage errors exit 1 with one line", async () => {
    const cases: string[][] = [
      ["pull", "--nope"],
      ["pull", "--dir"],
      ["pull", "--ort", "--no-ort"],
      ["pull", "--list", "--dry-run"],
      ["pull", "--tag", "../x", "--base-url", base()],
      ["pull", "--repo", "not a repo"],
      ["pull", "--base-url", "http://example.com/dl/"],
      ["pull", "--base-url", "ftp://127.0.0.1/dl/"],
      ["pull", "extra"],
      ["frobnicate"],
      [],
    ];
    for (const args of cases) {
      const r = await cli(args, { cwd: project().cwd });
      assert.equal(r.code, 1, `${args.join(" ")}: ${r.stderr}`);
    }
    const r = await cli(["pull", "--base-url", "http://example.com/dl/"], { cwd: project().cwd });
    assert.match(r.stderr, /^cipetpet: refusing to use http:\/\/example\.com: only https is allowed/);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    const help = await cli(["pull", "--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--ort-from-node-modules/);
    const version = await cli(["--version"]);
    assert.equal(version.stdout.trim(), (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version);
  });

  test("an https URL is attempted (no network needed to see the refusal of anything else)", async () => {
    // unreachable, but https: exit 2 with the offline hint, not a usage error
    const r = await cli(["pull", "--base-url", "https://127.0.0.1:1/dl/", "--tag", "v0.1.0"], { cwd: project().cwd });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot reach 127\.0\.0\.1:1/);
    assert.match(r.stderr, /--ort-from-node-modules/);
  });
});

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const manifestOf = () => JSON.parse(files.get("cipetpet-release.json")!.toString());
const serveManifest = (m: unknown) => files.set("cipetpet-release.json", Buffer.from(JSON.stringify(m, null, 2) + "\n"));

describe("cipetpet pull: a hostile or mistaken release cannot touch other files", () => {
  test("names are an allowlist per kind: docs are LICENSE/NOTICE only, ORT files and packs have fixed shapes", async () => {
    const good = manifestOf();
    const doc = good.assets.find((a: any) => a.name === "LICENSE");
    const ort = good.assets.find((a: any) => a.name === "ort-wasm-simd-threaded.mjs");
    const mutate = (edit: (m: any) => void) => {
      const m = structuredClone(good);
      edit(m);
      return m;
    };
    const rename = (m: any, from: string, to: string, extra: object = {}) => Object.assign(m.assets.find((a: any) => a.name === from), { name: to, ...extra });
    const cases: [string, any, RegExp][] = [
      ["doc named package.json", mutate((m) => rename(m, "LICENSE", "package.json")), /unexpected document name/],
      ["doc named index.html", mutate((m) => rename(m, "LICENSE", "index.html")), /unexpected document name/],
      ["doc named sw.js", mutate((m) => rename(m, "NOTICE", "sw.js")), /unexpected document name/],
      ["ort file with another name", mutate((m) => rename(m, "ort-wasm-simd-threaded.mjs", "evil.mjs")), /unexpected ONNX Runtime file name/],
      ["ort file named like the folder", mutate((m) => rename(m, "ort-wasm-simd-threaded.mjs", "ort")), /unexpected ONNX Runtime file name/],
      ["ort backend that does not fit the name", mutate((m) => rename(m, "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.mjs", { backend: "webgpu" })), /backend must be wasm/],
      ["pack with upper case name", mutate((m) => rename(m, "duyu-small-int8.cpet", "Evil.cpet")), /unexpected pack name/],
      ["pack named like a config file", mutate((m) => rename(m, "duyu-small-int8.cpet", "_x.cpet")), /unexpected pack name/],
      ["three docs", mutate((m) => m.assets.push({ ...doc, name: "OTHER" })), /more than 2 assets of kind doc/],
      ["five ORT files", mutate((m) => m.assets.push({ ...ort, name: "ort-wasm-simd-threaded.x.mjs" })), /more than 4 assets of kind ort|unexpected ONNX/],
      ["an oversized doc", mutate((m) => rename(m, "LICENSE", "LICENSE", { bytes: 5 * 1024 * 1024 })), /LICENSE: bad size/],
      ["an oversized ORT file", mutate((m) => rename(m, "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.wasm", { bytes: 100 * 1024 * 1024 })), /bad size/],
      ["an oversized pack", mutate((m) => rename(m, "duyu-small-int8.cpet", "duyu-small-int8.cpet", { bytes: 3 * 1024 ** 3 })), /bad size/],
    ];
    for (const [label, m, re] of cases) {
      serveManifest(m);
      const p = project();
      mkdirSync(p.dir, { recursive: true });
      writeFileSync(join(p.dir, "index.html"), "mine");
      hits = [];
      for (const dirFlag of [p.dir.slice(p.cwd.length + 1), "."]) {
        const r = await pull(p, "--dir", dirFlag);
        assert.equal(r.code, 3, `${label} (--dir ${dirFlag}): ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, re, label);
      }
      assert.equal(assetHits().length, 0, `${label}: nothing was requested`);
      assert.deepEqual(listing(p.cwd), ["public/cipetpet/index.html"], `${label}: nothing was written`);
      assert.equal(readFileSync(join(p.dir, "index.html"), "utf8"), "mine");
    }
  });

  test("a file that is not ours is never replaced: packs stop the pull before anything is written, LICENSE/NOTICE are skipped", async () => {
    const p = project();
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(join(p.dir, "LICENSE"), "MY OWN MIT LICENSE");
    writeFileSync(join(p.dir, "antalia-mini-int8.cpet"), "my own file");
    const r = await pull(p, "--no-ort");
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /antalia-mini-int8\.cpet already exists .*not put there by cipetpet pull/);
    assert.equal(assetHits().length, 0, "refused before downloading");
    assert.equal(readFileSync(join(p.dir, "antalia-mini-int8.cpet"), "utf8"), "my own file");
    assert.deepEqual(listing(p.dir), ["LICENSE", "antalia-mini-int8.cpet"]);
    // only the doc is in the way: it is kept, the rest is pulled
    rmSync(join(p.dir, "antalia-mini-int8.cpet"));
    const r2 = await pull(p, "--no-ort");
    assert.equal(r2.code, 0, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /skipped +LICENSE/);
    assert.equal(readFileSync(join(p.dir, "LICENSE"), "utf8"), "MY OWN MIT LICENSE");
    assert.deepEqual(readFileSync(join(p.dir, "NOTICE")), files.get("NOTICE"));
    assert.deepEqual(readFileSync(join(p.dir, "duyu-small-int8.cpet")), files.get("duyu-small-int8.cpet"));
    // --force is the explicit way to replace it
    const r3 = await pull(p, "--no-ort", "--force");
    assert.equal(r3.code, 0, r3.stdout + r3.stderr);
    assert.deepEqual(readFileSync(join(p.dir, "LICENSE")), files.get("LICENSE"));
    // a folder where a file belongs is an error, not an exception
    const q = project();
    mkdirSync(join(q.dir, "NOTICE"), { recursive: true });
    const r4 = await pull(q, "--no-ort");
    assert.equal(r4.code, 1);
    assert.match(r4.stderr, /NOTICE exists and is not a file/);
  });

  test("files that an earlier pull wrote are still replaced when they were damaged (the local manifest lists them)", async () => {
    const p = project();
    assert.equal((await pull(p, "--no-ort")).code, 0);
    writeFileSync(join(p.dir, "LICENSE"), "edited by hand");
    const r = await pull(p, "--no-ort");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(readFileSync(join(p.dir, "LICENSE")), files.get("LICENSE"));
  });

  test("the same version with other hashes than the earlier pull is refused (exit 3) unless --force", async () => {
    const p = project();
    assert.equal((await pull(p, "--no-ort")).code, 0);
    const before = readFileSync(join(p.dir, "duyu-small-int8.cpet"));
    // the release is rewritten: other pack bytes, a manifest that is consistent with them
    const evilPack = Buffer.from(files.get("duyu-small-int8.cpet")!);
    evilPack[evilPack.length - 1] ^= 1;
    const m = manifestOf();
    const a = m.assets.find((x: any) => x.name === "duyu-small-int8.cpet");
    a.sha256 = sha256(evilPack);
    a.integrity = "sha256-" + createHash("sha256").update(evilPack).digest("base64");
    serveManifest(m);
    files.set("duyu-small-int8.cpet", evilPack);
    hits = [];
    const r = await pull(p, "--no-ort");
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /release 0\.1\.0 has changed since you pulled it: duyu-small-int8\.cpet/);
    assert.equal(assetHits().length, 0);
    assert.deepEqual(readFileSync(join(p.dir, "duyu-small-int8.cpet")), before, "the earlier file is untouched");
    const forced = await pull(p, "--no-ort", "--force");
    assert.equal(forced.code, 0, forced.stdout + forced.stderr);
    assert.deepEqual(readFileSync(join(p.dir, "duyu-small-int8.cpet")), evilPack);
  });
});

describe("cipetpet pull: the manifest is vouched for from outside the download", () => {
  const goodSha = () => sha256(files.get("cipetpet-release.json")!);

  test("--manifest-sha256: the right digest passes, a wrong one is exit 3 and writes nothing, junk is a usage error", async () => {
    const p = project();
    const ok = await pull(p, "--no-ort", "--manifest-sha256", goodSha().toUpperCase());
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /matches --manifest-sha256/);
    const q = project();
    const bad = await pull(q, "--no-ort", "--manifest-sha256", "0".repeat(64));
    assert.equal(bad.code, 3, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /has SHA-256 [0-9a-f]{64}, but --manifest-sha256 says 0{64}/);
    assert.deepEqual(listing(q.dir), []);
    const junk = await pull(project(), "--manifest-sha256", "xyz");
    assert.equal(junk.code, 1);
    assert.match(junk.stderr, /needs 64 hex digits/);
  });

  test("bin/release-digest.json in the package checks the manifest of the package's own version", async () => {
    // a copy of the CLI with a digest next to it, like the npm package after `release-assets --digest`
    const pkgDir = join(WORK, `pkg${n++}`);
    mkdirSync(join(pkgDir, "bin"), { recursive: true });
    copyFileSync(CLI, join(pkgDir, "bin/cipetpet.mjs"));
    copyFileSync(join(ROOT, "package.json"), join(pkgDir, "package.json"));
    const script = join(pkgDir, "bin/cipetpet.mjs");
    const digest = (version: string, manifestSha256: string) => writeFileSync(join(pkgDir, "bin/release-digest.json"), JSON.stringify({ format: 1, version, manifestSha256 }));
    const run = (p: { cwd: string }) => cli(["pull", "--base-url", base(), "--tag", "v0.1.0", "--no-ort"], { cwd: p.cwd, script });

    digest("0.1.0", goodSha());
    const ok = await run(project());
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /matches the digest of the installed cipetpet 0\.1\.0/);

    // the release changed after the package was published: even a self-consistent manifest is refused
    digest("0.1.0", "a".repeat(64));
    const p = project();
    const bad = await run(p);
    assert.equal(bad.code, 3, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /expects a{64}/);
    assert.deepEqual(listing(p.dir), []);

    // another version than the package's: not checkable, said so
    digest("0.0.9", "a".repeat(64));
    const other = await run(project());
    assert.equal(other.code, 0, other.stdout + other.stderr);
    assert.match(other.stdout, /not the version of this cipetpet package \(0\.0\.9\)/);

    writeFileSync(join(pkgDir, "bin/release-digest.json"), "{ broken");
    assert.equal((await run(project())).code, 3);
  });
});

describe("cipetpet pull: what it tells you to write", () => {
  test("a different onnxruntime-web next to the project than the release's ORT files is a warning; the same one is not", async () => {
    const p = project();
    writeFakeOrt(join(p.cwd, "node_modules/onnxruntime-web"), "6.6.6");
    const r = await pull(p, "--no-docs");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /warning: this release ships the files of onnxruntime-web 7\.7\.7, but the onnxruntime-web installed here is 6\.6\.6/);
    assert.match(r.stderr, /Install onnxruntime-web@7\.7\.7/);
    const q = project();
    writeFakeOrt(join(q.cwd, "node_modules/onnxruntime-web"), FAKE_ORT_VERSION);
    const ok = await pull(q, "--no-docs");
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.ok(!/warning/.test(ok.stderr), ok.stderr);
  });

  test("--webgpu puts backend: webgpu into the snippet; cipetpet-react gets its provider form with wasmPaths", async () => {
    const p = project();
    mkdirSync(join(p.cwd, "node_modules/cipetpet-react"), { recursive: true });
    writeFileSync(join(p.cwd, "node_modules/cipetpet-react/package.json"), '{"name":"cipetpet-react"}');
    const r = await pull(p, "--no-docs", "--webgpu");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /AntaliaMini\.load\("\/cipetpet\/antalia-mini-int8\.cpet", \{ backend: "webgpu", wasmPaths: "\/cipetpet\/ort\/" \}\)/);
    assert.match(r.stdout, /<CipetpetProvider tts=\{\{ source: "\/cipetpet\/antalia-mini-int8\.cpet", backend: "webgpu", wasmPaths: "\/cipetpet\/ort\/" \}\} stt=\{\{ source: "\/cipetpet\/duyu-small-int8\.cpet", backend: "webgpu", wasmPaths: "\/cipetpet\/ort\/", useWorker: true \}\}>/);
    const plain = await pull(project(), "--no-docs");
    assert.ok(!/CipetpetProvider|backend:/.test(plain.stdout), "no React form without cipetpet-react, no backend without --webgpu");
  });

  test("two variants of one model give one example per model: no constant declared twice, no repeated provider prop", async () => {
    const p = project();
    mkdirSync(join(p.cwd, "node_modules/cipetpet-react"), { recursive: true });
    writeFileSync(join(p.cwd, "node_modules/cipetpet-react/package.json"), '{"name":"cipetpet-react"}');
    const r = await pull(p, "--no-docs", "--packs", "antalia-mini-int8,duyu-small-int8,duyu-small-q4");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal((r.stdout.match(/const stt = /g) ?? []).length, 1, r.stdout);
    assert.equal((r.stdout.match(/ stt=\{\{/g) ?? []).length, 1, r.stdout);
    assert.match(r.stdout, /DuyuSmall\.load\("\/cipetpet\/duyu-small-int8\.cpet"/, "the default variant is the one shown");
    assert.match(r.stdout, /The other variants you pulled load the same way/);
    // only q4 of that model: it is then the example
    const q = await pull(project(), "--no-docs", "--packs", "duyu-small-q4");
    assert.match(q.stdout, /DuyuSmall\.load\("\/cipetpet\/duyu-small-q4\.cpet"/);
    assert.ok(!/The other variants/.test(q.stdout));
  });
});

describe("cipetpet pull: leftovers and redirects", () => {
  test("unfinished downloads of an earlier killed run are removed by the next pull (also when the asset is complete); --dry-run leaves them", async () => {
    const p = project();
    assert.equal((await pull(p)).code, 0);
    const parts = [join(p.dir, ".antalia-mini-int8.cpet.part"), join(p.dir, "ort/.ort-wasm-simd-threaded.wasm.part"), join(p.dir, ".cipetpet-release.json.part")];
    for (const f of parts) writeFileSync(f, "half");
    writeFileSync(join(p.dir, ".mine.part"), "not a cipetpet file");
    assert.equal((await pull(p, "--dry-run")).code, 0);
    for (const f of parts) assert.ok(existsSync(f), "dry run changes nothing");
    const r = await pull(p);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    for (const f of parts) assert.ok(!existsSync(f), `${f} was removed`);
    assert.ok(existsSync(join(p.dir, ".mine.part")), "only cipetpet's own part files");
  });

  test("a redirect from https to plain http://localhost is refused before it is requested", async (t) => {
    const cert = makeCert(join(WORK, "tls"));
    if (!cert) return t.skip("openssl is not available");
    const tls = createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/admin/do-something` });
      res.end();
    });
    await new Promise<void>((ok) => tls.listen(0, "127.0.0.1", ok));
    try {
      const tlsPort = (tls.address() as AddressInfo).port;
      const p = project();
      hits = [];
      const r = await cli(["pull", "--base-url", `https://localhost:${tlsPort}/dl/`, "--tag", "v0.1.0"], { cwd: p.cwd, env: { NODE_EXTRA_CA_CERTS: cert.certPath } });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /refusing to follow a redirect from https to http:\/\/127\.0\.0\.1/);
      assert.equal(hits.length, 0, "the local service never saw a request");
      assert.deepEqual(listing(p.dir), []);
    } finally {
      await new Promise((ok) => tls.close(ok));
    }
  });
});

describe("cipetpet verify", () => {
  test("ok on a pulled folder; exit 3 and the culprit when a file changed; missing files only with --strict", async () => {
    const p = project();
    assert.equal((await pull(p)).code, 0);
    const ok = await cli(["verify", "--dir", "public/cipetpet"], { cwd: p.cwd });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^ok +antalia-mini-int8\.cpet$/m);
    assert.match(ok.stdout, /^ok +ort\/ort-wasm-simd-threaded\.wasm$/m);
    assert.match(ok.stdout, /release 0\.1\.0: 6 ok, 0 wrong, 3 not present/);
    assert.match(ok.stdout, /^--  +duyu-small-q4\.cpet/m);

    const strict = await cli(["verify", "--dir", "public/cipetpet", "--strict"], { cwd: p.cwd });
    assert.equal(strict.code, 3);
    assert.match(strict.stderr, /3 file\(s\) of the release are missing \(--strict\)/);

    const data = readFileSync(join(p.dir, "duyu-small-int8.cpet"));
    data[200] ^= 0x10;
    writeFileSync(join(p.dir, "duyu-small-int8.cpet"), data);
    const bad = await cli(["verify", "--dir", "public/cipetpet"], { cwd: p.cwd });
    assert.equal(bad.code, 3);
    assert.match(bad.stdout, /^FAILED +duyu-small-int8\.cpet +sha256 [0-9a-f]{64}, expected /m);
    assert.match(bad.stderr, /1 file\(s\) do not match cipetpet-release\.json/);

    writeFileSync(join(p.dir, "duyu-small-int8.cpet"), data.subarray(0, 50));
    const shortFile = await cli(["verify", "--dir", "public/cipetpet"], { cwd: p.cwd });
    assert.equal(shortFile.code, 3);
    assert.match(shortFile.stdout, /FAILED +duyu-small-int8\.cpet +size 50, expected/);

    // pull repairs it
    assert.equal((await pull(p)).code, 0);
    assert.equal((await cli(["verify", "--dir", "public/cipetpet"], { cwd: p.cwd })).code, 0);
  });

  test("notes unfinished downloads; refuses an empty or manifest-less folder", async () => {
    const p = project();
    assert.equal((await pull(p, "--no-ort", "--no-docs")).code, 0);
    writeFileSync(join(p.dir, ".antalia-mini-int8.cpet.part"), "half");
    const r = await cli(["verify", "--dir", "public/cipetpet"], { cwd: p.cwd });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\.antalia-mini-int8\.cpet\.part is an unfinished download/);
    const none = await cli(["verify", "--dir", "public/cipetpet"], { cwd: project().cwd });
    assert.equal(none.code, 1);
    assert.match(none.stderr, /cipetpet-release\.json not found; run "cipetpet pull/);
    // a manifest with no file next to it verifies nothing, which is a failure
    const q = project();
    mkdirSync(q.dir, { recursive: true });
    writeFileSync(join(q.dir, "cipetpet-release.json"), files.get("cipetpet-release.json")!);
    const empty = await cli(["verify", "--dir", "public/cipetpet"], { cwd: q.cwd });
    assert.equal(empty.code, 3);
    assert.match(empty.stderr, /nothing was verified/);
    // a manifest with a hostile name is not followed out of the folder
    const evil = JSON.parse(files.get("cipetpet-release.json")!.toString());
    evil.assets[3].name = "../../etc/passwd";
    writeFileSync(join(q.dir, "cipetpet-release.json"), JSON.stringify(evil));
    const r2 = await cli(["verify", "--dir", "public/cipetpet"], { cwd: q.cwd });
    assert.equal(r2.code, 3);
    assert.match(r2.stderr, /unsafe asset name/);
  });
});
