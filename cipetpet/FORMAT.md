# The `.cpet` pack format (version 1)

A `.cpet` pack is one binary file that holds everything a cipetpet model needs at run time: the ONNX
graphs, numeric tables, tokenizer, text-frontend data, model metadata and, optionally, the ONNX Runtime
WebAssembly binary. A page fetches one file per model, and the library reads it without any other
request.

All integers are little-endian. Offsets are in bytes.

## Layout

```
offset  size  field
0       4     magic            "CPET" (0x43 0x50 0x45 0x54)
4       2     formatVersion    u16, = 1
6       2     flags            u16, reserved, = 0 (readers must reject unknown bits)
8       4     headerLength     u32, byte length of the UTF-8 JSON header
12      4     headerCrc32      u32, CRC-32 (IEEE 802.3, the zlib/PNG one) of the header bytes
16      H     header           UTF-8 JSON, H = headerLength
16+H    …     zero padding to the next multiple of 64
D       …     data section     D = align64(16 + H); entry payloads, each starting at a multiple of 64
                               (relative to D), zero padding between them
```

The file ends right after the last payload (no trailing padding is required). A reader must reject a
file whose magic, version, flags or header CRC do not match, and any entry whose range lies outside the
file.

## Header

```jsonc
{
  "format": "cipetpet",            // fixed
  "version": 1,                     // = formatVersion
  "generator": "cipetpet-pack 0.1.0",
  "model": {
    "id": "antalia-mini",           // "antalia-mini" | "duyu-small"
    "name": "Antalia-2 Mini",
    "version": "1.0.0",             // the model release
    "task": "text-to-speech",       // "text-to-speech" | "speech-recognition"
    "variant": "mixed",             // precision set inside: antalia mixed|fp32|fp16|int8, duyu int8|q4|fp32
    "license": "Apache-2.0",
    "source": "https://huggingface.co/...",
    "languages": ["tr"]
  },
  "runtime": { "onnxruntime": "1.30.0" },   // ORT version the graphs were checked with
  "meta": { },                      // model-specific configuration (see below)
  "entries": [
    {
      "name": "graphs/text.onnx",   // unique, "/"-separated, no leading "/"
      "type": "onnx",               // onnx | json | text | tensor | bytes | wasm
      "offset": 0,                  // payload start, relative to the data section, multiple of 64
      "storedSize": 4048328,        // payload bytes in the file
      "size": 4048328,              // bytes after decoding
      "encoding": "raw",            // raw | gzip  (gzip = RFC 1952, one member)
      "sha256": "6b74…",            // hex SHA-256 of the DECODED bytes (64 chars)
      "dtype": "float32",           // tensor only: float32 | float64 | int32 | int64 | uint8
      "shape": [3, 256]             // tensor only: row-major, product * itemsize == size
    }
  ]
}
```

Readers ignore header keys they do not know, so later versions can add keys without bumping
`formatVersion`.

## Entries per model

**antalia-mini** (`model.task = "text-to-speech"`):

| entry | type | content |
|---|---|---|
| `graphs/text.onnx`, `graphs/cond.onnx`, `graphs/flow.onnx`, `graphs/vocoder.onnx` | onnx | the four graphs, at the precision the `variant` names |
| `frontend/data.json` | json (gzip) | the Turkish text normaliser's data (lexicon, CMU respellings, vocabulary) |
| `model/manifest.json` | json | the release manifest: symbols, defaults, synthesis options |

`meta`: `{ "sampleRate": 48000, "precision": { "text": "", "cond": "", "flow": "", "vocoder": ".fp16" } }`

**duyu-small** (`model.task = "speech-recognition"`):

| entry | type | content |
|---|---|---|
| `graphs/encoder_pre.onnx`, `graphs/encoder_pass.onnx`, `graphs/encoder_post.onnx`, `graphs/decoder.onnx` | onnx | the four graphs at the `variant` precision |
| `tables/fbank_window` | tensor float32 [400] | Povey window |
| `tables/fbank_mel` | tensor float32 [257, 80] | mel filter bank |
| `tables/pass_gates` | tensor float32 [3] | refinement-pass gates |
| `tables/pass_embed` | tensor float32 [3, 256] | refinement-pass embeddings |
| `tokenizer/pieces.json` | json | SentencePiece vocabulary: `{ "pieces": [[piece, type], …] }`, type 1 normal, 2 unknown, 3 control, 4 user-defined, 5 unused, 6 byte |
| `model/engine.json`, `model/config.json` | json | special token ids, model configuration |

`meta`: `{ "sampleRate": 16000 }`

**Optional, any model**: `runtime/ort-wasm-simd-threaded.wasm` (type `wasm`), the ONNX Runtime Web
WASM binary of the version in `runtime.onnxruntime`. When it is present and its version matches the
ORT JavaScript the library runs, the library hands it to ORT (`env.wasm.wasmBinary`), so no `.wasm`
file has to be served next to the page.

## Integrity

Each entry carries the SHA-256 of its decoded bytes. Readers verify it when the entry is read (the
library does by default; `verify: false` skips it). The header CRC catches a truncated or edited header
before any entry is touched.
