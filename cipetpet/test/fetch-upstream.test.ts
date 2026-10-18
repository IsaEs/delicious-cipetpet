// tools/fetch-upstream.ts against a local mock of the Hugging Face resolve URLs. No network.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fetchUpstream, FetchError, parseLock, resolveUrl, type Lock } from "../tools/fetch-upstream.js";
import { bytesFor, ROOT, TEST_OUT } from "./helpers/synthetic-release.js";
import { makeCert } from "./helpers/tls.js";
import { createServer as createHttpsServer } from "node:https";

const WORK = join(TEST_OUT, `fetch-upstream-${process.pid}`);
/** like spawnSync, but the servers of this process keep answering while the child runs */
function runAsync(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, opts);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (status) => ok({ status, stdout, stderr }));
  });
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const content = new Map<string, Buffer>();
const FILES: [string, string][] = [
  ["a", "models/x.onnx"],
  ["a", "assets/y.json.gz"],
  ["d", "int8/z.onnx"],
  ["d", "spm.model"],
];
for (const [id, path] of FILES) content.set(`${id}/${path}`, Buffer.from(bytesFor(`${id}/${path}`, 3000 + path.length)));

const lock: Lock = {
  format: 1,
  repos: [
    { id: "a", kind: "space", repo: "o/a", commit: "a".repeat(40), files: [] },
    { id: "d", kind: "model", repo: "o/d", commit: "b".repeat(40), files: [] },
  ],
};
for (const [id, path] of FILES) {
  const b = content.get(`${id}/${path}`)!;
  lock.repos.find((r) => r.id === id)!.files.push({ path, bytes: b.length, sha256: sha(b), lfs: true });
}

let server: Server;
let base = "";
let served: Map<string, Buffer>;
let requests: string[] = [];
before(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "").replace(/^\//, ""));
    requests.push(path);
    const body = served.get(path);
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
after(async () => {
  await new Promise((ok) => server.close(ok));
  rmSync(WORK, { recursive: true, force: true });
});
const fresh = (name: string) => {
  served = new Map(content);
  requests = [];
  const out = join(WORK, name);
  rmSync(out, { recursive: true, force: true });
  return out;
};
const tree = (dir: string) => (existsSync(dir) ? (readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1)).sort()) : []);

