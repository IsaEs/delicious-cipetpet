// Reads .cpet packs (FORMAT.md) from bytes, a Blob or a URL.
import { crc32 } from "./crc32.js";
import { gunzip, sha256Hex } from "./codec.js";
import { PACK_ALIGN, PACK_MAGIC, PACK_PREAMBLE, PACK_VERSION } from "./types.js";
import type {
  PackEntry,
  PackHeader,
  PackLoadOptions,
  PackModelInfo,
  PackSource,
  PackTensor,
  TensorDType,
  TypedTensorData,
} from "./types.js";

export const DEFAULT_CACHE_NAME = "cipetpet-packs";

const SRI_SHA256 = /^sha256-([A-Za-z0-9+/]{43}=)$/;

/** The base64 digests of a "sha256-<base64>[ sha256-<base64> …]" string; throws on any other form. */
function parseIntegrity(value: string): string[] {
  const tokens = typeof value === "string" ? value.trim().split(/\s+/) : [];
  const digests = tokens.map((t) => SRI_SHA256.exec(t)?.[1]);
  if (!tokens[0] || digests.some((d) => d === undefined)) {
    throw new TypeError(`cipetpet: integrity must look like "sha256-<base64 digest>" (a SHA-256 SRI string), got ${JSON.stringify(value)}`);
  }
  return digests as string[];
}

/** "sha256-<base64>" of `bytes`. */
async function sriOf(bytes: Uint8Array): Promise<string> {
  const hex = await sha256Hex(bytes);
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return `sha256-${btoa(bin)}`;
}

/** The "sha256-<base64>" of `bytes` when it is none of the digests of `integrity`, else undefined. */
async function integrityMismatch(bytes: Uint8Array, integrity: string): Promise<string | undefined> {
  const wanted = parseIntegrity(integrity);
  const got = await sriOf(bytes);
  return wanted.includes(got.slice("sha256-".length)) ? undefined : got;
}

/** Throws unless `bytes` hashes to one of the digests of `integrity`; `what` names the source in the error. */
export async function verifyIntegrity(bytes: Uint8Array, integrity: string, what: string): Promise<void> {
  const got = await integrityMismatch(bytes, integrity);
  if (got !== undefined) {
    throw new Error(`cipetpet: integrity check failed for ${what}: expected ${integrity.trim()}, got ${got} (${bytes.byteLength} bytes)`);
  }
}

const ENCODINGS = new Set(["raw", "gzip"]);

const DTYPES: Record<TensorDType, { size: number; make: (b: ArrayBuffer, off: number, n: number) => TypedTensorData }> = {
  float32: { size: 4, make: (b, o, n) => new Float32Array(b, o, n) },
  float64: { size: 8, make: (b, o, n) => new Float64Array(b, o, n) },
  int32: { size: 4, make: (b, o, n) => new Int32Array(b, o, n) },
  int64: { size: 8, make: (b, o, n) => new BigInt64Array(b, o, n) },
  uint8: { size: 1, make: (b, o, n) => new Uint8Array(b, o, n) },
};

