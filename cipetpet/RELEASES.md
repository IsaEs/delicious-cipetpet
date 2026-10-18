# Releases: the model packs and ONNX Runtime files as downloads

Every release of this project on GitHub (`https://github.com/IsaEs/delicious-cipetpet/releases`) carries the files
a web app needs next to the `cipetpet` library: the `.cpet` model packs and the ONNX Runtime (`.mjs` + `.wasm`)
files. You download them once, put them in your project's `public/` folder, and serve them from your own origin.
`npx cipetpet pull` does the download, checks every file's SHA-256 and lays the folder out for you.

Why a project copy and not a link to the release? A browser cannot `fetch()` a GitHub release asset from your
page: `github.com/.../releases/download/...` answers `302` to a signed `release-assets.githubusercontent.com` URL
that sends no `Access-Control-Allow-Origin` header ([CDN.md](./CDN.md), "GitHub Releases"). Files on your own
origin need no CORS at all, which is also the simplest setup for the COOP/COEP headers that WASM threads need.

Contents: [1. What a release contains](#1-what-a-release-contains) -
[2. Quick start](#2-quick-start) - [3. Wiring per tool](#3-wiring-per-tool) -
[4. The JavaScript](#4-the-javascript) - [5. Install scripts and .gitignore](#5-install-scripts-and-gitignore) -
[6. Offline and CI](#6-offline-and-ci) - [7. Verifying](#7-verifying) -
[8. For maintainers: cutting a release](#8-for-maintainers-cutting-a-release) - [9. Sizes](#9-sizes)

## 1. What a release contains

A release `vX.Y.Z` has flat files, no folders. `X.Y.Z` is the version of the `cipetpet` npm package the files were
made for, and `cipetpet pull` takes exactly that version by default, so the packs match the library you installed.

| file | what it is |
| --- | --- |
| `antalia-mini-int8.cpet` | Antalia-2 Mini (Turkish text to speech), int8 graphs. **Default.** |
| `antalia-mini-mixed.cpet`, `antalia-mini-fp16.cpet`, `antalia-mini-fp32.cpet` | the same model in more precise variants |
| `duyu-small-int8.cpet` | Duyu-small (speech recognition, Turkish + English), int8 graphs. **Default.** |
| `duyu-small-q4.cpet` | Duyu-small with 4-bit weights, smaller |
| `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` | ONNX Runtime Web for the default `wasm` backend |
| `ort-wasm-simd-threaded.asyncify.mjs`, `ort-wasm-simd-threaded.asyncify.wasm` | ONNX Runtime Web for `backend: "webgpu"` |
| `cipetpet-release.json` | the list of the files above: name, size, SHA-256, and for packs the model, variant and SRI `integrity` string |
| `SHA256SUMS` | `sha256sum -c` file for everything above (it lists `cipetpet-release.json` too, not itself) |
| `LICENSE`, `NOTICE` | Apache-2.0 text; credits (Antalia-2 Mini by PatientDesk AI, Duyu-small by KaanAydinli, encoder design from balbal) and the ONNX Runtime MIT notice |

The ORT files are copied byte for byte from the `onnxruntime-web` version that the packs and the library were built
with (`ortVersion` in `cipetpet-release.json`); they are the only ORT files the library can load. The package's
`.jsep` and `.jspi` builds are not shipped because `cipetpet` never loads them (the `wasm` backend imports
`onnxruntime-web/wasm`, the `webgpu` backend imports `onnxruntime-web/webgpu`; see `src/runtime/ort.ts`).

Licences: the models are Apache-2.0, ONNX Runtime is MIT. Keep `LICENSE` and `NOTICE` with the files if you
redistribute them (`pull` downloads both unless you pass `--no-docs`).

## 2. Quick start

```sh
npm install cipetpet
npx cipetpet pull
```

This writes into `public/cipetpet` (change it with `--dir`):

```
public/cipetpet/
  antalia-mini-int8.cpet
  duyu-small-int8.cpet
  cipetpet-release.json
  LICENSE
  NOTICE
  ort/
    ort-wasm-simd-threaded.mjs
    ort-wasm-simd-threaded.wasm
```

and prints the code to use them:

```
  import { AntaliaMini, DuyuSmall } from "cipetpet";
  const tts = await AntaliaMini.load("/cipetpet/antalia-mini-int8.cpet", { wasmPaths: "/cipetpet/ort/" });
  const stt = await DuyuSmall.load("/cipetpet/duyu-small-int8.cpet", { wasmPaths: "/cipetpet/ort/" });
```

(The URLs are derived from `--dir`: everything after the last `public` folder in the path. Outside a `public`
folder `pull` prints a note instead.)

`npx cipetpet pull` works without installing anything first as well (`npx` fetches the `cipetpet` package and runs
its `bin`); the tag then defaults to the version of that package. The command needs Node 20 or newer and uses only
Node's built-in modules.

### Options

```
cipetpet pull [--dir public/cipetpet] [--tag vX.Y.Z | latest] [--repo owner/name]
              [--packs a,b | all] [--models antalia,duyu] [--no-ort] [--webgpu] [--no-docs]
              [--ort-from-node-modules] [--force] [--dry-run] [--list] [--base-url URL] [--manifest-sha256 HEX]
cipetpet verify [--dir public/cipetpet] [--strict]
```

| option | meaning |
| --- | --- |
| `--dir DIR` | target folder, relative to the current directory. Nothing is ever written outside it. |
| `--tag vX.Y.Z` / `--tag latest` | the release. Default: `v` + the version of the installed `cipetpet`. `latest` asks `api.github.com/repos/<repo>/releases/latest` (a published, non-draft, non-prerelease release). |
| `--repo owner/name` | default: the `repository` of the `cipetpet` package (`IsaEs/delicious-cipetpet`). Use it for a fork. |
| `--packs antalia-mini-int8,duyu-small-q4` | packs by name (`.cpet` optional), or `all`. Default: `antalia-mini-int8` and `duyu-small-int8`. |
| `--models antalia,duyu` | the `int8` pack of each model. Can be combined with `--packs`. |
| `--no-ort` | do not fetch the ONNX Runtime files (use this if you serve them from a CDN: `wasmPaths` can point there, see [CDN.md](./CDN.md)). |
| `--webgpu` | also fetch the `asyncify` files that `backend: "webgpu"` needs. |
| `--no-docs` | skip `LICENSE` and `NOTICE`. |
| `--ort-from-node-modules` | copy the ORT files from the installed `onnxruntime-web` instead of downloading them (it must be the version in `ortVersion`; each file is checked against the release's hash). |
| `--force` | download again even if the file is there with the right hash; replace files that were not put there by `pull`; accept a release of the same version whose hashes changed. |
| `--dry-run` | fetch the manifest, say what would be downloaded or kept, write nothing. |
| `--list` | print the assets of the release and, per file, whether `--dir` has it (`ok`, `DIFFERENT`, `-`). |
| `--manifest-sha256 HEX` | the SHA-256 you expect for `cipetpet-release.json` (`release-assets` prints it; it is also in the release's `SHA256SUMS`). `pull` stops with exit 3 and writes nothing when the manifest differs. See [7. Verifying](#7-verifying). |
| `--base-url URL` | a folder URL that holds the release files (a mirror, or your own copy). `<URL>/<file>` is requested; the GitHub API is not used (so `--tag latest` is refused). |

How it behaves:

- It downloads `cipetpet-release.json` first, then only the files named in it, from
  `https://github.com/<repo>/releases/download/<tag>/<name>`, following redirects (at most 5).
- Each file is streamed to `<dir>/.<name>.part`, its size and SHA-256 are checked against the manifest, and only then
  is it renamed into place. A wrong file is never left behind, and a file that is already there is untouched by a
  failed download. `cipetpet-release.json` is written last, so its presence means "pulled completely".
- Files already present with the right hash are skipped: repeated installs are fast, and with no network at all
  `pull` still succeeds when everything is present (it then uses the local `cipetpet-release.json`).
- A file that is present with another hash is replaced only if an earlier `pull` put it there (it is listed in the
  `cipetpet-release.json` already in `--dir`): damaged or outdated downloads are repaired. A file `pull` did not write
  is never touched: for a pack or an ONNX Runtime file `pull` stops before writing anything (exit 1); `LICENSE` and
  `NOTICE` that are yours are skipped with a message. `--force` replaces them.
- A release does not change: if `--dir` holds the manifest of the same version with other hashes, `pull` stops with
  exit 3 (the files of a published release were swapped, or a mirror serves something else) unless you pass `--force`.
- Leftover `.<name>.part` files of a run that was killed are deleted at the start of the next `pull`, so they cannot
  end up in your `dist/`.
- Only `https://` is used (plain `http://` only for `localhost` / `127.0.0.1` / `::1`, and never as the target of a
  redirect from an `https://` URL). The manifest can only name files that cipetpet itself ships: packs
  `^[a-z0-9][a-z0-9-]*\.cpet$` (at most 32, 2 GiB each), the ONNX Runtime files `ort-wasm-simd-threaded[.asyncify].mjs|wasm`
  (at most 4, 64 MiB each) and `LICENSE` / `NOTICE` (1 MiB each). Any other name (`package.json`, `index.html`, `sw.js`,
  `../x`, a name starting with a dot) is exit 3, before anything is fetched or written. The manifest is limited to
  1 MB; a file larger than the manifest says is refused.
- The ONNX Runtime files are the ones of `onnxruntime-web` `ortVersion`, and `cipetpet` depends on exactly that
  version. If the `onnxruntime-web` next to your project is another one (an override, a different major in your app),
  `pull` prints a warning: the `.mjs` and `.wasm` files must come from the same ORT version as the ORT code in your
  bundle, or they fail to load at runtime.
- `GITHUB_TOKEN` or `GH_TOKEN`, when set, is sent to `api.github.com` only (for `--tag latest` and the release
  listing, to avoid the anonymous rate limit). It is never sent to `github.com`, to a redirect target, or to a
  `--base-url`. Release downloads of public repositories need no token.
- Exit codes: `0` ok, `1` usage or local error, `2` network or HTTP failure, `3` integrity failure (wrong size or
  SHA-256, unusable manifest, wrong `onnxruntime-web` version for `--ort-from-node-modules`).
- A tag without a release is a one-line error that lists the existing releases when the GitHub API answers.
  Offline errors say how to continue: `--ort-from-node-modules`, a mirror via `--base-url`, or running `pull` once
  where there is network (the files are then kept).

## 3. Wiring per tool

In every case the folder `pull` filled has to be reachable as `/cipetpet/...` (or whatever prefix you use), `.wasm`
must be served as `application/wasm` and `.mjs` as a JavaScript type (all common servers do this), and for
multi-threaded WASM the page needs the two headers

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them everything still works, on one thread (CDN.md, section 6). The framework snippets below are plain
configuration of those tools; they are not part of this repository's tests.

**Plain static site.** Copy or pull into the folder your web server serves, e.g. `site/cipetpet/`, and load the
library from a CDN or your own copy (`<script type="module">`); `wasmPaths` is the URL of the `ort/` folder:

```html
<script type="module">
  import { AntaliaMini } from "https://cdn.jsdelivr.net/npm/cipetpet@0.1.0/dist/browser/cipetpet.min.js";
  const tts = await AntaliaMini.load("/cipetpet/antalia-mini-int8.cpet", { wasmPaths: "/cipetpet/ort/" });
</script>
```

(The jsDelivr URL needs `cipetpet` to be published on npm.) Add the COOP/COEP headers in your server's config
(nginx `add_header`, a Netlify or Cloudflare Pages `_headers` file).

**Vite.** `npx cipetpet pull --dir public/cipetpet`: everything in `public/` is served at the site root, so the URLs
are `/cipetpet/...`. Headers for the dev and preview servers in `vite.config.ts`:

```ts
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
export default defineConfig({ server: { headers: isolation }, preview: { headers: isolation } });
```

For production set the same headers at your host. Vite copies `public/` to `dist/` unchanged.

**Next.js.** `public/cipetpet` is served at `/cipetpet`. Headers in `next.config.js`:

```js
module.exports = {
  async headers() {
    return [
      { source: "/:path*", headers: [
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
      ] },
      // packs and ORT files: same URL for the lifetime of this cipetpet version
      { source: "/cipetpet/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
    ];
  },
};
```

Next serves `.wasm` as `application/wasm`. If you want `immutable` caching, pull into a folder with the version in
its name (`--dir public/cipetpet-0.1.0`), so the URL changes whenever the files do, and set
`Cache-Control: public, max-age=31536000, immutable` for that folder. Load the library only in client components
(it uses `AudioContext`, `Worker`, ...), e.g. inside `useEffect` or with `next/dynamic` and `ssr: false`.

**Create React App / webpack.** CRA copies `public/` to the build root; `npx cipetpet pull --dir public/cipetpet`
and use `/cipetpet/...` (with a `homepage` set in `package.json`, prefix with `process.env.PUBLIC_URL`). Dev server
headers: in CRA add `src/setupProxy.js`

```js
module.exports = (app) => app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});
```

and with plain webpack use `devServer.headers`. Production headers come from your host. webpack's
`copy-webpack-plugin` can also copy the folder if your static folder is not called `public`.

**Express (or any Node static server).**

```js
import express from "express";
const app = express();
app.use((req, res, next) => {
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});
app.use(express.static("public", { maxAge: "1d" }));   // serves public/cipetpet/ at /cipetpet/
app.listen(3000);
```

`express.static` sends `Accept-Ranges` and `ETag`, which is what pack loading wants.

## 4. The JavaScript

Main thread:

```ts
import { AntaliaMini, DuyuSmall } from "cipetpet";

const tts = await AntaliaMini.load("/cipetpet/antalia-mini-int8.cpet", { wasmPaths: "/cipetpet/ort/" });
const { audio, sampleRate } = await tts.synthesize("Merhaba dünya!");

const stt = await DuyuSmall.load("/cipetpet/duyu-small-int8.cpet", { wasmPaths: "/cipetpet/ort/" });
const { text } = await stt.transcribe(float32Mono16k);
```

Off the main thread (the worker clients take the same two options):

```ts
import { createAntaliaWorker, createDuyuWorker } from "cipetpet";

const tts = await createAntaliaWorker("/cipetpet/antalia-mini-int8.cpet", { wasmPaths: "/cipetpet/ort/" });
const stt = await createDuyuWorker("/cipetpet/duyu-small-int8.cpet", { wasmPaths: "/cipetpet/ort/" });
```

With `cipetpet-react` the options go into the model props of the provider (they are `cipetpet`'s load options plus
`source` and `useWorker`); without `wasmPaths` a bundler app looks for ORT's `.wasm` next to its own script and gets a 404:

```tsx
<CipetpetProvider
  tts={{ source: "/cipetpet/antalia-mini-int8.cpet", wasmPaths: "/cipetpet/ort/" }}
  stt={{ source: "/cipetpet/duyu-small-int8.cpet", wasmPaths: "/cipetpet/ort/", useWorker: true }}
>
```

`pull` prints this form when `cipetpet-react` is installed. With `--webgpu` the printed options also contain
`backend: "webgpu"`; with `--no-ort` `wasmPaths` is the jsDelivr folder of the matching `onnxruntime-web` (or the URL
of your own copy).

`wasmPaths` must end with `/` and is the folder that holds `ort-wasm-simd-threaded.mjs` and `.wasm` (and the
`asyncify` pair for `backend: "webgpu"`). To also check the pack file you downloaded, give the `integrity` string
from `cipetpet-release.json` (`PackLoadOptions.integrity`); with `cache: true` the pack is kept in the browser's
Cache API under that check.

## 5. Install scripts and .gitignore

The files are build products, not source: do not commit them. `.gitignore`:

```
/public/cipetpet/
```

Fetch them whenever dependencies are installed, with scripts in your `package.json`. `pull` is idempotent and
fast when everything is there, so it is safe in several of them:

```json
{
  "scripts": {
    "postinstall": "cipetpet pull --dir public/cipetpet",
    "predev": "cipetpet pull --dir public/cipetpet",
    "prebuild": "cipetpet pull --dir public/cipetpet"
  }
}
```

`postinstall` runs after `npm install` in your project. If your project is itself a library that others install,
do not use `postinstall` (it would run on their machines); use `predev`/`prebuild` only, which also avoids network
access during installs. npm puts `node_modules/.bin` on the `PATH` for these scripts, so `cipetpet` resolves to the installed
version; pin the files to a release with `--tag vX.Y.Z` if you want them independent of the library version.

## 6. Offline and CI

- Files with the right hash are never downloaded again. Keep `public/cipetpet` between CI runs (cache it, or bake
  it into a Docker layer) and `pull` only checks hashes. Example for GitHub Actions:

  ```yaml
  - uses: actions/cache@v4
    with:
      path: public/cipetpet
      key: cipetpet-${{ hashFiles('package-lock.json') }}
  - run: npx cipetpet pull
  ```

- With no network, `pull` succeeds when every wanted file is present (it falls back to the local
  `cipetpet-release.json`). A missing file then fails with exit code 2 and the way out.
- The ONNX Runtime files are in your `node_modules` already (`onnxruntime-web` is a dependency of `cipetpet`):
  `npx cipetpet pull --ort-from-node-modules` copies them instead of downloading, after checking the version and the
  hashes.
- Behind a firewall or for air-gapped builds: download the release files once, put them on an internal web server
  (or a plain folder served over `http://localhost`), and pass `--base-url https://mirror.internal/cipetpet/0.1.0/`.
- `pull` does not use an HTTP proxy by itself (it uses Node's built-in `fetch`); in such environments use a mirror.

## 7. Verifying

```sh
npx cipetpet verify --dir public/cipetpet
```

re-hashes the folder against `cipetpet-release.json` and exits with `3` if a file differs (`--strict` also fails
for files of the release that are not in the folder; a folder with only some packs is fine without it).

**Who vouches for the manifest?** Every hash `pull` checks comes from `cipetpet-release.json`, which is served next to
the files, so the manifest itself needs a second source. There are two:

- The npm package. Before `npm publish` the maintainer runs
  `npm run release:assets -- --digest bin/release-digest.json` (section 8); the package then carries the SHA-256 of the
  manifest of its own version, and `pull` refuses a release of that version whose manifest hashes differently (exit 3).
  Releases of other versions are not covered, and `pull` says so.
- `--manifest-sha256 HEX`, from a source you trust (the `SHA256SUMS` line in the release notes, a pinned value in
  your CI): `npx cipetpet pull --manifest-sha256 <hex>`.

Without either, a changed release of the same version is still caught on the second `pull` into the same folder (exit 3).

To check a download by hand, use the release's `SHA256SUMS` (`sha256sum -c` format, one line per file):

```sh
cd where-you-put-the-release-files
shasum -a 256 -c SHA256SUMS            # macOS; on Linux: sha256sum -c SHA256SUMS
```

`sha256sum -c --ignore-missing SHA256SUMS` (GNU coreutils) checks only the files you downloaded. The `integrity`
values in `cipetpet-release.json` are the same hashes as SRI strings for `PackLoadOptions.integrity`.

## 8. For maintainers: cutting a release

A release is made by `.github/workflows/release.yml` when a tag `vX.Y.Z` is pushed. It has two jobs:

- `build` (read-only token): installs the dependencies (`npm ci --ignore-scripts`), type-checks, runs the browser-free
  tests, downloads the pinned upstream model files (`tools/upstream.lock.json`, each file checked against its
  SHA-256), builds the packs, runs the pack smoke tests, checks that the tag equals `v` + the version in
  `cipetpet/package.json`, assembles the release files, checks them against `SHA256SUMS` and hands them over as a
  workflow artifact.
- `publish` (the only job with `contents: write`): has no checkout and runs no npm. It checks the file list and
  `SHA256SUMS` of the artifact, stops if the release already exists as published with a different
  `cipetpet-release.json`, then creates the release as a draft, uploads with the preinstalled `gh` CLI and publishes it.

All actions are pinned to commit SHAs. The packs are deterministic: the same upstream files give byte-identical packs,
**for the same Node build**. The packs are gzipped with the zlib inside the Node binary, so the official builds
(nodejs.org, `actions/setup-node`; checked: 22.23.3 and 26.9.0) give the same bytes, while a Node with a different
system zlib (for example Homebrew's) can give other bytes and hashes. That is why the workflow pins an exact Node
version. A release that is already published is never overwritten with other hashes (the `publish` job refuses it),
and packs you build by hand on another Node are fine for yourself but are not the release's packs.

The commands in this section create tags and releases; they were written down, not executed, when this document was
made.

1. Bump `version` in `cipetpet/package.json` (and the `cipetpet` range in `cipetpet-react` if needed), commit.
   `onnxruntime-web` is pinned to an exact version in `cipetpet/package.json`: the ORT files of the release are those
   of that version, so bump it together with the packs (rebuild them, they record the ORT version).
2. Tag and push:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. Watch the "release" workflow. To re-run it for an existing tag: Actions, "release", "Run workflow", enter the tag
   (it uploads with `--clobber`, which only repairs files while the manifest is unchanged).
4. Before `npm publish`, put the manifest digest into the package, so that `cipetpet pull` has a trust anchor outside
   the download (the digest has to be of the release you just tagged; the build is deterministic, so it can be made
   from the workflow's `SHA256SUMS` or locally with the same Node build):

   ```sh
   cd cipetpet
   npm run release:assets -- --out release --digest bin/release-digest.json
   grep ' cipetpet-release.json$' release/SHA256SUMS      # must equal the line in the GitHub release's SHA256SUMS
   npm publish                                            # prepublishOnly (tools/check-digest.mjs) fails without the digest
   ```

By hand, without Actions (needs `gh` and the packs built by `npm run packs`):

```sh
cd cipetpet
npm run release:assets -- --notes release-notes.md          # writes cipetpet/release/ and the notes
(cd release && shasum -a 256 -c SHA256SUMS)
gh release create v0.1.0 --title v0.1.0 --notes-file release-notes.md release/*
# or, for an existing release:
gh release upload v0.1.0 release/* --clobber
```

`release:assets` options: `--packs DIR` (default `packs`), `--out DIR` (default `release`, refused when not empty
unless `--force`, which only replaces a previous release folder), `--version X.Y.Z` (default from `package.json`),
`--notes FILE`, `--digest FILE` (writes `{format, version, manifestSha256}`; use `bin/release-digest.json`). The output is byte-identical when run twice.

Everything the workflow needs to be reproducible is in the repository: `tools/upstream.lock.json` pins the Hugging
Face commits and the SHA-256 of every model file the packs are built from (`npm run upstream` fetches and verifies
them into `.upstream/`).

### Release notes template

`npm run release:assets -- --notes FILE` fills this block (`{{TAG}}`, `{{VERSION}}`, `{{ORT_VERSION}}`, `{{REPO}}`
and `{{ASSET_TABLE}}`) and the workflow uses the result as the release description:

<!-- release-notes:start -->
```markdown
## cipetpet {{VERSION}}

Model packs and ONNX Runtime {{ORT_VERSION}} files for the `cipetpet` {{VERSION}} npm package.

Download them into your project's `public/` folder:

    npm install cipetpet@{{VERSION}}
    npx cipetpet pull --dir public/cipetpet --tag {{TAG}}

Browsers cannot fetch these release URLs directly (no CORS headers): serve the files from your own origin. See
[RELEASES.md](https://github.com/{{REPO}}/blob/{{TAG}}/cipetpet/RELEASES.md) for the folder layout, framework setup and
verification (`SHA256SUMS`, `cipetpet verify`).

### Files

{{ASSET_TABLE}}

Models: Antalia-2 Mini by PatientDesk AI (Apache-2.0), Duyu-small by KaanAydinli (Apache-2.0, encoder design from
balbal). ONNX Runtime by Microsoft (MIT). See `NOTICE`.
```
<!-- release-notes:end -->

## 9. Sizes

Release `v0.1.0` (sizes of the files in `cipetpet/release/`, onnxruntime-web 1.30.0; `MiB` = 1024 x 1024 bytes):

| file | bytes | MiB | in the default `pull` |
| --- | ---: | ---: | :---: |
| `antalia-mini-int8.cpet` | 10,675,221 | 10.18 | yes |
| `antalia-mini-fp16.cpet` | 16,056,405 | 15.31 | |
| `antalia-mini-mixed.cpet` | 23,411,029 | 22.33 | |
| `antalia-mini-fp32.cpet` | 31,271,253 | 29.82 | |
| `duyu-small-int8.cpet` | 55,849,756 | 53.26 | yes |
| `duyu-small-q4.cpet` | 33,518,876 | 31.97 | |
| `ort-wasm-simd-threaded.wasm` | 14,239,897 | 13.58 | yes |
| `ort-wasm-simd-threaded.mjs` | 24,381 | 0.02 | yes |
| `ort-wasm-simd-threaded.asyncify.wasm` | 26,781,914 | 25.54 | with `--webgpu` |
| `ort-wasm-simd-threaded.asyncify.mjs` | 53,057 | 0.05 | with `--webgpu` |
| `cipetpet-release.json` | about 3 KB | | yes |
| `LICENSE`, `NOTICE` | 11,358 and 2,493 | | yes |
| `SHA256SUMS` | about 1 KB | | (not downloaded by `pull`) |

The default `pull` is about 77 MiB (the two default packs, the two ORT files and the small documents); all assets
together are about 202 MiB. GitHub allows files up to 2 GiB per release asset, so none of these is near a limit.
