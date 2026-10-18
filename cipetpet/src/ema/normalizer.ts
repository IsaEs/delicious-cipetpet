// normalizer-tr (Rust, compiled to WebAssembly with wasm-bindgen) for EMA Lightning: written Turkish in, spoken
// Turkish out, with the "fallback" policy of the Python package. The .wasm comes from the pack
// (`frontend/normalizer.wasm`); this file is the binding wasm-bindgen would generate as JS glue, written once so
// it works with any build of the crate in ../ema-lightning-web/web/normalizer:
//
// * every instance owns its WebAssembly instance (the generated glue keeps one per page, in module globals);
// * imports are matched by name without wasm-bindgen's per-build hash suffix (`__wbg_Error_30c8987f7c2ed4e2`
//   -> `__wbg_Error_`), so a rebuild with another wasm-bindgen version still links, and an import this file does
//   not know fails the load with its name instead of a LinkError.
//
// The crate exports `TurkishNormalizer { new() -> Result<Self, JsError>, normalize(&str) -> Result<String, JsError> }`.

interface NormalizerExports {
  memory: WebAssembly.Memory;
  turkishnormalizer_new(): [number, number, number];
  turkishnormalizer_normalize(self: number, ptr: number, len: number): [number, number, number, number];
  __wbg_turkishnormalizer_free(self: number, flag: number): void;
  __wbindgen_malloc(size: number, align: number): number;
  __wbindgen_free(ptr: number, size: number, align: number): void;
  __wbindgen_externrefs: WebAssembly.Table;
  __externref_table_dealloc(index: number): void;
  __wbindgen_start?(): void;
}

const REQUIRED_EXPORTS = [
  "memory",
  "turkishnormalizer_new",
  "turkishnormalizer_normalize",
  "__wbg_turkishnormalizer_free",
  "__wbindgen_malloc",
  "__wbindgen_free",
  "__wbindgen_externrefs",
  "__externref_table_dealloc",
] as const;

const encoder = new TextEncoder();

export class TurkishNormalizer {
  readonly #wasm: NormalizerExports;
  readonly #decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
  #ptr: number;

  private constructor(wasm: NormalizerExports) {
    this.#wasm = wasm;
    const [ptr, error, failed] = wasm.turkishnormalizer_new();
    if (failed) throw this.#takeError(error);
    this.#ptr = ptr;
  }

  /** Compiles and links the crate's WebAssembly, then builds its normalizer. */
  static async create(bytes: Uint8Array): Promise<TurkishNormalizer> {
    let module: WebAssembly.Module;
    try {
      module = await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
    } catch (e) {
      throw new Error(`cipetpet: the pack's normalizer-tr WebAssembly does not compile: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    let wasm: NormalizerExports | undefined;
    const exports = (): NormalizerExports => {
      if (!wasm) throw new Error("cipetpet: normalizer-tr called back before it was instantiated");
      return wasm;
    };
    const instance = await WebAssembly.instantiate(module, imports(module, exports));
    const names = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
    const missing = REQUIRED_EXPORTS.filter((n) => !names.has(n));
    if (missing.length) throw new Error(`cipetpet: the pack's normalizer-tr WebAssembly lacks ${missing.join(", ")} (not a build of the ema-lightning-web normalizer crate)`);
    wasm = instance.exports as unknown as NormalizerExports;
    wasm.__wbindgen_start?.();
    return new TurkishNormalizer(wasm);
  }

  /** Written Turkish -> spoken Turkish. Throws the normaliser's own error (invalid input, a resource limit). */
  normalize(text: string): string {
    if (!this.#ptr) throw new Error("cipetpet: this normalizer has been freed");
    const w = this.#wasm;
    const input = encoder.encode(text);
    const inPtr = w.__wbindgen_malloc(input.length, 1) >>> 0;
    new Uint8Array(w.memory.buffer).set(input, inPtr);
    // the crate takes ownership of the input buffer; the output buffer is ours to free
    const [outPtr, outLen, error, failed] = w.turkishnormalizer_normalize(this.#ptr, inPtr, input.length);
    if (failed) throw this.#takeError(error);
    try {
      return this.#decoder.decode(new Uint8Array(w.memory.buffer, outPtr >>> 0, outLen));
    } finally {
      w.__wbindgen_free(outPtr, outLen, 1);
    }
  }

  /** Frees the Rust object; the instance's memory goes with the last reference to this object. */
  free(): void {
    if (!this.#ptr) return;
    const ptr = this.#ptr;
    this.#ptr = 0;
    this.#wasm.__wbg_turkishnormalizer_free(ptr, 0);
  }

  #takeError(index: number): unknown {
    const value: unknown = this.#wasm.__wbindgen_externrefs.get(index);
    this.#wasm.__externref_table_dealloc(index);
    return value;
  }
}

/** The import object for `module`: wasm-bindgen's helpers, by name without the build hash. */
function imports(module: WebAssembly.Module, exports: () => NormalizerExports): WebAssembly.Imports {
  const text = (ptr: number, len: number) => new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(new Uint8Array(exports().memory.buffer, ptr >>> 0, len));
  const known: [RegExp, (...args: number[]) => unknown][] = [
    [/^__wbg_Error_[0-9a-f]+$/, (ptr, len) => Error(text(ptr, len))],
    [/^__wbg___wbindgen_throw_[0-9a-f]+$/, (ptr, len) => {
      throw new Error(text(ptr, len));
    }],
    [/^__wbindgen_throw$/, (ptr, len) => {
      throw new Error(text(ptr, len));
    }],
    [/^__wbindgen_init_externref_table$/, () => {
      const table = exports().__wbindgen_externrefs;
      const offset = table.grow(4);
      table.set(0, undefined);
      table.set(offset + 0, undefined);
      table.set(offset + 1, null);
      table.set(offset + 2, true);
      table.set(offset + 3, false);
    }],
  ];
  const out: Record<string, Record<string, (...args: number[]) => unknown>> = {};
  for (const { module: from, name, kind } of WebAssembly.Module.imports(module)) {
    const fn = kind === "function" ? known.find(([pattern]) => pattern.test(name))?.[1] : undefined;
    if (!fn) {
      throw new Error(`cipetpet: the pack's normalizer-tr WebAssembly imports ${kind} "${from}.${name}", which this cipetpet version does not provide (rebuild the normalizer with ema-lightning-web's normalizer crate)`);
    }
    (out[from] ??= {})[name] = fn;
  }
  return out;
}