/** Bytes per element of a tensor dtype. */
export function dtypeSize(dtype: TensorDType): number {
  return DTYPES[dtype].size;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const align = (n: number) => Math.ceil(n / PACK_ALIGN) * PACK_ALIGN;
const isUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export class Pack {
  readonly header: PackHeader;
  readonly byteLength: number;
  readonly #bytes: Uint8Array;
  readonly #data: number;
  readonly #entries: Map<string, PackEntry>;
  readonly #verify: boolean;
  readonly #label: string;

  private constructor(bytes: Uint8Array, header: PackHeader, data: number, entries: Map<string, PackEntry>, verify: boolean, label: string) {
    this.#bytes = bytes;
    this.header = header;
    this.byteLength = bytes.byteLength;
    this.#data = data;
    this.#entries = entries;
    this.#verify = verify;
    this.#label = label;
  }

  /** Parse a pack held in memory. Raw entries stay views into `bytes`, so do not modify it afterwards. */
  static async fromBytes(bytes: ArrayBuffer | Uint8Array, opts: PackLoadOptions = {}): Promise<Pack> {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (opts.integrity !== undefined) await verifyIntegrity(view, opts.integrity, "the pack bytes");
    return Pack.#parse(view, opts);
  }

  /** Read a Blob or File (with progress when `onProgress` is given). */
  static async fromBlob(blob: Blob, opts: PackLoadOptions = {}): Promise<Pack> {
    const name = (blob as Partial<File>).name;
    const bytes = opts.onProgress || opts.signal
      ? await readBody(blob.stream(), blob.size, opts)
      : new Uint8Array(await blob.arrayBuffer());
    if (opts.integrity !== undefined) await verifyIntegrity(bytes, opts.integrity, name ? `"${name}"` : "the pack blob");
    return Pack.#parse(bytes, opts, name || undefined);
  }

  /** Fetch and parse a pack; see `fetchBytes` for progress, abort, caching and integrity. */
  static async fromUrl(url: string | URL, opts: PackLoadOptions = {}): Promise<Pack> {
    const href = String(url);
    let pack: Pack | undefined;
    // The header is parsed before anything is cached, and a cached copy that no longer parses is dropped:
    // an HTML fallback page or a truncated body must not stay under the pack URL.
    await fetchBytes(url, opts, (bytes) => {
      pack = Pack.#parse(bytes, opts, href);
    });
    return pack!;
  }

  static #parse(bytes: Uint8Array, opts: PackLoadOptions, source?: string): Pack {
    let label = source ?? "<bytes>";
    const fail = (msg: string): never => {
      throw new Error(`cipetpet pack ${label}: ${msg}`);
    };
    if (bytes.byteLength < PACK_PREAMBLE) fail(`not a .cpet pack (${bytes.byteLength} bytes, too short)`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== PACK_MAGIC) fail("not a .cpet pack (bad magic)");
    const version = dv.getUint16(4, true);
    if (version !== PACK_VERSION) fail(`unsupported format version ${version} (this reader handles ${PACK_VERSION})`);
    const flags = dv.getUint16(6, true);
    if (flags !== 0) fail(`unknown flags 0x${flags.toString(16)}`);
    const headerLength = dv.getUint32(8, true);
    if (PACK_PREAMBLE + headerLength > bytes.byteLength) fail(`truncated header (needs ${PACK_PREAMBLE + headerLength} bytes, file has ${bytes.byteLength})`);
    const headerBytes = bytes.subarray(PACK_PREAMBLE, PACK_PREAMBLE + headerLength);
    if (crc32(headerBytes) !== dv.getUint32(12, true)) fail("header CRC-32 mismatch (corrupt or edited header)");

    let header: PackHeader;
    try {
      header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes));
    } catch (e) {
      return fail(`header is not valid UTF-8 JSON (${(e as Error).message})`);
    }
    if (!header || typeof header !== "object" || header.format !== "cipetpet") fail('header "format" is not "cipetpet"');
    if (header.version !== version) fail(`header version ${header.version} does not match the preamble's ${version}`);
    const model = header.model;
    if (!model || typeof model.id !== "string" || typeof model.variant !== "string") fail("header has no model id / variant");
    // From here on errors name the model; a URL is the more useful handle when there is one.
    if (!source) label = `${model.id}-${model.variant}`;
    if (header.meta == null) header.meta = {};
    if (typeof header.meta !== "object") fail('header "meta" is not an object');
    if (!Array.isArray(header.entries)) fail('header "entries" is not an array');

    const data = align(PACK_PREAMBLE + headerLength);
    const entries = new Map<string, PackEntry>();
    for (const e of header.entries) {
      const name = e && typeof e.name === "string" ? e.name : "";
      const bad = (msg: string) => fail(`entry "${name}": ${msg}`);
      if (!name || name.startsWith("/")) bad("invalid name");
      if (entries.has(name)) bad("duplicate entry name");
      if (typeof e.type !== "string") bad("missing type");
      if (!ENCODINGS.has(e.encoding)) bad(`unknown encoding "${e.encoding}"`);
      if (!isUint(e.offset) || e.offset % PACK_ALIGN !== 0) bad(`offset ${e.offset} is not a multiple of ${PACK_ALIGN}`);
      if (!isUint(e.storedSize) || !isUint(e.size)) bad("invalid size / storedSize");
      if (e.encoding === "raw" && e.storedSize !== e.size) bad(`raw entry with storedSize ${e.storedSize} != size ${e.size}`);
      if (data + e.offset + e.storedSize > bytes.byteLength)
        bad(`payload [${data + e.offset}, ${data + e.offset + e.storedSize}) lies outside the file (${bytes.byteLength} bytes; truncated download?)`);
      if (typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.sha256)) bad("invalid sha256");
      if (e.type === "tensor") {
        if (!e.dtype || !(e.dtype in DTYPES)) bad(`unknown tensor dtype "${e.dtype}"`);
        if (!Array.isArray(e.shape) || !e.shape.every(isUint)) bad("invalid tensor shape");
        const expect = e.shape!.reduce((a, b) => a * b, 1) * DTYPES[e.dtype!].size;
        if (expect !== e.size) bad(`tensor ${e.dtype}[${e.shape!.join(", ")}] needs ${expect} bytes, entry has ${e.size}`);
      }
      entries.set(name, e);
    }
    return new Pack(bytes, header, data, entries, opts.verify !== false, label);
  }

  get model(): PackModelInfo {
    return this.header.model;
  }

  get meta(): Record<string, unknown> {
    return this.header.meta;
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  entry(name: string): PackEntry {
    const e = this.#entries.get(name);
    if (!e) throw new Error(`cipetpet pack ${this.#label}: no entry "${name}" (has: ${[...this.#entries.keys()].join(", ")})`);
    return e;
  }

  list(): PackEntry[] {
    return [...this.#entries.values()];
  }

  /** The decoded bytes of an entry, SHA-256 verified unless `verify: false`. A raw entry is a zero-copy
   * view into the pack; nothing is cached, so each call decodes (and verifies) again. */
  async bytes(name: string): Promise<Uint8Array> {
    const e = this.entry(name);
    const start = this.#data + e.offset;
    const stored = this.#bytes.subarray(start, start + e.storedSize);
    let out = stored;
    if (e.encoding === "gzip") {
      try {
        out = await gunzip(stored);
      } catch (err) {
        throw new Error(`cipetpet pack ${this.#label}: entry "${name}": gzip payload is corrupt (${(err as Error).message})`);
      }
    }
    if (out.byteLength !== e.size) throw new Error(`cipetpet pack ${this.#label}: entry "${name}": decoded ${out.byteLength} bytes, expected ${e.size}`);
    if (this.#verify) {
      const hash = await sha256Hex(out);
      if (hash !== e.sha256) throw new Error(`cipetpet pack ${this.#label}: entry "${name}": SHA-256 mismatch (corrupt pack), expected ${e.sha256}, got ${hash}`);
    }
    return out;
  }

  async text(name: string): Promise<string> {
    return new TextDecoder().decode(await this.bytes(name));
  }

  async json<T = unknown>(name: string): Promise<T> {
    const text = await this.text(name);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(`cipetpet pack ${this.#label}: entry "${name}": invalid JSON (${(err as Error).message})`);
    }
  }

  /** A tensor entry as a typed array that owns its (aligned) memory. */
  async tensor<T extends TypedTensorData = TypedTensorData>(name: string): Promise<PackTensor<T>> {
    const e = this.entry(name);
    if (e.type !== "tensor") throw new Error(`cipetpet pack ${this.#label}: entry "${name}" is a ${e.type}, not a tensor`);
    if (!LITTLE_ENDIAN) throw new Error("cipetpet: tensors are little-endian and this host is big-endian");
    const b = await this.bytes(name);
    const { size, make } = DTYPES[e.dtype!];
    // A decoded gzip payload is a fresh buffer we may keep; a raw one is a view into the pack (and possibly
    // misaligned for the element size), so it is copied.
    const owned = e.encoding === "gzip" && b.byteOffset % size === 0 ? b : b.slice();
    const data = make(owned.buffer as ArrayBuffer, owned.byteOffset, owned.byteLength / size) as T;
    return { dtype: e.dtype!, shape: [...e.shape!], data };
  }
}

