// The CDN bundle (tools/build.mjs -> dist/browser): the files exist, none has a bare specifier (a browser
// cannot resolve one without an import map), the minified library evaluates and runs in Node, and the
// package.json fields point at it. buildBrowser() runs into .test-out, so no `npm run build` is needed first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
// @ts-expect-error plain .mjs without declarations
import { buildBrowser } from "../tools/build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".test-out/browser-bundle");
const FILES = ["cipetpet.js", "cipetpet.min.js", "ort-webgpu.js", "worker.js"];
const read = (name: string) => readFileSync(join(OUT, name), "utf8");

before(async () => {
  const built: string[] = await buildBrowser(OUT);
  assert.deepEqual(built, FILES);
});

interface Specifier {
  kind: string;
  value: string;
}

/** every module specifier a browser would have to resolve: import / export ... from, import("..."), import.meta.resolve("...") */
function scan(code: string): { found: Specifier[]; dynamicNonLiteral: number } {
  const sf = ts.createSourceFile("bundle.js", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const found: Specifier[] = [];
  let dynamicNonLiteral = 0;
  const literal = (n: ts.Node | undefined) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      found.push({ kind: ts.isImportDeclaration(n) ? "import" : "export-from", value: literal(n.moduleSpecifier) ?? "?" });
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const v = literal(n.arguments[0]);
      if (v === undefined) dynamicNonLiteral++;
      else found.push({ kind: "dynamic-import", value: v });
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.getText(sf) === "import.meta.resolve") {
      found.push({ kind: "import.meta.resolve", value: literal(n.arguments[0]) ?? "?" });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { found, dynamicNonLiteral };
}
const specifiers = (name: string) => scan(read(name));

const isResolvable = (s: string) => /^(\.\.?\/|\/|https?:\/\/)/.test(s);

test("browser bundle: the files exist and are not empty; the min bundle is smaller", () => {
  for (const f of FILES) assert.ok(statSync(join(OUT, f)).size > 10_000, f);
  assert.ok(statSync(join(OUT, "cipetpet.min.js")).size < statSync(join(OUT, "cipetpet.js")).size);
  assert.ok(existsSync(join(OUT, "cipetpet.min.js.map")) && existsSync(join(OUT, "worker.js.map")));
  assert.deepEqual(readdirSync(OUT).filter((f) => !FILES.includes(f) && !f.endsWith(".map")), [], "no stray chunk files");
  assert.match(read("cipetpet.min.js"), /^\/\*! cipetpet \d+\.\d+\.\d+ .*onnxruntime-web \d+\.\d+\.\d+/);
});

test("browser bundle: no bare specifiers anywhere (only relative ones, to our own ort-webgpu.js)", () => {
  for (const f of FILES) {
    const { found } = specifiers(f);
    const bare = found.filter((s) => !isResolvable(s.value));
    assert.deepEqual(bare, [], `${f} has bare specifiers`);
  }
  // the library reaches the WebGPU build by a relative path, from both the plain and the min file
  for (const f of ["cipetpet.js", "cipetpet.min.js"]) {
    assert.deepEqual(specifiers(f).found, [{ kind: "dynamic-import", value: "./ort-webgpu.js" }], f);
  }
  // the worker and the WebGPU build are standalone: no imports at all
  assert.deepEqual(specifiers("worker.js").found, []);
  assert.deepEqual(specifiers("ort-webgpu.js").found, []);
});

test("browser bundle: the scanner itself flags bare specifiers (so an empty result means something)", () => {
  const { found, dynamicNonLiteral } = scan(
    'import x from "pkg"; await import("other"); export * from "third"; import("./ok.js"); import(v); import.meta.resolve("bare"); import "side";',
  );
  assert.deepEqual(
    found.filter((s) => !isResolvable(s.value)).map((s) => s.value).sort(),
    ["bare", "other", "pkg", "side", "third"],
  );
  assert.equal(dynamicNonLiteral, 1);
});

test("browser bundle: no Node builtin is imported or required by the files", () => {
  for (const f of FILES) {
    const text = read(f);
    assert.ok(!/import\(\s*["'`](node:|worker_threads|module|fs|path|os|url|child_process)["'`]/.test(text), `${f}: import() of a builtin`);
    assert.ok(!/require\(\s*["'`](node:|worker_threads|module|fs|path|os|url|child_process)["'`]/.test(text), `${f}: require() of a builtin`);
  }
});

test("browser bundle: the browser-bundle switch is on in these files and the pack/worker pieces are inside", () => {
  const text = read("cipetpet.js");
  assert.match(text, /var IS_BROWSER_BUNDLE = true;/);
  assert.match(text, /cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\$\{version\}\/dist\//);
  assert.match(text, /new URL\("\.\/worker\.js", import\.meta\.url\)/, "default worker URL is next to the bundle");
  assert.match(read("worker.js"), /ort-wasm-simd-threaded/);
});

const scriptFor = (body: string) => `
import { readFileSync } from "node:fs";
const [bundleUrl, ...args] = process.argv.slice(1);
${body}`;

function child(body: string, ...args: string[]): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", scriptFor(body), pathToFileURL(join(OUT, "cipetpet.min.js")).href, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 << 20,
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test("browser bundle: cipetpet.min.js evaluates in Node (no DOM needed) and exports the library", () => {
  const r = child(`
    const m = await import(bundleUrl);
    console.log(JSON.stringify(Object.keys(m).sort()));
    console.log(JSON.stringify(["AntaliaMini", "DuyuSmall", "openPack", "createAntaliaWorker", "createDuyuWorker", "initRuntime", "Pack"].map((k) => typeof m[k])));
  `);
  assert.equal(r.status, 0, r.err);
  const [names, types] = r.out.split("\n");
  for (const k of ["AntaliaMini", "DuyuSmall", "openPack", "Pack", "createAntaliaWorker", "createDuyuWorker", "initRuntime"]) assert.ok(JSON.parse(names).includes(k), k);
  assert.deepEqual(JSON.parse(types), Array(7).fill("function"));
  // the unminified file exports the same names
  const plain = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(process.argv[1]); console.log(JSON.stringify(Object.keys(m).sort()))`, pathToFileURL(join(OUT, "cipetpet.js")).href], { encoding: "utf8" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trim(), names);
});

const ORT_WASM = join(ROOT, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm");
const GRAPH = join(ROOT, ".upstream/duyu-small/int8/encoder_pre.onnx");
const PACK = join(ROOT, "packs/antalia-mini-int8.cpet");

/** initRuntime in the bundle with a fake `document` (so ORT is configured as in a page), then a first session */
const wasmPathsScenario = `
globalThis.document = {};
const scenario = args[0];
const m = await import(bundleUrl);
const wasm = new Uint8Array(readFileSync(${JSON.stringify(ORT_WASM)}));
const opts = { binary: { wasmBinary: wasm }, "binary-threads": { wasmBinary: wasm, threads: 2 }, paths: { wasmPaths: "https://example.test/ort/" }, none: {} }[scenario];
const rt = await m.initRuntime(opts);
let outcome = "session ok";
try {
  const graph = existsSync(${JSON.stringify(GRAPH)}) ? new Uint8Array(readFileSync(${JSON.stringify(GRAPH)})) : new Uint8Array(8);
  await (await rt.createSession(graph, "g")).release();
} catch (e) { outcome = "rejected"; }
console.log(JSON.stringify({ wasmPaths: rt.ort.env.wasm.wasmPaths ?? null, outcome, version: rt.version }));
`.replace('import { readFileSync } from "node:fs";', "");

for (const [scenario, expect] of [
  ["none", { wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web@VERSION/dist/" }],
  ["paths", { wasmPaths: "https://example.test/ort/" }],
  ["binary", { wasmPaths: null }],
  ["binary-threads", { wasmPaths: { mjs: "https://cdn.jsdelivr.net/npm/onnxruntime-web@VERSION/dist/ort-wasm-simd-threaded.mjs" } }],
] as const) {
  test(`browser bundle: ORT location in a page - ${scenario}`, { skip: existsSync(ORT_WASM) ? false : "onnxruntime-web wasm not installed" }, () => {
    const r = child(`import { existsSync } from "node:fs";\n${wasmPathsScenario}`, scenario);
    assert.equal(r.status, 0, r.err);
    const got = JSON.parse(r.out.split("\n").at(-1)!);
    const wanted = JSON.parse(JSON.stringify(expect).replaceAll("VERSION", got.version));
    assert.deepEqual(got.wasmPaths, wanted.wasmPaths);
    if (scenario === "binary") assert.equal(got.outcome, existsSync(GRAPH) ? "session ok" : "rejected", "an embedded binary needs no network");
    if (scenario === "none" || scenario === "paths") assert.equal(got.outcome, "rejected", "Node cannot import an https URL, so the session fails after wasmPaths was set");
  });
}

test("browser bundle: proxy: true warns once that ORT's own proxy worker is not supported from the bundle", { skip: existsSync(ORT_WASM) ? false : "onnxruntime-web wasm not installed" }, () => {
  const r = child(`
    import { readFileSync } from "node:fs";
    globalThis.document = {};
    const warns = [];
    console.warn = (...a) => warns.push(a.join(" "));
    const m = await import(bundleUrl);
    const wasm = new Uint8Array(readFileSync(${JSON.stringify(ORT_WASM)}));
    await m.initRuntime({ proxy: true, wasmBinary: wasm });
    await m.initRuntime({ proxy: true });
    console.log(JSON.stringify(warns));
  `.replace('import { readFileSync } from "node:fs";', ""));
  assert.equal(r.status, 0, r.err);
  const warns: string[] = JSON.parse(r.out.split("\n").at(-1)!);
  assert.equal(warns.filter((w) => /proxy: true is not supported with the cipetpet CDN bundle/.test(w)).length, 1);
});

test("browser bundle: the min bundle really synthesizes speech in Node (antalia-mini-int8 from packs/)", { skip: existsSync(PACK) && existsSync(ORT_WASM) ? false : "packs/antalia-mini-int8.cpet not built" }, () => {
  const r = child(`
    const m = await import(bundleUrl);
    const wasm = new Uint8Array(readFileSync(${JSON.stringify(ORT_WASM)}));
    const tts = await m.AntaliaMini.load(new Uint8Array(readFileSync(${JSON.stringify(PACK)})), { wasmBinary: wasm });
    const r = await tts.synthesize("Merhaba dünya.");
    let peak = 0; for (const v of r.audio) peak = Math.max(peak, Math.abs(v));
    console.log(JSON.stringify({ samples: r.audio.length, rate: r.sampleRate, peak, ort: tts.info.onnxruntime }));
    await tts.dispose();
  `);
  assert.equal(r.status, 0, r.err);
  const o = JSON.parse(r.out.split("\n").at(-1)!);
  assert.equal(o.rate, 48000);
  assert.ok(o.samples > 20_000, `samples ${o.samples}`);
  assert.ok(o.peak > 0.01 && o.peak <= 1.5, `peak ${o.peak}`);
});

test("package.json: unpkg / jsdelivr / browser / ./browser point at files the build writes", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const inBuild = (p: string) => {
    assert.match(p, /^\.\/dist\/browser\//, p);
    return FILES.includes(p.slice("./dist/browser/".length));
  };
  for (const field of ["unpkg", "jsdelivr", "browser"]) {
    assert.ok(inBuild(pkg[field]), `${field}: ${pkg[field]}`);
    assert.equal(pkg[field], "./dist/browser/cipetpet.min.js");
  }
  assert.ok(inBuild(pkg.exports["./browser"].default));
  assert.equal(pkg.exports["./browser"].types, pkg.exports["."].types);
  assert.equal(pkg.exports["./browser/*"], "./dist/browser/*");
  assert.ok(pkg.files.includes("dist/browser"));
  assert.ok(pkg.files.includes("CDN.md") && existsSync(join(ROOT, "CDN.md")));
  // existing entry points are intact
  assert.equal(pkg.exports["."].import, "./dist/esm/index.js");
  assert.equal(pkg.exports["./worker"].import, "./dist/esm/worker/index.js");
});
