# Loading cipetpet from CDNs

A page with no build step can load all three parts of cipetpet from the network:

| part | what it is | where it can live |
| --- | --- | --- |
| the library | `dist/browser/cipetpet.min.js` (+ `worker.js`, `ort-webgpu.js`), from the npm package | jsDelivr, unpkg |
| ONNX Runtime WebAssembly | `ort-wasm-simd-threaded.{mjs,wasm}` of the onnxruntime-web release the library was built with | jsDelivr, unpkg (the library points there by default) |
| the model packs | `*.cpet`, 10 to 56 MB each | a host you control or a model host such as Hugging Face (section 3) |

```html
<script type="module">
  import { AntaliaMini } from "https://cdn.jsdelivr.net/npm/cipetpet@VERSION/dist/browser/cipetpet.min.js";
  const tts = await AntaliaMini.load("https://<pack host>/antalia-mini-int8.cpet");
  const { audio, sampleRate } = await tts.synthesize("Merhaba dünya!");
</script>
```

Complete pages are in section 7.

## What was verified, and what was not

Everything below marked **Verified** was observed on 2026-10-17 with `curl` from one machine (headers) or with the
tests in `test/` (code behaviour), against `onnxruntime-web@1.30.0`, the version this build contains. Hosts change
their behaviour; re-check with the commands shown if something matters to you.

