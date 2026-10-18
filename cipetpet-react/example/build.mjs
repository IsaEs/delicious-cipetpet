// Bundles example/main.tsx into example/dist/main.js with esbuild and copies ONNX Runtime's wasm files next
// to it. "cipetpet" resolves to the core's built package when it exists, else to its TypeScript sources;
// "cipetpet-react" resolves to this package's sources.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const core = join(pkg, "..", "cipetpet");
const out = join(here, "dist");

const coreEntry = [join(core, "dist/esm/index.js"), join(core, "src/index.ts")].find((f) => existsSync(f));
if (!coreEntry) {
  console.error("example: the cipetpet core has neither dist/esm/index.js nor src/index.ts yet");
  process.exit(1);
}

/** @type {import("esbuild").Plugin} */
const aliases = {
  name: "cipetpet-aliases",
  setup(b) {
    b.onResolve({ filter: /^cipetpet$/ }, () => ({ path: coreEntry }));
    b.onResolve({ filter: /^cipetpet-react$/ }, () => ({ path: join(pkg, "src/index.ts") }));
  },
};

mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, "main.tsx")],
  outdir: out,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  sourcemap: true,
  // one React copy: this package's dev dependency
  nodePaths: [join(pkg, "node_modules")],
  // onnxruntime-web loads its .wasm / .mjs at runtime; they are copied below and found through wasmPaths
  external: ["*.wasm"],
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [aliases],
  logLevel: "info",
});

const ortDist = join(core, "node_modules/onnxruntime-web/dist");
if (existsSync(ortDist)) {
  for (const f of readdirSync(ortDist)) {
    if (/^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/.test(f)) copyFileSync(join(ortDist, f), join(out, f));
  }
} else {
  console.warn("example: ../cipetpet/node_modules/onnxruntime-web not found; packs must embed the runtime");
}
console.log(`example: built ${out} (cipetpet from ${coreEntry})`);
