// ONNX Runtime Web setup shared by both models.
//
// ORT keeps its configuration in a module-global `env` that is read once, when the first session starts
// the WebAssembly runtime. So the first initRuntime() call decides threads, wasm paths, proxy and log
// level for the whole page; later calls reuse that and only pick a backend. A later call that asks for
// something different gets a console warning, not an error, since the models still work.
//
// Builds: the wasm backend imports "onnxruntime-web/wasm", the plain WebAssembly build whose binary is
// ort-wasm-simd-threaded.wasm (14 MB), i.e. the file a pack may embed (FORMAT.md). The package root,
// "onnxruntime-web", is the JSEP build in browsers: it needs ort-wasm-simd-threaded.jsep.wasm (28 MB) and
// fails to instantiate the plain binary. The webgpu backend imports "onnxruntime-web/webgpu", which has
// its own (asyncify) binary, fetched from `wasmPaths` or next to the bundle; the pack's binary never goes
// there. Outside browsers the wasm build only runs single-threaded (with threads it fetches its own
// script for the workers, which fails on Node's file: URLs); Node code that wants threads passes ORT's
// node build as `ort` (`await import("onnxruntime-web")` resolves to it under Node).
//
// Where ORT looks for its files (measured in node_modules/onnxruntime-web/dist): the "bundle" builds embed
// the JS glue (ort-wasm-simd-threaded.mjs) but not the .wasm; they look for ort-wasm-simd-threaded.wasm
// next to their own script (`new URL("ort-wasm-simd-threaded.wasm", import.meta.url)`). They use the glue
// they embed only when the script is same-origin to the page (or when they were given the binary and run one
// thread); otherwise they import the glue from next to that script as well. A bundler copies neither file,
// and our CDN bundle (dist/browser) does not ship them, so there ORT would look in a directory that does
// not have them. A pre-built bundle also cannot serve as ORT's thread worker script, since ORT's module is
// only evaluated on the first import() of it, so for threads the external glue is always the one to use. The
// browser bundle therefore points ORT at the matching onnxruntime-web release on jsDelivr (same version string
// as the ORT JS inside the bundle) unless the caller said where the files are (wasmPaths), handed over the
// binary (wasmBinary or a pack that embeds it), or supplied its own ORT module. ORT's own proxy worker
// (`proxy: true`) is not supported from the bundle (initRuntime warns); the library's worker is the way.

import type * as OrtNS from "onnxruntime-web";
import type { Backend, RuntimeOptions } from "../types.js";
import type { Pack } from "../pack/reader.js";
import { warnOnce } from "../util/log.js";

export type Ort = typeof OrtNS;

/** Set by tools/build.mjs (esbuild `define`) in the files under dist/browser, undefined elsewhere. */
declare const __CIPETPET_BROWSER_BUNDLE__: boolean | undefined;
const IS_BROWSER_BUNDLE = typeof __CIPETPET_BROWSER_BUNDLE__ !== "undefined" && __CIPETPET_BROWSER_BUNDLE__ === true;

/** The directory of an onnxruntime-web release on jsDelivr that holds ORT's .mjs and .wasm files. */
export function ortCdnBase(version: string): string {
  return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
}

export interface WasmPathsInput {
  /** running inside the dist/browser bundle (otherwise ORT's own location logic is left alone) */
  browserBundle: boolean;
  /** a page or a web worker */
  browser: boolean;
  /** the ORT module was imported by us (not handed over as `options.ort`) */
  ownImport: boolean;
  /** ORT already has a wasmPaths setting (from the caller) */
  hasWasmPaths: boolean;
  /** ORT has its WebAssembly binary (explicit wasmBinary, or taken from the pack) */
  hasBinary: boolean;
  /** WASM threads ORT will use */
  threads: number;
  /** ort.env.versions.web */
  version: string | undefined;
}

/** The wasmPaths to give ORT when the caller gave none: undefined (leave ORT's default), the jsDelivr
 * directory of this ORT version, or, when the binary comes from memory but threads need the JS glue file
 * (ORT only uses the glue embedded in the bundle for a single thread, or a same-origin script), just the
 * URL of that glue. */
