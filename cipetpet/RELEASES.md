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
[8. For maintainers: cutting a release and npm trusted publishing](#8-for-maintainers-cutting-a-release) -
[9. Sizes](#9-sizes)

## 1. What a release contains

A release `vX.Y.Z` has flat files, no folders. `X.Y.Z` is the version of the `cipetpet` npm package the files were
made for, and `cipetpet pull` takes exactly that version by default, so the packs match the library you installed.

| file | what it is |
| --- | --- |
| `antalia-mini-int8.cpet` | Antalia-2 Mini (Turkish text to speech), int8 graphs. **Default.** |
| `antalia-mini-mixed.cpet`, `antalia-mini-fp16.cpet`, `antalia-mini-fp32.cpet` | the same model in more precise variants |
| `duyu-small-int8.cpet` | Duyu-small (speech recognition, Turkish + English), int8 graphs. **Default.** |
| `duyu-small-q4.cpet` | Duyu-small with 4-bit weights, smaller |
| `ema-lightning-fp32.cpet` | EMA Lightning (Turkish text to speech, 8.6M parameters), fp32 graphs + normalizer-tr in WebAssembly |
| `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` | ONNX Runtime Web for the default `wasm` backend |
| `ort-wasm-simd-threaded.asyncify.mjs`, `ort-wasm-simd-threaded.asyncify.wasm` | ONNX Runtime Web for `backend: "webgpu"` |
| `cipetpet-release.json` | the list of the files above: name, size, SHA-256, and for packs the model, variant and SRI `integrity` string |
| `SHA256SUMS` | `sha256sum -c` file for everything above (it lists `cipetpet-release.json` too, not itself) |
| `LICENSE`, `NOTICE` | Apache-2.0 text; credits (Antalia-2 Mini by PatientDesk AI, EMA Lightning by Canberk Aslan with normalizer-tr by Erdem Tuna, Duyu-small by KaanAydinli, encoder design from balbal) and the ONNX Runtime MIT notice |

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

- The npm package. The release workflow writes `bin/release-digest.json` into the package from the published
  release's own `cipetpet-release.json` and `SHA256SUMS` before it packs the package (section 8.1); the package then
  carries the SHA-256 of the manifest of its own version, and `pull` refuses a release of that version whose manifest
  hashes differently (exit 3). Releases of other versions are not covered, and `pull` says so. The digest is the one of
  the *published* release, and `npm-pack` refuses to continue if that manifest differs from the one the same workflow
  run built. What the package therefore guards against is a release that is changed *later*; it cannot protect against a
  compromised release pipeline (whoever controls the workflow controls both the release and the package).
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

Pushing a tag `vX.Y.Z` does everything: `.github/workflows/release.yml` builds the release files, creates the GitHub
Release, and then publishes `cipetpet` and `cipetpet-react` to npm with **npm trusted publishing** (OIDC: GitHub proves
to npm which workflow is running, and npm hands out a short-lived publish token. There is no npm token in the
repository, in the workflow or on a laptop, and 2FA stays on for the accounts and packages).

Contents of this section: [8.1 Jobs](#81-the-four-jobs-and-why-they-are-split) -
[8.2 Release procedure](#82-release-procedure-011-and-later) -
[8.3 npm trusted publishing setup](#83-npm-trusted-publishing-setup-once-on-npmjscom) -
[8.4 Hardening](#84-hardening-after-the-first-successful-trusted-publish) -
[8.5 Verifying provenance](#85-verifying-provenance) - [8.6 Troubleshooting](#86-troubleshooting) -
[8.7 Manual fallback](#87-manual-fallback-without-actions) - [8.8 Facts taken from the npm documentation](#88-facts-taken-from-the-npm-documentation) -
[Release notes template](#release-notes-template)

### 8.1 The four jobs and why they are split

| job | token permissions | runs | does |
| --- | --- | --- | --- |
| `build` | `contents: read` | repository code | `npm ci --ignore-scripts`, type-check, browser-free tests, pinned upstream download (each file checked against its SHA-256), packs, pack smoke tests, release files, `sha256sum -c`, hands them over as a workflow artifact. Right after checkout (before the long steps, and always before the GitHub release exists) it checks that the tag is `v` + the version of **both** `package.json` files and that `cipetpet-react`'s `peerDependencies.cipetpet` accepts that version (semver from npm, prereleases included) |
| `publish` | `contents: write` | no checkout, no npm | checks the artifact's file list and `SHA256SUMS`, stops if the release already exists as published with a different `cipetpet-release.json`, creates the release as a draft, uploads with the preinstalled `gh` CLI, publishes it |
| `npm-pack` | `contents: read` (**no** `id-token`) | repository code | checks out the tag, `npm ci --ignore-scripts` + type-check + build for `cipetpet`, then `cipetpet-react` (it builds against `../cipetpet/dist`); checks the versions again; makes `cipetpet/bin/release-digest.json` from the *published* release (`cipetpet-release.json` and `SHA256SUMS` downloaded with `gh`, the manifest checked against its `SHA256SUMS` line and against the manifest the `build` job of the same run made, `{format, version, manifestSha256}` written) and runs `tools/check-digest.mjs`; `npm pack` of both packages; `SHA256SUMS` of the two `.tgz`; uploads them as the workflow artifact `npm-tarballs` (3 days) |
| `npm-publish` | `id-token: write`, `contents: read` | **no repository code** | downloads `npm-tarballs`; checks the file list (exactly the two tarballs and `SHA256SUMS`, no links, names `^[a-z0-9.-]+\.tgz$`), `sha256sum -c`, and reads name, version, `repository.url` and `publishConfig` from each tarball's own `package.json` (name in `{cipetpet, cipetpet-react}`, version = tag, URL = this repository, `publishConfig` exactly `{"access": "public"}`); asks the registry about both exact versions first (`200` = skip, `404` = to publish, anything else stops the job before anything is published); if something has to be published, checks that this run *is* the tag (`git ls-remote` of the tag, peeled, equals `$GITHUB_SHA`); then runs `npm publish ./<tarball> --access public --provenance --registry https://registry.npmjs.org/ --loglevel verbose` for `cipetpet` and after it `cipetpet-react`; at the end it waits (up to 15 minutes) for the versions to appear and compares the registry's `dist.integrity` with the tarball |

Why two npm jobs: the OIDC token is the one credential that lets someone publish to npm. It is only issued to a job
that has `id-token: write`, so that permission is given to the one job that runs **no repository code**. Everything
that executes code from the repository or from its dependencies (`npm ci`, `tsc`, `esbuild`, the build scripts) is in
`npm-pack`, which cannot ask for the token. `npm-publish` has no checkout, no `npm ci` and no `setup-node` cache; it only
looks at the tarballs and gives them to `npm publish`, and `npm publish <tarball>` runs none of the lifecycle scripts
of the package (so `prepublishOnly` is not run there; `npm-pack` does its work explicitly, which is why
`check-digest.mjs` is a workflow step).

What this split does **not** do: `SHA256SUMS` of the tarballs is made by `npm-pack` and checked by `npm-publish`, but
`npm-pack` is the job that runs the repository's and its dependencies' code, so a compromised dependency there writes
tarballs *and* a matching `SHA256SUMS`. The sums only catch transport damage. The checks on name, version,
`repository.url`, `publishConfig` and the file list limit what such a job can publish (these two names, at the tag's
version, no scripts, no other registry), not what is inside the files, and the content then gets a valid provenance
attestation. The only control that puts a human between a poisoned tarball and the registry is the approval gate
below (the `npm` environment with required reviewers), which is therefore the recommended hardening (8.4), not a
nicety. Also: anyone with write access to the repository can push a `v*` tag or start the workflow, and that publishes.

Other properties:

- Re-running is safe. *Actions, "release", "Run workflow"* runs all four jobs again. `npm-publish` skips a version
  that is already on the registry (it only logs a warning when the registry's bytes differ from what this run
  packed). If `cipetpet` was published and `cipetpet-react` was not (a failed run), the re-run publishes just the
  second one. When the registry answers anything but `200` or `404` the job fails, it never guesses.
- **How to re-run.** The provenance that npm signs names `$GITHUB_REF` and `$GITHUB_SHA` of the run, and versions are
  immutable, so a version must only be published by a run that *is* the tag. Use **Re-run failed jobs** on the original
  run (within 7 days: `npm-pack` needs that run's `release-files` artifact), or **Run workflow** with *Use workflow
  from* set to the **tag** `vX.Y.Z` (the tag must contain `release.yml` with the npm jobs, so not `v0.1.0`) and the tag as
  input. A *Run workflow* from `main` or another branch is refused by `npm-publish` when it has anything to publish
  (nothing is published, and it says why); it can still skip versions that are already on npm.
- Node: both npm jobs use Node `24.21.0`, whose npm is `11.19.0`. The `build` job keeps Node `22.23.3` (the packs
  need that exact zlib), but that Node ships npm `10.9.9`, which is too old for trusted publishing (needs 11.5.1).
  Both npm jobs have a step that fails if Node is older than 22.14.0 or npm older than 11.5.1.
- `setup-node` is used without `registry-url`: the documentation's example sets it, which makes `setup-node` export a
  placeholder `NODE_AUTH_TOKEN`; npm's default registry is the same URL and the OIDC exchange does not need it, so it
  is left out and `npm-publish` fails if `NODE_AUTH_TOKEN` or `NPM_TOKEN` is set at all. (If the first real publish
  ends in `ENEEDAUTH` although the Trusted Publisher form is right, adding `registry-url: https://registry.npmjs.org`
  to that `setup-node` step is the one deviation from the documented example to undo.)
- `--provenance` is passed although the documentation says trusted publishing generates provenance by itself (public
  repository and public package): this way npm refuses to publish instead of publishing a version without it.
- A prerelease tag (`v0.2.0-rc.1`) is published with `--tag next` so that it never becomes `latest`.
- Only GitHub-hosted runners work (`ubuntu-latest`); trusted publishing does not support self-hosted runners.
- Approval gate (recommended, off by default so that the forms in 8.3 work as written): create the GitHub environment
  `npm` (Settings, Environments) with required reviewers and a deployment rule that allows only tags `v*`, add
  `environment: npm` to the `npm-publish` job, and put `npm` into the *Environment name* field of **both** Trusted
  Publisher forms (8.3). A workflow run started with *Run workflow* from another branch uses that branch's copy of
  `release.yml` (which could have the checks removed); with the environment that cannot publish without an approval.
- `publishConfig` is read by npm from the tarball being published and can hold any npm setting, including `registry`
  and `tag`; settings given on the command line win. The workflow therefore passes `--registry` (the OIDC token is sent to
  the registry npm picks) and requires `publishConfig` to be exactly `{"access": "public"}` in both tarballs, so a
  tarball cannot send the token to another host.

### 8.2 Release procedure (0.1.1 and later)

0. First release after the trusted publishing change only: create both Trusted Publisher entries (8.3) the same day,
   shortly before pushing the tag. They must exist, with *Allowed actions* ticked for `npm publish`, before `npm-publish`
   runs (otherwise it ends in `ENEEDAUTH` after the GitHub release is already public), and an entry that has no
   successful publish within 2 days expires.
1. Check that CI on `main` is green.
2. Bump the version in **both** packages to the same `X.Y.Z` (the workflow stops if the tag does not equal `v` + each
   version):

   ```sh
   (cd cipetpet && npm version X.Y.Z --no-git-tag-version)
   (cd cipetpet-react && npm version X.Y.Z --no-git-tag-version)
   ```

   If `cipetpet-react`'s `peerDependencies.cipetpet` range does not include the new core version (`^0.1.0` ends at
   0.1.x, so a `0.2.0` needs `^0.2.0`; a prerelease such as `0.2.0-rc.1` needs a range that names a prerelease, e.g.
   `^0.2.0-rc.1`), change it too: the `build` job checks this, and the tag matching both versions, before it builds
   anything or creates the release. `onnxruntime-web` is pinned to an exact version in
   `cipetpet/package.json`: the ORT files of the release are those of that version, so bump it together with the packs
   (rebuild them, they record the ORT version). Do not commit `cipetpet/bin/release-digest.json`: it is in
   `.gitignore` and the workflow makes it from the published release.
3. Commit, tag, push the commit and then the tag:

   ```sh
   git commit -am "Release X.Y.Z"
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

4. Watch *Actions*, workflow **release**: `build` (long: it downloads and packs the models), `publish` (the GitHub
   Release appears), `npm-pack`, `npm-publish`. In `npm-publish`, the step *Publish to npm* prints `npm notice` lines
   and `+ cipetpet@X.Y.Z`, then `+ cipetpet-react@X.Y.Z`; the step *Check the registry* adds one line per package to the
   run summary ("provenance attached"). A new version can take several minutes to show up on npmjs.com (`cipetpet` 0.1.0
   took about ten); the step waits for it and only warns if it does not show.
5. Check the result (8.5).

To run the workflow again for a tag, see "How to re-run" in 8.1. Starting it for an already published tag from `main`
exercises `build`, `publish`, `npm-pack` and the version checks of `npm-publish` (every npm version is skipped), but
**not** the OIDC exchange and not the source check, because nothing is published. (The `v0.1.0` tag itself does not
contain the npm jobs.)

### 8.3 npm trusted publishing setup (once, on npmjs.com)

Do this for **each** of the two packages, `cipetpet` and `cipetpet-react` (a Trusted Publisher belongs to one package;
both name the same workflow):

1. Sign in at npmjs.com as a maintainer of the package.
2. Open the package page, **Settings**, section **Trusted Publisher**, choose **GitHub Actions**.
3. Fill in exactly (all fields are case-sensitive and must be exact):

   | field | value |
   | --- | --- |
   | Organization or user | `IsaEs` |
   | Repository | `delicious-cipetpet` |
   | Workflow filename | `release.yml` (only the file name with its extension, not `.github/workflows/release.yml`) |
   | Environment name | leave empty (only `npm` if you added `environment: npm` to the job, see 8.1) |
   | Allowed actions | tick `npm publish` (`npm stage publish` is always allowed; `npm dist-tag` is not needed) |

4. Save. npm does **not** check the entry when you save it; a wrong value only shows up as a failed publish.
5. Time limit: a new Trusted Publisher entry must complete its first successful publish within **2 days**, otherwise it
   expires and can no longer be used or edited (delete it and create it again). So set it up shortly before the next
   release, not months ahead. A run that only *skips* versions (re-run of an old tag) does not count.
6. `package.json` of both packages must have `repository.url` equal to this GitHub repository (it does:
   `git+https://github.com/IsaEs/delicious-cipetpet.git`, case-sensitive); `npm-publish` checks it before publishing.

The first real tag after the setup is also the test of the setup. Keep the old granular token until that publish has
worked (8.4).

Staged publishing (alternative): the documentation also describes `npm stage publish`, which puts a version in a
review queue that a person approves (interactively) before it goes live, and recommends allowing only that for maximum
security. This workflow uses `npm publish` because the release should need no human at the keyboard. To switch, change
the command in the step *Publish to npm*, untick `npm publish` in both forms, and approve the staged versions yourself.

### 8.4 Hardening (after the first successful trusted publish)

Only after a tag has published both packages through the workflow:

1. For each package: npmjs.com, package **Settings**, **Publishing access**, choose *Require two-factor authentication
   and disallow tokens*, save. This only affects classic/granular tokens; trusted publishers keep working because they
   use OIDC.
2. Revoke the granular access token that bypasses 2FA (npmjs.com, your profile, **Access Tokens**, delete it).
3. Remove the `_authToken` line for `registry.npmjs.org` from `~/.npmrc`. Nothing in this project needs it any more.
   After step 1 a manual publish (8.7) can no longer use a token; whether an interactive `npm login` session (with 2FA)
   still publishes was **not verified** (the npm documentation only says the setting affects "traditional token
   authentication"). Until that is tested, assume the workflow is the only way to publish.
4. Recommended: protect the tags `v*` in the repository settings (tag rules), and add the approval gate of 8.1:
   whoever can push a `v*` tag, or run the workflow from a branch, can publish, and the checks in `npm-publish` are no
   protection against a changed workflow file.

### 8.5 Verifying provenance

- npmjs.com: the version page of `cipetpet` / `cipetpet-react` shows a *Provenance* section ("Built and signed on GitHub
  Actions") that links the source commit and the workflow run.
- Registry data: `npm view cipetpet@X.Y.Z dist.attestations` prints the URL of the attestations and the provenance
  predicate type (older versions, like 0.1.0 which was published by hand, print nothing).
  (`dist.attestations` is read by the workflow too; it is not described on the npm documentation pages used here, so
  if it changes shape, the step *Check the registry* only warns.)
- In a project that installed the packages: `npm audit signatures` reports verified registry signatures and verified
  attestations (the documentation recommends keeping npm current, since the attestation format may change).

### 8.6 Troubleshooting

The messages below are the usual ones for these situations; the exact wording changes between npm versions, and none of
them has been seen with this workflow yet (see 8.8).

| symptom | meaning and fix |
| --- | --- |
| `ENEEDAUTH` / "This command requires you to be logged in" in *Publish to npm* | npm got no usable OIDC token, or the registry refused the exchange (no matching Trusted Publisher, `npm publish` not ticked under *Allowed actions*, entry expired). npm swallows the reason and only logs it at verbose level, which this step turns on: **read the lines starting with `oidc`** in the log (for example `Failed token exchange request with body message: ...`, or `Skipped because incorrect permissions for id-token`). Check, in this order: the form on npmjs.com names the workflow file *exactly* `release.yml` (case, extension, no folder), owner `IsaEs`, repository `delicious-cipetpet`; the job has `id-token: write`; the runner is GitHub-hosted; the entry is not older than 2 days without a publish; npm is 11.5.1 or newer. |
| `E404 Not Found - PUT https://registry.npmjs.org/cipetpet` | not expected with trusted publishing (a failed exchange ends in `ENEEDAUTH` before any request is sent); if it appears, the credential was accepted but not for this package: each package needs its own entry, and the name must be one you own. |
| `E403` "You cannot publish over the previously published versions" | the version is already on npm. Normally `npm-publish` skips it; if the registry still showed `404` (it can lag by about ten minutes after a publish), this is what a quick re-run after a half-finished run ends in. It is safe (npm itself refuses to overwrite): wait and re-run. A published version can never be replaced: bump the version. |
| `E403` "Two-factor authentication or granular access token with bypass 2fa enabled is required" | no valid credential reached the registry: as for `ENEEDAUTH`. |
| `E422` "Error verifying sigstore provenance bundle ... repository.url" | `repository.url` in the tarball's `package.json` does not match `https://github.com/IsaEs/delicious-cipetpet` (case-sensitive). `npm-publish` checks this earlier with a clearer message. |
| "Automatic provenance generation not supported" / no OIDC provider | the job is not on a GitHub-hosted runner, or lacks `id-token: write`. Self-hosted runners are not supported by npm trusted publishing at all. |
| *Check Node, npm and the OIDC permission*: "npm x is older than 11.5.1" | the pinned Node of the job ships an older npm. Pin a Node whose bundled npm is 11.5.1+ (24.x does; 22.x ships 10.9.x), or add `npm install -g npm@^11` to the job. |
| *Check the files* / *Check what is inside the tarballs* fails | the artifact is not what `npm-pack` should have made (extra or missing file, wrong name, version or repository inside the tarball, link inside a tarball). Nothing was published. Read the message; it names the file. |
| `build` fails on "the tag ... does not match" or "peerDependencies.cipetpet ... does not accept" | the version of `cipetpet` or `cipetpet-react` is not the tag, or the peer range excludes the version. This is checked first, before any release exists: fix it, delete the wrong tag (`git push origin :refs/tags/vX.Y.Z`, `git tag -d vX.Y.Z`), commit, tag again. (If a GitHub release for that tag was published anyway, never reuse the tag: bump the version.) |
| `npm-publish` fails on "this run is for refs/heads/main at ..., but vX.Y.Z is at ..." | the run was started with *Run workflow* from a branch, or the tag moved during the run. Nothing was published. Re-run as described in 8.1 ("How to re-run"). |
| `npm-pack` fails on "has a cipetpet-release.json ... that differs from the one this run built" | the GitHub release was changed after the `publish` job created it. Look at who edited it; do not continue before you understand it. |
| `npm-pack` cannot download `release-files` | the artifact of the original run expired (7 days). Start a new run with *Run workflow* from the tag. |
| `the registry answered HTTP 5xx / 403 / 429 ... not publishing` | the check whether the version exists did not give 200 or 404; nothing was published. Re-run. |
| `cipetpet` is on npm but `cipetpet-react` is not | `npm-publish` failed after the first package. Re-run the workflow for the tag: the first is skipped, the second is published. |
| "workflow filename" entry saved, still failing, a reusable workflow or `workflow_dispatch` is involved | the check uses the *calling* workflow's name. `release.yml` is called directly (tag push or Run workflow), so it matches; if the job is ever moved to a reusable workflow, `id-token: write` has to be set in the caller too. |

### 8.7 Manual fallback (without Actions)

Only if the workflow cannot be used. It publishes without provenance and needs a login with 2FA (`npm login`), not a
token. The release itself must exist first (GitHub Release for the tag), then:

```sh
cd cipetpet
npm run release:assets -- --out release --digest bin/release-digest.json
grep ' cipetpet-release.json$' release/SHA256SUMS      # must equal the line in the GitHub release's SHA256SUMS
npm publish                                            # prepublishOnly (tools/check-digest.mjs) fails without the digest
cd ../cipetpet-react && npm publish                    # after cipetpet; prepublishOnly type-checks and builds
```

The digest must be the one of the release you just tagged (the build is deterministic, so it can be made locally with
the same Node build or taken from the release's `SHA256SUMS`). The GitHub release itself, by hand (needs `gh` and the
packs built by `npm run packs`):

```sh
cd cipetpet
npm run release:assets -- --notes release-notes.md          # writes cipetpet/release/ and the notes
(cd release && shasum -a 256 -c SHA256SUMS)
gh release create vX.Y.Z --title vX.Y.Z --notes-file release-notes.md release/*
# or, for an existing release:
gh release upload vX.Y.Z release/* --clobber
```

`release:assets` options: `--packs DIR` (default `packs`), `--out DIR` (default `release`, refused when not empty
unless `--force`, which only replaces a previous release folder), `--version X.Y.Z` (default from `package.json`),
`--notes FILE`, `--digest FILE` (writes `{format, version, manifestSha256}`; use `bin/release-digest.json`). The output is
byte-identical when run twice.

All actions in the workflow are pinned to commit SHAs. The packs are deterministic: the same upstream files give
byte-identical packs, **for the same Node build**. The packs are gzipped with the zlib inside the Node binary, so the
official builds (nodejs.org, `actions/setup-node`; checked: 22.23.3 and 26.9.0) give the same bytes, while a Node with a
different system zlib (for example Homebrew's) can give other bytes and hashes. That is why the `build` job pins an
exact Node version. A release that is already published is never overwritten with other hashes (the `publish` job
refuses it), and packs you build by hand on another Node are fine for yourself but are not the release's packs.

Everything the workflow needs to be reproducible is in the repository: `tools/upstream.lock.json` pins the Hugging
Face commits and the SHA-256 of every model file the packs are built from (`npm run upstream` fetches and verifies
them into `.upstream/`).

### 8.8 Facts taken from the npm documentation

Read on 2026-10-18 from <https://docs.npmjs.com/trusted-publishers> and
<https://docs.npmjs.com/generating-provenance-statements>. The workflow is built on these; re-read the pages when
npm changes something (the documentation was updated recently: "allowed actions" and `npm stage publish` are new).

| topic | what the documentation says |
| --- | --- |
| versions | "Trusted publishing requires npm CLI version 11.5.1 or later and Node version 22.14.0 or higher." (provenance in general: npm 9.5.0+). Dist-tag management through OIDC needs npm 11.21.0+ / 12.2.0+ (not used here). |
| providers | GitHub Actions (GitHub-hosted runners), GitLab CI/CD (GitLab.com shared runners), CircleCI (cloud). "Self-hosted runners are not currently supported." |
| permissions | the publishing job needs `id-token: write` ("Required for OIDC") and `contents: read`; a reusable (`workflow_call`) workflow needs `id-token: write` in caller and callee. |
| form fields (GitHub) | organization or user, repository, workflow filename (only the file name, including `.yml`/`.yaml`, the file has to exist in `.github/workflows/`), optional environment name, allowed actions. "All fields are case-sensitive and must be exact." Up to 10 trusted publishers per package. |
| `workflow_dispatch` | with `workflow_call` or `workflow_dispatch`, validation checks the *calling* workflow's name. |
| environment | optional; used if you use GitHub environments for deployment protection. The documentation's example workflow has no `environment:`. |
| allowed actions | `npm stage publish` is always allowed; direct `npm publish` and `npm dist-tag` are separate options. Defaults depend on when the entry was created: entries from before 2026-05-20 allow `npm publish` only; entries created after 2026-09-03 allow `npm stage publish` by default, so tick `npm publish` explicitly. |
| validation | npm does not validate the entry when it is saved; errors show up at publish time. A new entry has to complete its first successful publish within 2 days or it expires. |
| `repository.url` | must exactly match the GitHub repository (case-sensitive). Provenance needs a public `repository` field and a public repository. |
| provenance | generated automatically for GitHub Actions and GitLab CI/CD when repository and package are public, "without requiring the `--provenance` flag"; not for private repositories, not for CircleCI; switch off with `NPM_CONFIG_PROVENANCE=false`. Check with `npm audit signatures`. |
| tokens and 2FA | package setting *Require two-factor authentication and disallow tokens* only affects tokens; trusted publishers keep working. Trusted publishing is not meant for `npm install` / `npm ci` (private dependencies need a read-only token). |
| example | trigger on `v*` tags, `id-token: write`, `actions/setup-node` with Node 24 and caching off, then `npm publish`. |

Not in the documentation, so decided here and **untested until the first real tag**: publishing a *tarball*
(`npm publish ./x.tgz`) with trusted publishing and `--provenance`; publishing two packages from one workflow run
(each package has its own entry naming the same file); `--registry https://registry.npmjs.org/` together with the OIDC
exchange; the form `npm view <pkg>@<ver> dist.attestations`; the error messages in 8.6; omitting `registry-url`;
publishing a prerelease with `--tag next` (the documentation lists `npm dist-tag` as a separate, default-off permission
and does not say whether `--tag` at publish time needs it; if a prerelease publish is refused, tick *npm dist-tag* in
both forms); whether a manual `npm login` publish still
works after *Require two-factor authentication and disallow tokens* (8.4).

Taken from the source of npm 11.19.1 (`lib/commands/publish.js`, `lib/utils/oidc.js`, `libnpmpublish/lib/provenance.js`,
read on 2026-10-18; the documentation does not cover these): the provenance statement is built from `GITHUB_REF`,
`GITHUB_SHA` and `GITHUB_WORKFLOW_REF` of the run (hence the check in `npm-publish` that the run is the tag);
`publishConfig` of the published tarball is applied unless the same key is on the command line; the OIDC token is
requested for the audience `npm:<registry host>` and sent to the registry npm picked; every failure of the OIDC exchange
is logged at verbose level only and ends in `ENEEDAUTH` (hence `--loglevel verbose`).

What was run locally (never the OIDC exchange, the signing of provenance or a real publish, which only exist inside
GitHub Actions on a GitHub-hosted runner): the version check of `build` and the `run:` steps of `npm-pack` and
`npm-publish` against a clean clone of `main` and the real `v0.1.0` release (read-only `gh`), with Node 24.21.0 / npm 11.19.0, stubbed `npm`/`curl` for the publish paths
(both missing, one missing, registry errors, npm failures, branch run refused, prerelease `--tag next`), `npm publish
--dry-run` of both tarballs and of tarballs with a hostile `publishConfig`, and the real registry for the post-publish check.

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

Models: Antalia-2 Mini by PatientDesk AI (Apache-2.0), EMA Lightning by Canberk Aslan (Apache-2.0, with normalizer-tr by
Erdem Tuna), Duyu-small by KaanAydinli (Apache-2.0, encoder design from balbal). ONNX Runtime by Microsoft (MIT). See
`NOTICE`.
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
