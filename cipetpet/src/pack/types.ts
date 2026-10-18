// Types of the .cpet pack format (FORMAT.md). Shared by the reader, the writer and the model loaders.

export const PACK_MAGIC = 0x54455043; // "CPET" read as a little-endian u32
export const PACK_VERSION = 1;
export const PACK_ALIGN = 64;
export const PACK_PREAMBLE = 16; // magic + version + flags + headerLength + headerCrc32

export type EntryType = "onnx" | "json" | "text" | "tensor" | "bytes" | "wasm";
export type EntryEncoding = "raw" | "gzip";
export type TensorDType = "float32" | "float64" | "int32" | "int64" | "uint8";

export interface PackEntry {
  name: string;
  type: EntryType;
  /** payload start, relative to the data section */
  offset: number;
  storedSize: number;
  size: number;
  encoding: EntryEncoding;
  /** hex SHA-256 of the decoded bytes */
  sha256: string;
  dtype?: TensorDType;
  shape?: number[];
}

export type ModelId = "antalia-mini" | "ema-lightning" | "duyu-small";
export type ModelTask = "text-to-speech" | "speech-recognition";

export interface PackModelInfo {
  id: ModelId | (string & {});
  name: string;
  version: string;
  task: ModelTask | (string & {});
  variant: string;
  license?: string;
  source?: string;
  languages?: string[];
}

export interface PackHeader {
  format: "cipetpet";
  version: number;
  generator?: string;
  model: PackModelInfo;
  runtime?: { onnxruntime?: string };
  meta: Record<string, unknown>;
  entries: PackEntry[];
}

export type TypedTensorData = Float32Array | Float64Array | Int32Array | BigInt64Array | Uint8Array;

export interface PackTensor<T extends TypedTensorData = TypedTensorData> {
  dtype: TensorDType;
  shape: number[];
  data: T;
}

export interface PackProgress {
  loaded: number;
  /** 0 when the size is unknown */
  total: number;
}

export interface PackLoadOptions {
  /** verify each entry's SHA-256 when it is read (default true) */
  verify?: boolean;
  onProgress?: (p: PackProgress) => void;
  signal?: AbortSignal;
  /** keep a copy in the Cache API: true = the "cipetpet-packs" cache, a string = that cache name.
   * Ignored where the Cache API is missing (Node, insecure contexts). Default false. */
  cache?: boolean | string;
  /** custom fetch (tests, auth headers) */
  fetch?: typeof fetch;
  /** extra RequestInit for the fetch (headers, credentials …) */
  requestInit?: RequestInit;
  /** Subresource-Integrity string of the whole pack file, "sha256-<base64>" (several, separated by spaces,
   * mean "any of these"). It is passed to `fetch` and the downloaded bytes are also hashed here, so it
   * holds for the Cache API path, for a custom `fetch`, and for packs given as bytes or a Blob. A mismatch
   * throws an error naming the source; a Cache API copy that fails the check is dropped and downloaded
   * again. packs/manifest.json lists the value for each shipped pack. */
  integrity?: string;
}

/** Input accepted wherever a pack is loaded: a URL, the file's bytes, a Blob / File, or an open Pack. */
export type PackSource = string | URL | ArrayBuffer | Uint8Array | Blob | import("./reader.js").Pack;

/** One entry handed to the writer. */
export interface PackInputEntry {
  name: string;
  type: EntryType;
  data: Uint8Array;
  /** "auto" (default): gzip when it saves at least 5 %; onnx and wasm entries default to raw */
  encoding?: EntryEncoding | "auto";
  dtype?: TensorDType;
  shape?: number[];
}

export interface PackInput {
  model: PackModelInfo;
  runtime?: { onnxruntime?: string };
  meta?: Record<string, unknown>;
  entries: PackInputEntry[];
  generator?: string;
}