export function defaultWasmPaths(i: WasmPathsInput): string | { mjs: string } | undefined {
  if (!i.browserBundle || !i.browser || !i.ownImport || i.hasWasmPaths || !i.version) return undefined;
  const base = ortCdnBase(i.version);
  if (!i.hasBinary) return base;
  return i.threads > 1 ? { mjs: `${base}ort-wasm-simd-threaded.mjs` } : undefined;
}

export interface Runtime {
  ort: Ort;
  /** the backend sessions run on; "wasm" when "webgpu" was asked for but the browser has no WebGPU */
  backend: Backend;
  /** WASM threads ORT was configured with */
  threads: number;
  crossOriginIsolated: boolean;
  /** onnxruntime-web version */
  version: string;
  /** an InferenceSession for a graph; `name` only labels errors */
  createSession(bytes: Uint8Array, name?: string): Promise<OrtNS.InferenceSession>;
}

/** pack entry holding the ORT WebAssembly binary (FORMAT.md, "Optional, any model") */
export const PACK_WASM_ENTRY = "runtime/ort-wasm-simd-threaded.wasm";

type LogLevel = NonNullable<RuntimeOptions["logLevel"]>;

/** the env settings fixed by the first initRuntime() */
interface EnvConfig {
  threads: number;
  wasmPaths?: string;
  proxy: boolean;
  logLevel: LogLevel;
}

/** what we know about one ORT module instance (wasm build, webgpu build, or an app-supplied one) */
interface ModuleState {
  /** a session was created, so ORT has read env.wasm and loaded its binary */
  started: boolean;
  /** the module is one we imported ourselves for the wasm backend, so the pack's binary fits it */
  ownWasmBuild: boolean;
}

let config: EnvConfig | undefined;
const modules = new WeakMap<object, ModuleState>();
let wasmImport: Promise<Ort> | undefined;
let webgpuImport: Promise<Ort> | undefined;

const isolated = (): boolean => (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
const cores = (): number => Math.max(1, globalThis.navigator?.hardwareConcurrency || 1);
/** a page or a web worker (not Node, Deno or Bun) */
const isBrowser = (): boolean => "document" in globalThis || typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined";
const hasWebGpu = (): boolean => !!(globalThis.navigator as { gpu?: unknown } | undefined)?.gpu;

function resolveThreads(requested: number | undefined, ownImport: boolean): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    // Threads need SharedArrayBuffer, which a page only gets when cross-origin isolated (COOP/COEP).
    // Half the cores, at most 4: beyond that the ops in these small graphs stop scaling.
    return isolated() ? Math.max(1, Math.min(4, Math.floor(cores() / 2))) : 1;
  }
  const n = Math.max(1, Math.min(Math.floor(requested), cores()));
  if (n > 1 && typeof SharedArrayBuffer === "undefined") {
    warnOnce("threads-sab", `threads: ${n} needs a cross-origin isolated page (COOP/COEP headers); running single-threaded`);
    return 1;
  }
  if (n > 1 && ownImport && !isBrowser()) {
    warnOnce(
      "threads-node",
      `threads: ${n} is not available with onnxruntime-web/wasm outside a browser; running single-threaded ` +
        `(pass { ort: await import("onnxruntime-web") } to use ORT's node build with threads)`,
    );
    return 1;
  }
  return n;
}

/** A tight copy when `b` is a view into a larger buffer: the proxy worker structured-clones env, which
 * would otherwise copy the whole underlying buffer (e.g. an entire pack). */
function ownBytes(b: ArrayBufferLike | Uint8Array): Uint8Array {
  if (!ArrayBuffer.isView(b)) return new Uint8Array(b);
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice();
}

function requestedConfig(opts: RuntimeOptions): EnvConfig {
  return {
    threads: resolveThreads(opts.threads, opts.ort === undefined),
    wasmPaths: opts.wasmPaths,
    proxy: opts.proxy ?? false,
    logLevel: opts.logLevel ?? "error",
  };
}

/** Warns (once per setting) about options that differ from the configuration already in force. Only
 * options the caller actually set count; an omitted option means "whatever is configured". */