/** Open a pack from any supported source. An open Pack is returned as is. */
export function openPack(source: PackSource, opts: PackLoadOptions = {}): Promise<Pack> {
  if (source instanceof Pack) return Promise.resolve(source);
  if (typeof source === "string" || source instanceof URL) return Pack.fromUrl(source, opts);
  if (source instanceof ArrayBuffer || source instanceof Uint8Array) return Pack.fromBytes(source, opts);
  if (typeof Blob !== "undefined" && source instanceof Blob) return Pack.fromBlob(source, opts);
  return Promise.reject(new TypeError("cipetpet: openPack expects a URL, an ArrayBuffer / Uint8Array, a Blob or a Pack"));
}

/** Download `url` into memory, streaming, with progress and abort; optionally through the Cache API.
 * With `opts.integrity` the bytes must hash to it (checked before anything is cached). `validate`
 * (internal) throws for bytes that are not a usable file: they are then not cached, and a cached copy
 * that fails it is deleted, so a bad response never sticks to the URL. */
export async function fetchBytes(url: string | URL, opts: PackLoadOptions = {}, validate?: (bytes: Uint8Array) => void): Promise<Uint8Array> {
  const href = String(url);
  if (opts.integrity !== undefined) parseIntegrity(opts.integrity); // a malformed value fails before any network use
  const signal = opts.signal ?? opts.requestInit?.signal ?? undefined;
  signal?.throwIfAborted();
  const cache = await openCache(opts.cache);

  let hit = cache ? await cache.match(href).catch(() => undefined) : undefined;
  if (hit && opts.integrity !== undefined) {
    // A copy from an earlier visit may be stale (the URL now serves another build) or damaged: check it
    // quietly, and drop it and download again when it does not match.
    const cached = await readResponse(hit, href, { ...opts, onProgress: undefined });
    if ((await integrityMismatch(cached, opts.integrity)) === undefined) {
      validate?.(cached);
      opts.onProgress?.({ loaded: cached.byteLength, total: cached.byteLength });
      return cached;
    }
    await cache!.delete?.(href).catch(() => {});
    hit = undefined;
  }

  const init: RequestInit = { ...opts.requestInit, signal };
  if (opts.integrity !== undefined) init.integrity = opts.integrity.trim();
  let res: Response;
  try {
    // global fetch is called as a plain function: some browsers throw "Illegal invocation" on a foreign `this`
    res = hit ?? (await (opts.fetch ? opts.fetch(href, init) : fetch(href, init)));
  } catch (e) {
    if (opts.integrity !== undefined && e instanceof TypeError) {
      // Browsers report a digest mismatch, a CORS failure and a dead network alike, as a TypeError. Ask once more
      // without the browser's check: the bytes are verified below, so a mismatch then gets the precise
      // "integrity check failed ... expected X, got Y" error. Only when that request fails too is it a real
      // network or CORS problem.
      const { integrity: _checkedByBrowser, ...plainInit } = init;
      try {
        res = await (opts.fetch ? opts.fetch(href, plainInit) : fetch(href, plainInit));
      } catch {
        throw new Error(
          `cipetpet: fetching ${href} failed: ${e.message} (integrity was set: this is also how the browser reports a SHA-256 mismatch, besides a network or CORS error)`,
          { cause: e },
        );
      }
    } else {
      throw e;
    }
  }
  const bytes = await readResponse(res, href, opts);
  if (opts.integrity !== undefined) await verifyIntegrity(bytes, opts.integrity, href);
  try {
    validate?.(bytes);
  } catch (e) {
    if (cache && hit) await cache.delete?.(href).catch(() => {});
    throw e;
  }

  if (cache && !hit) {
    // Best effort: a full quota or a private-mode cache must not fail the load.
    const headers = { "content-type": res.headers.get("content-type") ?? "application/octet-stream", "content-length": String(bytes.byteLength) };
    await cache.put(href, new Response(bytes as Uint8Array<ArrayBuffer>, { headers })).catch(() => {});
  }
  return bytes;
}

