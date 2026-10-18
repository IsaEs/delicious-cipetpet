// Where ONNX Runtime looks for its files in the CDN bundle (src/runtime/ort.ts: defaultWasmPaths). The
// end-to-end behaviour inside the real bundle is in browser-bundle.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWasmPaths, ortCdnBase } from "../src/runtime/ort.js";
import type { WasmPathsInput } from "../src/runtime/ort.js";

const base: WasmPathsInput = {
  browserBundle: true,
  browser: true,
  ownImport: true,
  hasWasmPaths: false,
  hasBinary: false,
  threads: 1,
  version: "1.30.0",
};
const CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";

test("ortCdnBase: jsDelivr directory of the exact ORT version", () => {
  assert.equal(ortCdnBase("1.30.0"), CDN);
  assert.equal(ortCdnBase("1.31.2"), "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.2/dist/");
});

test("defaultWasmPaths: the browser bundle points ORT at jsDelivr unless told otherwise", () => {
  assert.equal(defaultWasmPaths(base), CDN);
  assert.equal(defaultWasmPaths({ ...base, threads: 4 }), CDN);
});

test("defaultWasmPaths: left alone outside the bundle, outside a browser, for a foreign ORT, or with wasmPaths", () => {
  assert.equal(defaultWasmPaths({ ...base, browserBundle: false }), undefined, "dist/esm: ORT's own logic / the bundler decides");
  assert.equal(defaultWasmPaths({ ...base, browser: false }), undefined, "Node, Deno, Bun");
  assert.equal(defaultWasmPaths({ ...base, ownImport: false }), undefined, "options.ort: the app's own ORT");
  assert.equal(defaultWasmPaths({ ...base, hasWasmPaths: true }), undefined, "options.wasmPaths wins");
  assert.equal(defaultWasmPaths({ ...base, version: undefined }), undefined, "unknown version: cannot name a release");
});

test("defaultWasmPaths: with the binary in memory, one thread needs no file; several threads need the glue file", () => {
  assert.equal(defaultWasmPaths({ ...base, hasBinary: true, threads: 1 }), undefined);
  assert.deepEqual(defaultWasmPaths({ ...base, hasBinary: true, threads: 3 }), { mjs: `${CDN}ort-wasm-simd-threaded.mjs` });
});
