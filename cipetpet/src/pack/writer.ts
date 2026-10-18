// Writes .cpet packs (FORMAT.md). The output depends only on the input (no timestamps), so building the
// same pack twice gives identical bytes.
import { crc32 } from "./crc32.js";
import { gzip, sha256Hex } from "./codec.js";
import { dtypeSize } from "./reader.js";
import { PACK_ALIGN, PACK_MAGIC, PACK_PREAMBLE, PACK_VERSION } from "./types.js";
import type { EntryEncoding, PackEntry, PackHeader, PackInput, PackInputEntry, TensorDType } from "./types.js";

export const PACK_GENERATOR = "cipetpet-pack 0.1.0";

/** "auto" stores an entry gzipped only when that saves at least this fraction of its size. */
const AUTO_GZIP_MIN_SAVING = 0.05;

const TYPES = new Set(["onnx", "json", "text", "tensor", "bytes", "wasm"]);
const DTYPES = new Set<TensorDType>(["float32", "float64", "int32", "int64", "uint8"]);

const align = (n: number) => Math.ceil(n / PACK_ALIGN) * PACK_ALIGN;

/** Encode one entry's payload: returns the stored bytes and the encoding used. */
async function encode(e: PackInputEntry): Promise<{ stored: Uint8Array; encoding: EntryEncoding }> {
  // ONNX weights and WASM code barely compress, and raw entries can be handed to ORT without a copy.
  const mode = e.encoding ?? (e.type === "onnx" || e.type === "wasm" ? "raw" : "auto");
  if (mode === "raw") return { stored: e.data, encoding: "raw" };
  const gz = await gzip(e.data);
  if (mode === "gzip" || gz.byteLength <= e.data.byteLength * (1 - AUTO_GZIP_MIN_SAVING)) return { stored: gz, encoding: "gzip" };
  return { stored: e.data, encoding: "raw" };
}

function check(e: PackInputEntry, seen: Set<string>): void {
  const bad = (msg: string): never => {
    throw new Error(`cipetpet writePack: entry "${e.name}": ${msg}`);
  };
  if (typeof e.name !== "string" || !e.name || e.name.startsWith("/") || e.name.includes("\\")) bad("invalid name");
  if (seen.has(e.name)) bad("duplicate name");
  seen.add(e.name);
  if (!TYPES.has(e.type)) bad(`unknown type "${e.type}"`);
  if (!(e.data instanceof Uint8Array)) bad("data is not a Uint8Array");
  if (e.encoding !== undefined && !["raw", "gzip", "auto"].includes(e.encoding)) bad(`unknown encoding "${e.encoding}"`);
  if (e.type === "tensor") {
    if (!e.dtype || !DTYPES.has(e.dtype)) bad(`unknown tensor dtype "${e.dtype}"`);
    if (!Array.isArray(e.shape) || !e.shape.every((d) => Number.isSafeInteger(d) && d >= 0)) bad("invalid tensor shape");
    const expect = e.shape!.reduce((a, b) => a * b, 1) * dtypeSize(e.dtype!);
    if (expect !== e.data.byteLength) bad(`tensor ${e.dtype}[${e.shape!.join(", ")}] needs ${expect} bytes, data has ${e.data.byteLength}`);
  } else if (e.dtype !== undefined || e.shape !== undefined) {
    bad("dtype / shape are only allowed on tensor entries");
  }
}

/** Build a pack. Entries are laid out in the given order, each at a 64-byte boundary. */
export async function writePack(input: PackInput): Promise<Uint8Array<ArrayBuffer>> {
  if (!input.model || typeof input.model.id !== "string" || typeof input.model.variant !== "string")
    throw new Error("cipetpet writePack: model.id and model.variant are required");
  const seen = new Set<string>();
  for (const e of input.entries) check(e, seen);

  const payloads: Uint8Array[] = [];
  const entries: PackEntry[] = [];
  let end = 0;
  for (const e of input.entries) {
    const [{ stored, encoding }, sha256] = await Promise.all([encode(e), sha256Hex(e.data)]);
    const offset = align(end);
    // fixed key order keeps the header (and so the file) deterministic
    const entry: PackEntry = { name: e.name, type: e.type, offset, storedSize: stored.byteLength, size: e.data.byteLength, encoding, sha256 };
    if (e.type === "tensor") {
      entry.dtype = e.dtype;
      entry.shape = [...e.shape!];
    }
    entries.push(entry);
    payloads.push(stored);
    end = offset + stored.byteLength;
  }

  const header: PackHeader = {
    format: "cipetpet",
    version: PACK_VERSION,
    generator: input.generator ?? PACK_GENERATOR,
    model: input.model,
    ...(input.runtime ? { runtime: input.runtime } : {}),
    meta: input.meta ?? {},
    entries,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const data = align(PACK_PREAMBLE + headerBytes.byteLength);

  const out = new Uint8Array(data + end); // zero-filled, which is the padding
  const dv = new DataView(out.buffer);
  dv.setUint32(0, PACK_MAGIC, true);
  dv.setUint16(4, PACK_VERSION, true);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, headerBytes.byteLength, true);
  dv.setUint32(12, crc32(headerBytes), true);
  out.set(headerBytes, PACK_PREAMBLE);
  entries.forEach((e, i) => out.set(payloads[i], data + e.offset));
  return out;
}