/** The body of a fetch response, with progress. */
async function readResponse(res: Response, href: string, opts: PackLoadOptions): Promise<Uint8Array> {
  if (!res.ok) throw new Error(`cipetpet: fetching ${href} failed: HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}`);

  // Content-Length counts the bytes on the wire, which differ from the body we read when the server
  // compresses the response, so it is only a usable total without Content-Encoding.
  const length = Number(res.headers.get("content-length"));
  const encoding = (res.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  const total = encoding === "identity" && Number.isSafeInteger(length) && length > 0 ? length : 0;

  const bytes = res.body ? await readBody(res.body, total, opts) : new Uint8Array(await res.arrayBuffer());
  if (!res.body) opts.onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
  return bytes;
}

async function openCache(option: PackLoadOptions["cache"]): Promise<Cache | undefined> {
  if (!option || typeof caches === "undefined") return undefined;
  try {
    return await caches.open(typeof option === "string" ? option : DEFAULT_CACHE_NAME);
  } catch {
    return undefined; // e.g. SecurityError in opaque origins
  }
}

/** Read a byte stream to the end. `total` (0 = unknown) presizes the buffer; progress is reported per
 * chunk, and once more at the end with total = loaded when the announced total was missing or wrong. */
async function readBody(body: ReadableStream<Uint8Array>, total: number, opts: PackLoadOptions): Promise<Uint8Array> {
  const { onProgress, signal } = opts;
  const reader = body.getReader();
  // Cancelling the reader wakes a pending read(), so an abort takes effect even when a (custom) fetch
  // ignores the signal.
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  const presized = total > 0;
  let buf = new Uint8Array(total);
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    onProgress?.({ loaded: 0, total });
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (presized) {
        if (loaded + value.byteLength > buf.byteLength) {
          // more than announced: grow, and report the size as unknown from here on
          const grown = new Uint8Array(Math.max(buf.byteLength * 2, loaded + value.byteLength));
          grown.set(buf.subarray(0, loaded));
          buf = grown;
          total = 0;
        }
        buf.set(value, loaded);
      } else {
        chunks.push(value);
      }
      loaded += value.byteLength;
      onProgress?.({ loaded, total });
    }
  } catch (err) {
    reader.cancel(err).catch(() => {});
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  let out: Uint8Array;
  if (presized) {
    out = loaded === buf.byteLength ? buf : buf.slice(0, loaded);
  } else {
    out = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
  }
  if (loaded !== total) onProgress?.({ loaded, total: loaded });
  return out;
}
