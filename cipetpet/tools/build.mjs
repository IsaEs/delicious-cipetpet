// Builds dist/:
//   dist/esm, dist/types   tsc output (what `import "cipetpet"` resolves to), plus esm/worker/worker.js, the
//                          worker as a standalone bundle
//   dist/browser           files for <script type="module"> on a CDN, no bundler needed:
//                            cipetpet.js, cipetpet.min.js   the library with the ORT wasm build inside
//                            ort-webgpu.js                  ORT's WebGPU build, loaded on demand ("./ort-webgpu.js")
//                            worker.js                      the worker (createAntaliaWorker / createDuyuWorker)
//                          None of them has a bare specifier: only relative imports.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(root);
const tsconfig = join(packageRoot, "tsconfig.json");
const tsc = join(packageRoot, "node_modules/typescript/bin/tsc");
const workerOut = join(packageRoot, "dist/esm/worker/worker.js");
const defaultBrowserOut = join(packageRoot, "dist/browser");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pkg = readJson(join(packageRoot, "package.json"));
const ortVersion = readJson(join(packageRoot, "node_modules/onnxruntime-web/package.json")).version;

// ORT's JS glue is bundled into our files, but its .wasm files are not: src/runtime/ort.ts points ORT at the
// onnxruntime-web release on jsDelivr when this flag is set (see the comment at the top of that file).
const define = { __CIPETPET_BROWSER_BUNDLE__: "true" };
const common = { bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "warning", define };
const banner = {
  js: `/*! cipetpet ${pkg.version} (${pkg.license}) | bundles onnxruntime-web ${ortVersion} (MIT) | ${pkg.homepage} */`,
};


/** Builds the files of dist/browser into `browserOut` (esbuild only, no tsc). Returns the file names. */
export async function buildBrowser(browserOut = defaultBrowserOut) {
  rmSync(browserOut, { recursive: true, force: true });
  mkdirSync(browserOut, { recursive: true });

  // ORT's WebGPU build is a second, larger runtime that most pages never need. It becomes its own file and the
  // library reaches it with `import("./ort-webgpu.js")`, relative to the bundle's own URL.
  const webgpuEntry = fileURLToPath(import.meta.resolve("onnxruntime-web/webgpu"));
  await build({
    ...common,
    entryPoints: { "ort-webgpu": webgpuEntry },
    outdir: browserOut,
    minify: true,
    banner: { js: `/*! onnxruntime-web ${ortVersion} (MIT), WebGPU build, as shipped by the package */` },
  });

  const lazyWebgpu = {
    name: "cipetpet-lazy-webgpu",
    setup(b) {
      b.onResolve({ filter: /^onnxruntime-web\/webgpu$/ }, () => ({ path: "./ort-webgpu.js", external: true }));
    },
  };

  for (const minify of [false, true]) {
    await build({
      ...common,
      entryPoints: { [minify ? "cipetpet.min" : "cipetpet"]: join(packageRoot, "src/index.ts") },
      outdir: browserOut,
      minify,
      sourcemap: minify ? "linked" : false,
      banner,
      plugins: [lazyWebgpu],
    });
  }

  // The worker is one file with everything inside (the WebGPU build too), so it can be copied anywhere.
  await build({
    ...common,
    entryPoints: { worker: join(packageRoot, "src/worker/worker.ts") },
    outdir: browserOut,
    minify: true,
    sourcemap: "linked",
    banner,
  });
  return ["cipetpet.js", "cipetpet.min.js", "ort-webgpu.js", "worker.js"];
}

async function main() {
  execFileSync(process.execPath, [tsc, "-p", tsconfig], { cwd: packageRoot, stdio: "inherit" });

  // ---- dist/esm/worker/worker.js: the worker as one file (a bundler cannot see inside `new URL("./worker.js")`)
  mkdirSync(dirname(workerOut), { recursive: true });
  await build({
    ...common,
    entryPoints: [join(packageRoot, "src/worker/worker.ts")],
    outfile: workerOut,
    sourcemap: true,
    logLevel: "info",
  });

  const files = await buildBrowser();
  const kb = (file) => `${(statSync(join(defaultBrowserOut, file)).size / 1024).toFixed(0)} KiB`;
  console.log(
    "cipetpet: built dist/ (ESM, declarations, worker bundle) and dist/browser/ (" + files.map((f) => `${f} ${kb(f)}`).join(", ") + ")",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