- **Verified in headless Chrome 155.0.8059.84 (Chrome for Testing, macOS arm64) on 2026-10-17**, against a local
  stand-in for a CDN: the page on `http://localhost:<P>` (COOP `same-origin` + COEP `require-corp`), the bundle,
  packs and (for some runs) the ORT files on `http://127.0.0.1:<C>` (another origin and another site; CORS `*`, CORP
  `cross-origin`, `Accept-Ranges`, `immutable`, no compression), driven with puppeteer-core:
  - `cipetpet.min.js` imported cross-origin; `AntaliaMini.load` + `synthesize` and `DuyuSmall.load` + `transcribe` on the
    main thread: audio 48 kHz, 101,888 samples for "Merhaba dünya, bu bir deneme." (the same samples as in Node), the
    transcript of `clip03.wav` equal to the Node result;
  - `createAntaliaWorker` / `createDuyuWorker` from the cross-origin bundle (Blob-URL shim, `worker.js` fetched from
    the CDN origin), same audio and transcript;
  - `wasmPaths` pointing at the CDN origin (ORT `.mjs` and `.wasm` requested from there, nothing else), and no
    `wasmPaths`: the jsDelivr default (`onnxruntime-web@1.30.0`) worked on the main thread and in workers;
  - `crossOriginIsolated === true` and `info.threads === 4` (main thread and workers); a page without COOP/COEP runs
    with 1 thread;
  - `integrity`: the manifest value passes, a wrong value fails with `integrity check failed for <URL>: expected ...,
    got ...`, a malformed value is rejected before any request;
  - `cache: true`: the pack is stored in the Cache API (`cipetpet-packs`); a second load on the same page, after a
    page reload and with `integrity` made no request to the CDN origin (without `cache: true` it is fetched again).
  - The demo (`cipetpet-demo`, echo backend, Antalia and Duyu served from `/packs`) in the same browser: both models
    ready, text turn and microphone turn (Chrome's fake capture of `clip03.wav`: transcript equal to the text) with a
    spoken reply, Esc stops speaking, and the same with the "Web Worker" setting on.
  Not covered by that run: Firefox and Safari, a real CDN (the library is not published), packs on a model host,
  `backend: "webgpu"`, `--embed-runtime`. Section 9 lists what remains.
- **Not verified: the library URL itself.** `cipetpet` is not on npm yet (`registry.npmjs.org/cipetpet` and
  `cdn.jsdelivr.net/npm/cipetpet/package.json` both answered 404). The CDN behaviour of an npm package was measured
  with `onnxruntime-web`, which jsDelivr and unpkg serve the same way as any other npm package. `VERSION` below is
  whatever you publish.
- **Not verified: Cloudflare R2, S3, CloudFront.** No accounts. The configurations in section 3 follow the
  providers' documented formats and have not been run.
- **Not verified: a `.cpet` file on jsDelivr/unpkg**, for the same reason (nothing published).

## 1. The library: jsDelivr or unpkg

```
https://cdn.jsdelivr.net/npm/cipetpet@VERSION/dist/browser/cipetpet.min.js
https://unpkg.com/cipetpet@VERSION/dist/browser/cipetpet.min.js
```

Pin an exact `VERSION`. For `onnxruntime-web@1.30.0` (exact version in the URL) jsDelivr answered
`cache-control: public, max-age=31536000, s-maxage=31536000, immutable`; unpkg answered
`cache-control: public, max-age=31536000`. A floating tag or range was not measured.

What is in `dist/browser/` (built by `npm run build`, `tools/build.mjs`):

| file | content |
| --- | --- |
| `cipetpet.js`, `cipetpet.min.js` | the whole library as one ES module, with the ONNX Runtime JS (the `wasm` build) inside. Exports the same names as `import "cipetpet"`: `AntaliaMini`, `DuyuSmall`, `openPack`, `MicRecorder`, `playAudio`, `createAntaliaWorker`, ... `cipetpet.min.js.map` is next to the min file. |
| `ort-webgpu.js` | ORT's WebGPU build, loaded only when `backend: "webgpu"` is used, as `import("./ort-webgpu.js")` relative to the bundle. |
| `worker.js` | the Web Worker for `createAntaliaWorker` / `createDuyuWorker`, standalone (ORT inside, no imports). |

**Verified** (test `browser-bundle.test.ts`, TypeScript AST scan): none of the four files contains a bare module
specifier. The only import left in `cipetpet.js` and `cipetpet.min.js` is the relative `./ort-webgpu.js`; `worker.js`
and `ort-webgpu.js` have no imports. Also verified: `cipetpet.min.js` evaluates in Node without a DOM, exports
`AntaliaMini`, `DuyuSmall`, `openPack` and the rest, and synthesizes speech from `antalia-mini-int8.cpet` there.

`package.json` has `"unpkg"`, `"jsdelivr"` and `"browser"` pointing at `dist/browser/cipetpet.min.js`, and the
exports `cipetpet/browser` (same file) and `cipetpet/browser/*` (any file in `dist/browser`). With bundlers, keep
importing `cipetpet`: modern bundlers use the `exports` map and ignore the `browser` field; they then bundle
`dist/esm`.

## 2. ONNX Runtime WebAssembly: jsDelivr or unpkg

ONNX Runtime needs two files next to each other: a small JS glue (`.mjs`) and the engine (`.wasm`). What ORT does
without help (read from `node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs`):

- The `onnxruntime-web/wasm` bundle embeds the glue but not the engine. It looks for
  `ort-wasm-simd-threaded.wasm` next to its own script (`new URL("ort-wasm-simd-threaded.wasm", import.meta.url)`).
  It uses the embedded glue only when its script is same-origin to the page (or when it was handed the binary and
  runs one thread); otherwise it also looks for the glue file `ort-wasm-simd-threaded.mjs` next to its script.
- Inside `cipetpet.min.js` "next to its own script" is `dist/browser/`, which has neither file.

So, **in the browser bundle (and `dist/esm/worker/worker.js`, also a pre-built bundle)** `initRuntime` sets ORT's
`wasmPaths` before the first session to

```
https://cdn.jsdelivr.net/npm/onnxruntime-web@<ort.env.versions.web>/dist/
```

(the version is read from the ORT inside the bundle, never hard-coded), unless one of these applies:

| you gave | what happens |
| --- | --- |
| `wasmPaths` | yours is used, no default |
| `wasmBinary` (or the pack embeds the runtime) and 1 thread | no file is fetched: ORT uses the glue inside the bundle and the binary in memory |
| `wasmBinary` (or an embedded runtime) and more than 1 thread | only the glue file `.../ort-wasm-simd-threaded.mjs` (24 KB) is fetched from the CDN; ORT needs it to start its thread workers |
| `ort` (your own ORT module) | untouched, your ORT's rules apply |
| nothing, in Node/Deno/Bun, or via `dist/esm` with a bundler | untouched (ORT's own logic; a bundler decides where the files go) |

**Verified** (test `browser-bundle.test.ts`, bundle run in Node with a fake `document`): the four cases above set
`wasmPaths` to the CDN directory, leave a given one alone, leave it unset for binary + 1 thread (and the session
then runs with no network access), and use `{ mjs }` for binary + threads. What ORT then does with those URLs in a
browser was checked in Chrome (see the first list).

The self-hosted alternative, any host that serves the two files from one folder:

```js
await AntaliaMini.load(url, { wasmPaths: "https://my.example/ort/" }); // ends with "/"
```

Which files, by backend: `wasm` (default) needs `ort-wasm-simd-threaded.mjs` (24,381 B) and
`ort-wasm-simd-threaded.wasm` (14,239,897 B). `webgpu` needs `ort-wasm-simd-threaded.asyncify.mjs` (53,057 B) and
`ort-wasm-simd-threaded.asyncify.wasm` (26,781,914 B).

Measured with `curl -I -H "Origin: https://example.org"` (and GET for the bodies):

| | jsDelivr `cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/...` | unpkg `unpkg.com/onnxruntime-web@1.30.0/dist/...` |
| --- | --- | --- |
| status for the 4 files | 200 | 200 |
| `Access-Control-Allow-Origin` | `*` | `*` |
| `Cross-Origin-Resource-Policy` | `cross-origin` | `cross-origin` |
| `Content-Type` | `application/wasm`, `application/javascript; charset=utf-8` | `application/wasm`, `text/javascript; charset=utf-8` |
| `Cache-Control` | `public, max-age=31536000, s-maxage=31536000, immutable` | `public, max-age=31536000` |
| bytes equal to `node_modules/onnxruntime-web/dist` | yes, all 4 (`cmp`) | yes, all 4 (`cmp`) |
| `Accept-Encoding: gzip, br` | `content-encoding: br` (14,239,897 B wasm sent as 3,073,897 B) | `content-encoding: gzip` |
| `Range: bytes=0-15` | `206`, `Content-Range: bytes 0-15/14239897` | `200` with the whole file (Range ignored) |

jsDelivr compresses `.wasm` (good for ORT); see section 4 for why that matters for `.cpet`.

## 3. The model packs

A pack is one static file. The page fetches it with `fetch()` (CORS mode), so the host must answer with
`Access-Control-Allow-Origin` for your page's origin (or `*`). Details of what each host does:

### Hugging Face model repo

URL form: `https://huggingface.co/<user>/<repo>/resolve/main/<file>.cpet` (put the `.cpet` files in a public model
repo). Pin a commit instead of `main` with `resolve/<commit sha>/<file>`.

**Verified** with the public repo `KaanAydinli/Duyu-small`, `curl -H "Origin: https://example.org"`:

- `resolve/main/engine.json` (a small file): `307` to `/api/resolve-cache/...`, then `200`; both answers have
  `access-control-allow-origin: https://example.org` (the request's origin is echoed) with `vary: Origin` and
  `access-control-expose-headers: ... ETag, Link, Accept-Ranges, Content-Range ...`.
- `resolve/main/int8/decoder.onnx` (6,417,328 B, a large-file object): `302` to
  `https://us.aws.cdn.hf.co/xet-bridge-us/...` with a signed query string (`Expires`, `Signature`; it differed
  between two requests a few seconds apart). The first answer has `access-control-allow-origin: <origin>` and
  `cache-control: no-store`; the final answer has `access-control-allow-origin: *`, `accept-ranges: bytes`,
  `etag`, `content-type: application/octet-stream`, `content-length: 6417328` (also when asking for
  `Accept-Encoding: gzip, br`: no `Content-Encoding`), and answers `Range: bytes=0-15` with `206`.
- Preflight (on the `engine.json` URL, `OPTIONS` with `Access-Control-Request-Headers: range`) answered `200` with
  `access-control-allow-origin: <origin>`, `access-control-allow-headers: range`, `access-control-allow-methods: GET`.
- No `Cross-Origin-Resource-Policy` header on either hop. A CORS-mode fetch does not need one (Fetch spec); this
  was not tested in a browser under COEP (section 6).
- Redirect targets are signed and change per request, so the browser's HTTP cache probably cannot reuse a
  download (inferred, not measured). Use `cache: true` (the Cache API is keyed by the URL you pass).

### Cloudflare R2 (public bucket or custom domain)

Bucket, Settings, CORS Policy (R2 documents this JSON shape; not run here):

```json
[
  {
    "AllowedOrigins": ["https://app.example"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

Upload the pack with `Cache-Control: public, max-age=31536000, immutable` and `Content-Type:
application/octet-stream` (for example with `--hash-names` file names, section 5). Then check what a browser would
get: `curl -sI -H "Accept-Encoding: gzip, br" -H "Origin: https://app.example" <url>` must show no
`content-encoding`; if something in front of the bucket compresses `application/octet-stream`, switch that off for
`*.cpet`.

### S3, with or without CloudFront

`aws s3api put-bucket-cors --bucket BUCKET --cors-configuration file://cors.json` (documented S3 format; not run
here):

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://app.example"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["Range"],
      "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
      "MaxAgeSeconds": 86400
    }
  ]
}
```

Upload with `--cache-control "public, max-age=31536000, immutable" --content-type application/octet-stream`.
Same check as above for `content-encoding`.
Behind CloudFront, S3 only sends CORS headers when the request carries an `Origin`, so the distribution must
forward `Origin` to S3 and include it in the cache key (the managed origin request policy `CORS-S3Origin` and a
cache policy that keys on `Origin`; or a response headers policy that adds `Access-Control-Allow-Origin`
itself); this is AWS's documented setup and was not run here. Turn off compression for the behaviour serving
`*.cpet`.

### GitHub Releases: not usable from a browser directly

**Verified** with `https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-1-amd64.deb` and
`Origin: https://example.org`: the first answer is `302` to `https://release-assets.githubusercontent.com/...`
(signed, short-lived URL) and has **no** `Access-Control-Allow-Origin`; the final answer (`206` for a range
request, server `Windows-Azure-Blob`) has **no** `Access-Control-Allow-Origin` either, and a CORS preflight
(`OPTIONS`) to it answered `405`. A browser `fetch()` from another origin would be blocked. A release is fine as
the place to publish the files for people to download; upload the `.cpet` files to one of the hosts above.
(`raw.githubusercontent.com` answered a small text file with `access-control-allow-origin: *`; it was not
tested with large files and is not a file host for packs.)