describe("fetch-upstream", () => {
  test("downloads the lock's files into the build-packs layout and verifies them", async () => {
    const out = fresh("ok");
    const s = await fetchUpstream({ lock, out, baseUrl: base, attempts: 1 });
    assert.deepEqual(s, { files: 4, bytes: [...content.values()].reduce((n, b) => n + b.length, 0), downloaded: 4, reused: 0 });
    assert.deepEqual(tree(out), ["a/assets/y.json.gz", "a/models/x.onnx", "d/int8/z.onnx", "d/spm.model"]);
    for (const [k, v] of content) assert.deepEqual(readFileSync(join(out, k)), v);
    // a second run downloads nothing
    requests = [];
    const again = await fetchUpstream({ lock, out, baseUrl: base, attempts: 1 });
    assert.equal(again.reused, 4);
    assert.deepEqual(requests, []);
    // a damaged file is replaced
    writeFileSync(join(out, "d/spm.model"), "x");
    const fixed = await fetchUpstream({ lock, out, baseUrl: base, attempts: 1 });
    assert.deepEqual([fixed.downloaded, fixed.reused], [1, 3]);
    assert.deepEqual(readFileSync(join(out, "d/spm.model")), content.get("d/spm.model"));
    // --verify-only
    assert.equal((await fetchUpstream({ lock, out, verifyOnly: true })).reused, 4);
    writeFileSync(join(out, "d/spm.model"), "x");
    await assert.rejects(fetchUpstream({ lock, out, verifyOnly: true }), (e) => e instanceof FetchError && e.code === 3 && /d\/spm\.model: SHA-256 mismatch/.test(e.message));
  });

  test("a wrong hash fails loudly (exit code 3) and no file is kept, not even a .part", async () => {
    const out = fresh("bad");
    const bad = Buffer.from(content.get("d/int8/z.onnx")!);
    bad[5] ^= 1;
    served.set("d/int8/z.onnx", bad);
    await assert.rejects(fetchUpstream({ lock, out, baseUrl: base, attempts: 3 }), (e) => e instanceof FetchError && e.code === 3 && /d\/int8\/z\.onnx: SHA-256 mismatch/.test(e.message));
    assert.ok(!tree(out).some((f) => f.includes("z.onnx")), tree(out).join(","));
    assert.equal(requests.filter((r) => r === "d/int8/z.onnx").length, 1, "a mismatch is not retried");
    // too short, too long
    served.set("d/int8/z.onnx", content.get("d/int8/z.onnx")!.subarray(1));
    await assert.rejects(fetchUpstream({ lock, out, baseUrl: base, attempts: 1 }), /got \d+ bytes, the lock says/);
    served.set("d/int8/z.onnx", Buffer.concat([content.get("d/int8/z.onnx")!, Buffer.alloc(1)]));
    await assert.rejects(fetchUpstream({ lock, out, baseUrl: base, attempts: 1 }), /server announces|more than/);
    assert.ok(!tree(out).some((f) => f.includes("z.onnx")));
  });

  test("a stale wrong file is removed when the replacement fails; 404 is a network failure (code 2), retried", async () => {
    const out = fresh("stale");
    mkdirSync(join(out, "a/models"), { recursive: true });
    writeFileSync(join(out, "a/models/x.onnx"), "stale");
    served.delete("a/models/x.onnx");
    await assert.rejects(fetchUpstream({ lock, out, baseUrl: base, attempts: 2 }), (e) => e instanceof FetchError && e.code === 2 && /HTTP 404/.test(e.message));
    assert.equal(requests.filter((r) => r === "a/models/x.onnx").length, 2);
    assert.ok(!existsSync(join(out, "a/models/x.onnx")), "never keep a file with a wrong hash");
  });

  test("resolveUrl: pinned resolve URLs of spaces and models", () => {
    assert.equal(resolveUrl(lock.repos[0], lock.repos[0].files[0]), `https://huggingface.co/spaces/o/a/resolve/${"a".repeat(40)}/models/x.onnx`);
    assert.equal(resolveUrl(lock.repos[1], lock.repos[1].files[1]), `https://huggingface.co/o/d/resolve/${"b".repeat(40)}/spm.model`);
  });

  test("the real tools/upstream.lock.json: pinned commits, safe paths, and every file build-packs.ts reads", () => {
    const real = parseLock(readFileSync(join(ROOT, "tools/upstream.lock.json"), "utf8"));
    const by = Object.fromEntries(real.repos.map((r) => [r.id, r]));
    assert.equal(by["antalia-mini"].commit, "2c24b406fedada11bd731a2ec9f4535bfd354f03");
    assert.equal(by["antalia-mini"].repo, "cloud0day3/antalia-mini");
    assert.equal(by["antalia-mini"].kind, "space");
    assert.equal(by["duyu-small"].commit, "a9aa79751ea6e99c1e035fcb056318d5c1b67f13");
    assert.equal(by["duyu-small"].repo, "KaanAydinli/Duyu-small");
    const paths = (id: string) => new Set(by[id].files.map((f) => f.path));
    for (const g of ["text", "cond", "flow", "vocoder"]) for (const s of ["", ".fp16", ".int8"]) assert.ok(paths("antalia-mini").has(`models/${g}${s}.onnx`), `${g}${s}`);
    for (const p of ["models/manifest.json", "assets/frontend-data.json.gz"]) assert.ok(paths("antalia-mini").has(p), p);
    for (const v of ["int8", "q4"]) for (const g of ["encoder_pre", "encoder_pass", "encoder_post", "decoder"]) assert.ok(paths("duyu-small").has(`${v}/${g}.onnx`), `${v}/${g}`);
    for (const p of ["config.json", "engine.json", "fbank.npz", "passes.npz", "spm.model"]) assert.ok(paths("duyu-small").has(p), p);
    // the ONNX export of EMA Lightning's weights + normalizer-tr's WebAssembly (build-packs reads them flat)
    assert.equal(by["ema-lightning"].commit, "728d44d07a6b51aa939d70a9fa486e117745c0cc");
    assert.equal(by["ema-lightning"].repo, "tedash34/ema-lightning-onnx");
    assert.equal(by["ema-lightning"].kind, "model");
    for (const p of ["text.onnx", "sound.onnx", "decoder.onnx", "config.json", "normalizer_tr_wasm_bg.wasm", "ema-lightning.json"]) assert.ok(paths("ema-lightning").has(p), p);
    for (const r of real.repos) for (const f of r.files) assert.ok(f.lfs ? true : /^[0-9a-f]{40}$/.test(f.gitBlob ?? ""), `${r.id}/${f.path}`);
  });

  test("parseLock rejects unsafe or malformed locks", () => {
    const edit = (f: (l: any) => void) => {
      const l = structuredClone(lock);
      f(l);
      return JSON.stringify(l);
    };
    for (const [label, text, re] of [
      ["traversal", edit((l) => (l.repos[0].files[0].path = "../x")), /unsafe path/],
      ["absolute", edit((l) => (l.repos[0].files[0].path = "/etc/passwd")), /unsafe path/],
      ["backslash", edit((l) => (l.repos[0].files[0].path = "a\\b")), /unsafe path/],
      ["dot segment", edit((l) => (l.repos[0].files[0].path = "a/./b")), /unsafe path/],
      ["short commit", edit((l) => (l.repos[0].commit = "main")), /commit/],
      ["bad sha", edit((l) => (l.repos[0].files[0].sha256 = "zz")), /bad sha256/],
      ["bad id", edit((l) => (l.repos[0].id = "../a")), /bad repo id/],
      ["duplicate", edit((l) => l.repos[0].files.push(l.repos[0].files[0])), /duplicate path/],
      ["format", edit((l) => (l.format = 2)), /expected \{format: 1/],
      ["json", "{", /not valid JSON/],
    ] as [string, string, RegExp][]) {
      assert.throws(() => parseLock(text), (e) => e instanceof FetchError && e.code === 1 && re.test(e.message), label);
    }
  });

  test("redirects are followed hop by hop; a hop to a non-https, non-local host is refused before it is requested", async () => {
    const out = fresh("redir");
    const target = "a/models/x.onnx";
    const one: Lock = { format: 1, repos: [{ id: "a", kind: "space", repo: "o/a", commit: "a".repeat(40), files: [lock.repos[0].files[0]] }] };
    const seen: string[] = [];
    let mode: "chain" | "evil" = "chain";
    const srv = createServer((req, res) => {
      const url = req.url ?? "";
      seen.push(url);
      if (url === `/${target}`) {
        res.writeHead(302, { location: mode === "chain" ? "/hop1" : "http://example.com/steal" });
        return res.end();
      }
      if (url === "/hop1") {
        res.writeHead(302, { location: "/real" });
        return res.end();
      }
      if (url === "/real") {
        const body = content.get(target)!;
        res.writeHead(200, { "content-length": body.length });
        return res.end(body);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    try {
      const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
      const s = await fetchUpstream({ lock: one, out, baseUrl: b, attempts: 1 });
      assert.equal(s.downloaded, 1);
      assert.deepEqual(seen, [`/${target}`, "/hop1", "/real"]);
      mode = "evil";
      seen.length = 0;
      const out2 = fresh("redir2");
      await assert.rejects(fetchUpstream({ lock: one, out: out2, baseUrl: b, attempts: 1 }), (e) => e instanceof FetchError && e.code === 2 && /https only/.test(e.message));
      assert.deepEqual(seen, [`/${target}`], "example.com was never contacted");
      assert.deepEqual(tree(out2), []);
    } finally {
      await new Promise((ok) => srv.close(ok));
    }
  });

  test("a redirect chain that started on https never drops to http://localhost", async (t) => {
    const cert = makeCert(join(WORK, "tls"));
    if (!cert) return t.skip("openssl is not available");
    const local: string[] = [];
    const plain = createServer((req, res) => {
      local.push(req.url ?? "");
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((ok) => plain.listen(0, "127.0.0.1", ok));
    const tls = createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${(plain.address() as AddressInfo).port}/admin/do-something` });
      res.end();
    });
    await new Promise<void>((ok) => tls.listen(0, "127.0.0.1", ok));
    try {
      mkdirSync(WORK, { recursive: true });
      const lockPath = join(WORK, "tls-lock.json");
      writeFileSync(lockPath, JSON.stringify({ ...lock, repos: lock.repos.map((r) => ({ ...r, files: r.files.slice(0, 1) })) }));
      const r = await runAsync(
        process.execPath,
        ["--import", "tsx", join(ROOT, "tools/fetch-upstream.ts"), "--lock", lockPath, "--out", join(WORK, "tls-out"), "--base-url", `https://localhost:${(tls.address() as AddressInfo).port}/`],
        { cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_EXTRA_CA_CERTS: cert.certPath } },
      );
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /refusing to follow a redirect from https to http:\/\/127\.0\.0\.1/);
      assert.deepEqual(local, [], "the local service never saw a request");
    } finally {
      await new Promise((ok) => tls.close(ok));
      await new Promise((ok) => plain.close(ok));
    }
  });

  test("command line: usage error exits 1, a refused http host exits 2", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "tools/fetch-upstream.ts"), ...args], { cwd: ROOT, encoding: "utf8" });
    const r = run("--nope");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown argument --nope/);
    const h = run("--base-url", "http://example.com/", "--out", join(WORK, "cli"));
    assert.equal(h.status, 2);
    assert.match(h.stderr, /https only/);
  });
});