function checkConflicts(opts: RuntimeOptions, want: EnvConfig, have: EnvConfig): void {
  const conflicts: [keyof EnvConfig, boolean][] = [
    ["threads", opts.threads !== undefined && want.threads !== have.threads],
    ["wasmPaths", opts.wasmPaths !== undefined && want.wasmPaths !== have.wasmPaths],
    ["proxy", opts.proxy !== undefined && want.proxy !== have.proxy],
    ["logLevel", opts.logLevel !== undefined && want.logLevel !== have.logLevel],
  ];
  for (const [key, differs] of conflicts) {
    if (!differs) continue;
    const shown = (c: EnvConfig) => (c[key] === undefined ? "(ORT default)" : JSON.stringify(c[key]));
    warnOnce(
      `conflict-${key}`,
      `ONNX Runtime is already configured with ${key} = ${shown(have)}; ignoring ${key} = ${shown(want)} ` +
        `(ORT's settings are global and fixed by the first initRuntime() call)`,
    );
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  // binaries are ~12 MB; comparing the length and a few sampled bytes is enough to tell builds apart
  const step = Math.max(1, Math.floor(a.byteLength / 4096));
  for (let i = 0; i < a.byteLength; i += step) if (a[i] !== b[i]) return false;
  return true;
}

function importOrt(backend: Backend): Promise<Ort> {
  // Literal specifiers, so bundlers see (and can split out) both builds.
  if (backend === "webgpu") {
    webgpuImport ??= import("onnxruntime-web/webgpu").catch((e: unknown) => {
      webgpuImport = undefined;
      throw new Error(`cipetpet: could not load onnxruntime-web/webgpu: ${message(e)}`, { cause: e });
    });
    return webgpuImport;
  }
  wasmImport ??= import("onnxruntime-web/wasm").catch((e: unknown) => {
    wasmImport = undefined;
    throw new Error(`cipetpet: could not load onnxruntime-web: ${message(e)}`, { cause: e });
  });
  return wasmImport;
}

function asOrt(mod: unknown): Ort {
  const m = mod as Partial<Ort> | null;
  if (!m || typeof m !== "object" || !m.InferenceSession || !m.Tensor || !m.env?.wasm) {
    throw new TypeError("cipetpet: options.ort is not an onnxruntime-web module (missing InferenceSession / Tensor / env)");
  }
  return m as Ort;
}

function configure(ort: Ort, cfg: EnvConfig): void {
  const env = ort.env;
  env.wasm.numThreads = cfg.threads;
  if (cfg.wasmPaths !== undefined) env.wasm.wasmPaths = cfg.wasmPaths;
  env.wasm.proxy = cfg.proxy;
  env.logLevel = cfg.logLevel;
}

/** Hands an explicit `wasmBinary` to the module of the call that passed it (the binary must match that
 * build, so it is not shared with the other backend's module). ORT reads it when its first session starts;
 * a different binary after that cannot take effect. */
function useExplicitBinary(ort: Ort, state: ModuleState, binary: ArrayBuffer | Uint8Array): void {
  const current = ort.env.wasm.wasmBinary;
  const bytes = ownBytes(binary);
  if (current !== undefined && sameBytes(ownBytes(current), bytes)) return;
  if (state.started || current !== undefined) {
    warnOnce(
      "conflict-wasmBinary",
      "ONNX Runtime has already been given its WebAssembly binary; ignoring the wasmBinary option " +
        "(ORT's settings are global and fixed by the first initRuntime() call)",
    );
    return;
  }
  ort.env.wasm.wasmBinary = bytes;
}

/** Hands the pack's ORT binary to the module, when it is the build the binary belongs to and ORT has not
 * started yet. A pack made for another ORT version is ignored with a warning (the JS glue and the binary
 * must come from the same release). */
async function usePackBinary(ort: Ort, state: ModuleState, pack: Pack): Promise<void> {
  if (!state.ownWasmBuild || state.started || ort.env.wasm.wasmBinary || !pack.has(PACK_WASM_ENTRY)) return;
  const packVersion = pack.header.runtime?.onnxruntime;
  const ortVersion = ort.env.versions?.web;
  if (!packVersion || packVersion !== ortVersion) {
    warnOnce(
      `pack-wasm-${packVersion}`,
      `the pack embeds the ONNX Runtime ${packVersion ?? "(unknown version)"} binary but onnxruntime-web ` +
        `${ortVersion ?? "(unknown version)"} is loaded; ignoring the embedded binary`,
    );
    return;
  }
  const bytes = ownBytes(await pack.bytes(PACK_WASM_ENTRY));
  // re-check: another initRuntime / session may have got there while the entry was read
  if (!state.started && !ort.env.wasm.wasmBinary) ort.env.wasm.wasmBinary = bytes;
}

/**
 * Loads and configures ONNX Runtime Web and returns a Runtime for the requested backend.
 * `pack`, when given, may supply the ORT WebAssembly binary (`runtime/ort-wasm-simd-threaded.wasm`).
 */
export async function initRuntime(opts: RuntimeOptions = {}, pack?: Pack): Promise<Runtime> {
  let backend: Backend = opts.backend ?? "wasm";
  if (backend !== "wasm" && backend !== "webgpu") throw new TypeError(`cipetpet: unknown backend "${String(backend)}"`);
  if (backend === "webgpu" && !hasWebGpu()) {
    warnOnce("no-webgpu", "WebGPU is not available here (navigator.gpu is missing); using the wasm backend");
    backend = "wasm";
  }

  // Fixed synchronously, so concurrent first calls agree on one configuration.
  const want = requestedConfig(opts);
  if (config) checkConflicts(opts, want, config);
  else config = want;
  const cfg = config;

  const ort = opts.ort !== undefined ? asOrt(opts.ort) : await importOrt(backend);
  let state = modules.get(ort);
  if (!state) {
    state = { started: false, ownWasmBuild: opts.ort === undefined && backend === "wasm" };
    modules.set(ort, state);
    configure(ort, cfg);
    if (IS_BROWSER_BUNDLE && cfg.proxy && opts.ort === undefined) {
      warnOnce(
        "bundle-proxy",
        "proxy: true is not supported with the cipetpet CDN bundle (ORT's own proxy worker cannot start from the bundled " +
          "module); use createAntaliaWorker / createDuyuWorker to keep inference off the main thread",
      );
    }
  }
  if (opts.wasmBinary !== undefined) useExplicitBinary(ort, state, opts.wasmBinary);
  else if (pack) await usePackBinary(ort, state, pack);

  const st = state;
  const ownImport = opts.ort === undefined;
  const providers = backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
  return {
    ort,
    backend,
    threads: ort.env.wasm.numThreads ?? cfg.threads,
    crossOriginIsolated: isolated(),
    version: ort.env.versions?.web ?? "unknown",
    async createSession(bytes: Uint8Array, name = "model") {
      if (!st.started) {
        // ORT reads env.wasm when its first session starts, so the binary decisions above are final here
        const paths = defaultWasmPaths({
          browserBundle: IS_BROWSER_BUNDLE,
          browser: isBrowser(),
          ownImport,
          hasWasmPaths: ort.env.wasm.wasmPaths !== undefined,
          hasBinary: ort.env.wasm.wasmBinary !== undefined,
          threads: ort.env.wasm.numThreads ?? cfg.threads,
          version: ort.env.versions?.web,
        });
        if (paths !== undefined) ort.env.wasm.wasmPaths = paths as typeof ort.env.wasm.wasmPaths;
      }
      st.started = true;
      const options: OrtNS.InferenceSession.SessionOptions = {
        executionProviders: providers,
        graphOptimizationLevel: "all",
      };
      try {
        // In proxy mode ORT transfers the model's ArrayBuffer to its worker, which would detach the
        // caller's buffer (a pack's data, when `bytes` is a zero-copy view into it).
        return await ort.InferenceSession.create(ort.env.wasm.proxy ? bytes.slice() : bytes, options);
      } catch (e) {
        throw new Error(`cipetpet: could not create an ONNX Runtime session for "${name}" (${backend}): ${message(e)}`, {
          cause: e,
        });
      }
    },
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