### jsDelivr from an npm package

Publishing the packs inside an npm package makes them available at
`https://cdn.jsdelivr.net/npm/<package>@<version>/<file>.cpet`. **Verified limits** (file sizes taken from
jsDelivr's `data.jsdelivr.com` listing, then `Range: bytes=0-15` requests to `cdn.jsdelivr.net/npm/...`):

| file (npm package) | bytes | jsDelivr |
| --- | --- | --- |
| `onnxruntime-web@1.30.0` `ort-wasm-simd-threaded.asyncify.wasm` | 26,781,914 | 200 (served) |
| `@ffmpeg/core-mt@0.12.6` `ffmpeg-core.wasm` | 32,609,891 | 206 (served) |
| `@next/swc-linux-x64-gnu@12.0.0` `next-swc.linux-x64-gnu.node` | 42,852,392 | 206 (served) |
| `@swc/core-linux-x64-gnu@1.7.0` `swc.linux-x64-gnu.node` | 50,485,720 | 206 (served) |
| `@swc/core-win32-x64-msvc@1.7.0` `swc.win32-x64-msvc.node` | 53,974,528 | 403 |
| `@next/swc-darwin-arm64@13.0.0` `next-swc.darwin-arm64.node` | 72,807,016 | 403 |
| `@next/swc-linux-x64-gnu@14.2.5` `next-swc.linux-x64-gnu.node` | 131,357,024 | 403, body `File size exceeded the configured limit of 50 MB.` |

So the per-file limit is between 50,485,720 and 53,974,528 bytes (consistent with 50 MiB = 52,428,800). Of our
packs, all except `duyu-small-int8` (55,849,756 B) are below the largest file that was served (the biggest of
them, `duyu-small-q4`, is 33,518,876 B); `duyu-small-int8` is larger than a file that was refused, so expect a
403 for it (that exact file was not tested). The same `unpkg.com` URL of the 131 MB file answered `200` with
`content-length: 131357024` (the transfer was cut after 30 s in the probe); unpkg also ignored `Range`.

jsDelivr also compresses binaries: the 42.8 MB `.node` file (`application/octet-stream`) came back with
`content-encoding: br` and `content-length: 10576142` when the request said `Accept-Encoding: gzip, br`, with
`access-control-allow-origin: *` and `cross-origin-resource-policy: cross-origin`. A `.cpet` was not tested, but
expect the same treatment (section 4).

## 4. Response headers the pack host should send

| header | why |
| --- | --- |
| `Access-Control-Allow-Origin: <your page origin>` or `*` | the page loads the pack with `fetch()` in CORS mode; without it the load fails |
| `Cross-Origin-Resource-Policy: cross-origin` | only for requests that are not CORS-mode (for example `<script src>` without `crossorigin`) on a page with COEP `require-corp`; harmless otherwise. Not needed for the `fetch()` cipetpet makes (per the Fetch spec; not browser-tested). jsDelivr and unpkg send it. |
| `Access-Control-Expose-Headers` (optional) | `Content-Length` is readable cross-origin without it (CORS-safelisted); `Content-Encoding` is not. If a server compresses the pack and does not expose `Content-Encoding`, the page cannot tell, shows progress against the compressed size, and when more bytes arrive than announced the loader switches to "total unknown". HF and jsDelivr send `*`. |
| `Accept-Ranges: bytes` | not used by cipetpet (it downloads a pack in one request) but expected by caches and resumable downloaders; HF, jsDelivr send it |
| `Cache-Control: public, max-age=31536000, immutable` | a pack never changes under its name. Use `--hash-names` (section 5) so that is true |
| `Content-Type: application/octet-stream` | any type works for `fetch()`; this is what HF and jsDelivr send for binaries |
| **no** `Content-Encoding` (no gzip or brotli) | the graphs inside are int8/fp16/fp32 weights and do not compress much, the pack already gzips what does compress (the text tables), and a compressed response makes `Content-Length` describe the wire bytes: cipetpet then reports `total: 0` (unknown) in `onProgress` until the end instead of a real total (the loader handles this; the progress bar just stops being a percentage). With `integrity` the digest is taken over the decoded body either way. |

## 5. Pinning with `integrity` and `packs/manifest.json`

`npm run packs` writes `packs/manifest.json` next to the packs (the packs folder is git-ignored here, so is the
manifest). Deterministic: same inputs, same bytes, no timestamps. One entry per pack:

```json
{
  "name": "antalia-mini-int8",
  "file": "antalia-mini-int8.cpet",
  "bytes": 10675221,
  "sha256": "6bf3a7e9f87ee15a73417d230b28fd673eab10c3d6541ca2028d761822e51d97",
  "integrity": "sha256-a/On6fh+4VpzQX0jCyj9Zz6rEMPWVByiAo12GCLlHZc=",
  "model": "antalia-mini",
  "variant": "int8",
  "onnxruntime": "1.30.0",
  "embedsRuntime": false
}
```

(the values of the pack built from the current upstream files; yours come from your own `manifest.json`.) `--hash-names` also writes
`<name>.<first 8 hex of sha256>.cpet` and adds `"hashedFile"`; `--only a,b` updates only those entries of an
existing manifest.

```sh
npx tsx tools/build-packs.ts --hash-names          # packs/*.cpet, packs/*.<hash>.cpet, packs/manifest.json
```

Use the value as `integrity`:

```js
const tts = await AntaliaMini.load("https://models.example/antalia-mini-int8.6bf3a7e9.cpet", {
  integrity: "sha256-...",   // from manifest.json
  cache: true,
});
```

What `integrity` does (tested in `test/integrity.test.ts` with fakes, and in Chrome as noted above):

- it is passed to `fetch` (browsers then refuse a different body) **and** the downloaded bytes are hashed in the
  library, so it also holds for a custom `fetch`, for the Cache API path and for packs passed as bytes or a Blob;
- a mismatch throws `cipetpet: integrity check failed for <URL>: expected sha256-..., got sha256-...`; nothing is
  cached; a Cache API copy that fails the check is deleted and downloaded again (so republishing under the same
  URL is safe);
- the format is `sha256-<base64>` (several space-separated values mean "any of these"); anything else is a
  `TypeError` before any request;
- a browser that rejects the body by itself reports it as a plain network `TypeError`; the library then asks once
  more without the browser's check and hashes the bytes itself, so a mismatch gets the exact
  `integrity check failed ... expected ..., got ...` error (Chrome: verified). Only when that second request fails too
  is the error the network one, with a message that names the SHA-256 mismatch as one possible cause;
- per the Fetch spec a browser may hold the body back until the whole file is verified, so progress may jump
  instead of advancing (not measured).

The pack's own entries are separately verified against SHA-256 values inside the pack (`verify`, default on).

## 6. COOP/COEP for WASM threads

WASM threads need `SharedArrayBuffer`, which a page gets only when it is cross-origin isolated: the **page itself**
(the HTML, not the CDN files) must be served with

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

(meta tags do not work for these; the host must send headers: for example nginx `add_header`, a Netlify or
Cloudflare Pages `_headers` file; not tested here.)

What cipetpet does (from `src/runtime/ort.ts`; the single-thread path is also what the Node tests run):

- isolated page: default threads = half the cores, at most 4;
- not isolated: 1 thread, silently;
- `threads: N` (N > 1) on a page that is not isolated: one console warning ("needs a cross-origin isolated page
  (COOP/COEP headers); running single-threaded") and 1 thread. Everything still works, only slower.

Under `require-corp` every cross-origin resource must opt in. What cipetpet loads, and how:

| resource | how it is requested | what it needs |
| --- | --- | --- |
| `cipetpet.min.js` import | module script, CORS | CORS header (jsDelivr, unpkg send it, plus CORP) |
| ORT `.mjs` | dynamic `import()`, CORS | same |
| ORT `.wasm` | `fetch`, CORS | same |
| the pack | `fetch`, CORS | `Access-Control-Allow-Origin` (section 4) |
| `worker.js` from a CDN | `import` inside a same-origin Blob worker (below) | CORS header |
| thread workers of ORT | started by ORT from a Blob URL when the glue is cross-origin | none |

Chrome ran a page with these two headers through all of the above (see the first list); other browsers were not tried. Anything of yours that is a plain
`<img>`, `<script src>` or `<iframe>` from another origin needs `Cross-Origin-Resource-Policy: cross-origin` (or the
`crossorigin` attribute plus CORS) on that page.

### Web Workers and cross-origin scripts

`new Worker("https://cdn.../worker.js")` throws a `SecurityError` in every browser, so with the CDN bundle
`createAntaliaWorker` / `createDuyuWorker` start the worker through a Blob URL whose module is
`import "<absolute worker url>";`, and revoke the Blob URL when the worker is disposed or the load failed. This is
used whenever the worker URL (the default `new URL("./worker.js", import.meta.url)` next to the bundle, or the
`worker` option as a string or URL) is http(s) and on another origin than the page. **Verified** with fakes in
`test/worker-client.test.ts`: the Blob source, that same-origin URLs, `blob:`/`data:` URLs and ready-made `Worker`
objects keep the old path, and the revoking. If the script cannot be fetched the error says that the cross-origin
script must be reachable and CORS-enabled.

Bundlers (Vite, webpack, ...) do not rewrite `new URL("./worker.js", import.meta.url)` inside a dependency and
cannot see the string you pass: build the worker with your bundler's worker syntax and pass it as `worker`, serve a
copy of `node_modules/cipetpet/dist/browser/worker.js` from your own origin and pass its URL, or use the CDN
bundle. (Bundler recipes were not run here.)

What the worker clients post to the worker has to be structured-cloneable, so `createAntaliaWorker` /
`createDuyuWorker` make the pack URL (a `URL` object or a relative string) and a relative `wasmPaths` absolute
against the page before posting (the worker would resolve them against its own script, or against a `blob:` URL
with the shim above), drop `requestInit.signal`, and throw a `TypeError` for the `fetch` and `ort` options.
`DuyuWorker.transcribe` transfers the buffer of the array it is given, except when that array is a view on a larger
buffer: then it sends a copy. **Verified** with fakes in `test/worker-client.test.ts`.

ORT's own proxy worker (`proxy: true`) is not supported from the CDN bundle (its script would be the bundle itself,
which is not ORT's worker script; this was not tried in a browser); `initRuntime` warns once. Use the worker clients above to keep inference off the main thread.

## 7. Complete pages

Both pages use only CDN URLs. Replace `PACKS` with the host where you put the packs (section 3) and `VERSION` with
the published cipetpet version. Serve the HTML over `https://` or from `localhost` (the microphone needs a secure
context), ideally with the two headers of section 6.

### Text to speech and speech to text on the main thread

```html
<!doctype html>
<html lang="tr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cipetpet from CDNs</title>
<body>
  <p><button id="load">Load models</button> <span id="status">not loaded</span></p>
  <p><input id="text" size="40" value="Merhaba dünya, bu bir deneme."> <button id="speak" disabled>Speak</button></p>
  <p><button id="mic" disabled>Start recording</button></p>
  <pre id="out"></pre>

  <script type="module">
    import { AntaliaMini, DuyuSmall, MicRecorder, playAudio }
      from "https://cdn.jsdelivr.net/npm/cipetpet@VERSION/dist/browser/cipetpet.min.js";

    // REPLACE: the folder where you host the packs; it must send Access-Control-Allow-Origin for this page.
    const PACKS = "https://huggingface.co/YOUR-USER/YOUR-REPO/resolve/main/";
    const $ = (id) => document.getElementById(id);
    const show = (name) => (p) => {
      $("status").textContent = `${name}: ` + (p.total ? Math.round((100 * p.loaded) / p.total) + " %" : (p.loaded / 1e6).toFixed(1) + " MB");
    };
    let tts, stt, recorder;

    $("load").onclick = async () => {
      $("load").disabled = true;
      try {
        // optional: integrity: "sha256-..." (from packs/manifest.json) pins the exact file
        tts = await AntaliaMini.load(PACKS + "antalia-mini-int8.cpet", { cache: true, onProgress: show("speech synthesis") });
        stt = await DuyuSmall.load(PACKS + "duyu-small-int8.cpet", { cache: true, onProgress: show("speech recognition") });
        $("status").textContent = `ready (ONNX Runtime ${tts.info.onnxruntime}, ${tts.info.threads} thread(s))`;
        $("speak").disabled = $("mic").disabled = false;
      } catch (e) {
        $("status").textContent = "failed: " + e.message;
        $("load").disabled = false;
      }
    };

    $("speak").onclick = async () => {
      const { audio, sampleRate } = await tts.synthesize($("text").value);
      await playAudio(audio, sampleRate).ended;
    };

    $("mic").onclick = async () => {
      if (!recorder) {
        recorder = await MicRecorder.start();            // asks for the microphone
        $("mic").textContent = "Stop and transcribe";
      } else {
        const audio = await recorder.stop();             // Float32Array, mono, 16 kHz
        recorder = undefined;
        $("mic").textContent = "Start recording";
        const result = await stt.transcribe(audio);
        $("out").textContent = result.text;
      }
    };
  </script>
</body>
</html>
```

### The same with the worker clients (inference off the main thread)

`createAntaliaWorker` / `createDuyuWorker` find `worker.js` next to the bundle on jsDelivr; because that is
cross-origin to your page they start it through the Blob shim of section 6.

```html
<!doctype html>
<html lang="tr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cipetpet workers from CDNs</title>
<body>
  <p><button id="load">Load models</button> <span id="status">not loaded</span></p>
  <p><input id="text" size="40" value="Merhaba dünya, bu bir deneme."> <button id="speak" disabled>Speak</button></p>
  <p><button id="mic" disabled>Start recording</button></p>
  <pre id="out"></pre>

  <script type="module">
    import { createAntaliaWorker, createDuyuWorker, MicRecorder, playAudio }
      from "https://cdn.jsdelivr.net/npm/cipetpet@VERSION/dist/browser/cipetpet.min.js";

    const PACKS = "https://huggingface.co/YOUR-USER/YOUR-REPO/resolve/main/"; // REPLACE
    const $ = (id) => document.getElementById(id);
    const show = (name) => (p) => {
      $("status").textContent = `${name}: ` + (p.total ? Math.round((100 * p.loaded) / p.total) + " %" : (p.loaded / 1e6).toFixed(1) + " MB");
    };
    let tts, stt, recorder;

    $("load").onclick = async () => {
      $("load").disabled = true;
      try {
        // each call starts its own worker (and downloads its own pack inside it)
        tts = await createAntaliaWorker(PACKS + "antalia-mini-int8.cpet", { cache: true, onProgress: show("speech synthesis") });
        stt = await createDuyuWorker(PACKS + "duyu-small-int8.cpet", { cache: true, onProgress: show("speech recognition") });
        $("status").textContent = "ready";
        $("speak").disabled = $("mic").disabled = false;
      } catch (e) {
        $("status").textContent = "failed: " + e.message;
        $("load").disabled = false;
      }
    };

    $("speak").onclick = async () => {
      const { audio, sampleRate } = await tts.synthesize($("text").value);
      await playAudio(audio, sampleRate).ended;
    };

    $("mic").onclick = async () => {
      if (!recorder) {
        recorder = await MicRecorder.start();
        $("mic").textContent = "Stop and transcribe";
      } else {
        const audio = await recorder.stop();
        recorder = undefined;
        $("mic").textContent = "Start recording";
        $("out").textContent = (await stt.transcribe(audio)).text;   // the audio buffer is transferred to the worker
      }
    };

    addEventListener("pagehide", () => { tts?.dispose(); stt?.dispose(); });
  </script>
</body>
</html>
```

To use your own copy of the worker instead (same origin, no shim): `{ worker: "/static/worker.js" }`.

## 8. One file as the only dependency: `--embed-runtime`

```sh
npx tsx tools/build-packs.ts --embed-runtime --only antalia-mini-int8
```

adds `runtime/ort-wasm-simd-threaded.wasm` (14,239,897 B) to the pack: `antalia-mini-int8.cpet` grows from 10,675,221 to
24,915,353 bytes, and `manifest.json` records `"embedsRuntime": true`. The loader hands that binary to ORT when the
pack's `runtime.onnxruntime` equals the ORT version in the bundle (otherwise it warns and ignores it).

What that saves, **verified** (the min bundle in Node with a fake `document`, an embedded-runtime pack, no network):

- 1 thread: the model loads and speaks with no other file fetched; ORT uses the glue inside the bundle and the
  binary from the pack.
- more than 1 thread: ORT still needs the 24 KB glue file; the library points it at
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/ort-wasm-simd-threaded.mjs` (the Node run could not
  fetch it and failed, as expected). A fully offline multi-thread setup needs the self-hosted `wasmPaths`.

The WebGPU backend never uses the embedded binary (it has its own `asyncify` build).

## 9. Checklist for a browser run

These are the points above that need a real browser (Chromium, Firefox, Safari), against a published package or a
local stand-in for the CDN that sends the same CORS and CORP headers:

1. A plain page on origin A imports `cipetpet.min.js` from origin B and `AntaliaMini.load("<origin C>/pack.cpet")`
   works with the default `wasmPaths` (ORT files from jsDelivr), with and without COOP/COEP on A.
2. With COOP/COEP on A: `crossOriginIsolated === true`, `info.threads > 1`, and synthesis runs with threads.
3. `createAntaliaWorker` / `createDuyuWorker` with the default worker URL (origin B): the Blob shim starts, loads,
   synthesizes; `dispose()` revokes the Blob URL (check no `blob:` leak).
4. Packs from Hugging Face (redirect to `cdn.hf.co`) work, also under COEP `require-corp`; `integrity` accepts the
   manifest value and rejects a modified file; progress totals with and without `Content-Encoding`.
5. `--embed-runtime` pack, 1 thread, with the network panel showing no ORT file requests.
6. `backend: "webgpu"` pulls `ort-webgpu.js` and the `asyncify` files from the CDN.
