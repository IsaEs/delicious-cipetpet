#!/usr/bin/env node
// cipetpet command line: downloads the .cpet model packs and the ONNX Runtime files of a GitHub Release into a
// folder of your project (usually public/cipetpet), and checks them again later.
//
//   cipetpet pull   [--dir public/cipetpet] [--tag vX.Y.Z | latest] [--repo owner/name]
//                   [--packs a,b | all] [--models antalia,duyu] [--no-ort] [--webgpu] [--no-docs]
//                   [--ort-from-node-modules] [--force] [--dry-run] [--list] [--base-url URL] [--manifest-sha256 HEX]
//   cipetpet verify [--dir public/cipetpet] [--strict]
//
// Node >= 20, built-in modules only. Exit codes: 0 ok, 1 usage or local error, 2 network or HTTP failure,
// 3 integrity failure (wrong size or SHA-256, version mismatch). RELEASES.md documents everything.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { lstat, open, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
const MANIFEST_NAME = "cipetpet-release.json";
const DIGEST_NAME = "release-digest.json"; // next to this script; written by release-assets --digest before npm publish
const MANIFEST_MAX_BYTES = 1024 * 1024;
const API_MAX_BYTES = 1024 * 1024;
const ASSET_MAX_BYTES = 4 * 1024 ** 3;
const MAX_ASSETS = 100;
const MAX_REDIRECTS = 5;
// CIPETPET_TIMEOUT_MS (milliseconds, at least 50) replaces all three timeouts; the tests use it
const TIMEOUT_OVERRIDE = Number(process.env.CIPETPET_TIMEOUT_MS) >= 50 ? Number(process.env.CIPETPET_TIMEOUT_MS) : 0;
const CONNECT_MS = TIMEOUT_OVERRIDE || 30_000; // until the response headers are in
const IDLE_MS = TIMEOUT_OVERRIDE || 60_000; // without a byte of the body
const API_MS = TIMEOUT_OVERRIDE || 15_000;
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-f]{64}$/;
// What a release may contain. The manifest comes from the same server as the files, so its names and sizes are
// checked against this list: a manifest can only name files cipetpet itself ships, never e.g. package.json or sw.js.
const PACK_NAME_RE = /^[a-z0-9][a-z0-9-]*\.cpet$/;
const ORT_NAME_RE = /^ort-wasm-simd-threaded(\.asyncify)?\.(mjs|wasm)$/;
const DOC_NAMES = new Set(["LICENSE", "NOTICE"]);
const KIND_LIMITS = {
  pack: { count: 32, bytes: 2 * 1024 ** 3 },
  ort: { count: 4, bytes: 64 * 1024 ** 2 },
  doc: { count: 2, bytes: 1024 ** 2 },
};
const DEFAULT_PACKS = ["antalia-mini-int8", "duyu-small-int8"];
const MODEL_ALIASES = { antalia: "antalia-mini", "antalia-mini": "antalia-mini", duyu: "duyu-small", "duyu-small": "duyu-small" };
const MODEL_CLASSES = { "antalia-mini": ["AntaliaMini", "tts"], "duyu-small": ["DuyuSmall", "stt"] };
const UA = `cipetpet-cli/${PKG.version} (+https://github.com/IsaEs/delicious-cipetpet)`;

class CliError extends Error {
  /** @param {string} message @param {1|2|3} code @param {{network?: boolean, notFound?: boolean}} [extra] */
  constructor(message, code, extra = {}) {
    super(message);
    this.code = code;
    this.network = !!extra.network;
    this.notFound = !!extra.notFound;
  }
}

// ------------------------------------------------------------------------------------------------ helpers

const sizeText = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(2)} MiB`);

function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * https everywhere; http only for loopback hosts (local mirrors and the tests). `allowHttp` is false for a hop
 * of a redirect chain that started on https: a server must not be able to bounce the CLI to http://127.0.0.1/...
 */
function checkUrl(u, allowHttp = true) {
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) {
    if (allowHttp) return;
    throw new CliError(`refusing to follow a redirect from https to ${u.protocol}//${u.host}`, 1);
  }
  throw new CliError(`refusing to use ${u.protocol}//${u.host}: only https is allowed (http only for localhost)`, 1);
}

function apiBase() {
  const override = process.env.CIPETPET_GITHUB_API;
  if (override) {
    // an override exists for tests and for GitHub Enterprise proxies on this machine; it must be loopback,
    // so that a token can never be sent to a host an environment variable picked
    const u = new URL(override);
    if (!isLoopbackHost(u.hostname)) throw new CliError("CIPETPET_GITHUB_API must point to localhost", 1);
    return u;
  }
  return new URL("https://api.github.com/");
}

function githubBase(repo, tag) {
  const override = process.env.CIPETPET_GITHUB_URL;
  let root = "https://github.com";
  if (override) {
    const u = new URL(override);
    if (!isLoopbackHost(u.hostname)) throw new CliError("CIPETPET_GITHUB_URL must point to localhost", 1);
    root = override.replace(/\/+$/, "");
  }
  return new URL(`${root}/${repo}/releases/download/${encodeURIComponent(tag)}/`);
}

function describeNetworkError(e, url) {
  const host = new URL(url).host;
  const cause = e && e.cause;
  const code = (cause && (cause.code || cause.name)) || (e && e.name) || "";
  const text = (cause && cause.message) || (e && e.message) || String(e);
  const timedOut = code === "AbortError" || code === "TimeoutError" || /timed out/.test(text);
  return `cannot reach ${host}: ${timedOut ? "timed out" : `${code ? `${code}: ` : ""}${text}`}`;
}

const OFFLINE_HINT =
  "If this machine is offline or behind a firewall: use --ort-from-node-modules for the ONNX Runtime files, " +
  "--base-url <mirror folder> for a copy of the release, or run pull once where there is network access (files already present are kept).";

/**
 * GET with manual redirects. The Authorization header goes only to `tokenOrigin`, never to a redirect target
 * on another origin. Resolves once the response headers are in; the caller reads the body with `readChunks`.
 */
async function openUrl(url, { token, tokenOrigin, headers = {}, connectMs = CONNECT_MS, idleMs = IDLE_MS } = {}) {
  const ctl = new AbortController();
  let timer;
  const arm = (ms = idleMs) => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new Error(`timed out after ${ms / 1000} s without data`)), ms);
  };
  let cur = new URL(url);
  const startedOnHttp = cur.protocol === "http:";
  try {
    for (let redirects = 0; ; redirects++) {
      checkUrl(cur, startedOnHttp);
      const h = { "user-agent": UA, "accept-encoding": "identity", ...headers };
      if (token && tokenOrigin && cur.origin === tokenOrigin) h.authorization = `Bearer ${token}`;
      arm(connectMs);
      const res = await fetch(cur, { redirect: "manual", headers: h, signal: ctl.signal });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel().catch(() => {});
        if (redirects >= MAX_REDIRECTS) throw new CliError(`too many redirects (more than ${MAX_REDIRECTS}) starting at ${url}`, 2);
        cur = new URL(loc, cur);
        continue;
      }
      return { res, url: cur, arm: () => arm(idleMs), stop: () => clearTimeout(timer), signal: ctl.signal };
    }
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof CliError) throw e;
    const reason = ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
    throw new CliError(describeNetworkError(reason, cur.href), 2, { network: true });
  }
}

/** Iterates over the body, re-arming the idle timer per chunk. Network errors become CliError(2). */
async function* readChunks(conn) {
  if (!conn.res.body) return;
  try {
    for await (const chunk of conn.res.body) {
      conn.arm();
      yield chunk;
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    const reason = conn.signal.aborted && conn.signal.reason instanceof Error ? conn.signal.reason : e;
    throw new CliError(describeNetworkError(reason, conn.url.href).replace("cannot reach", "connection to") + " (download interrupted)", 2, {
      network: true,
    });
  } finally {
    conn.stop();
  }
}

function statusError(conn, what) {
  const s = conn.res.status;
  return new CliError(`${what}: HTTP ${s} from ${conn.url.href}`, 2, { notFound: s === 404 });
}

/** Fetches a small text body (manifest, API answers) with a size cap. */
async function fetchText(url, cap, opts = {}) {
  const conn = await openUrl(url, opts);
  try {
    if (conn.res.status !== 200) {
      await conn.res.body?.cancel().catch(() => {});
      throw statusError(conn, opts.what ?? "request failed");
    }
    const declared = Number(conn.res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) throw new CliError(`${conn.url.href} is larger than ${cap} bytes; refusing to read it`, 3);
    const parts = [];
    let got = 0;
    for await (const c of readChunks(conn)) {
      got += c.byteLength;
      if (got > cap) throw new CliError(`${conn.url.href} is larger than ${cap} bytes; refusing to read it`, 3);
      parts.push(c);
    }
    return Buffer.concat(parts);
  } finally {
    conn.stop();
  }
}

async function sha256File(path) {
  const h = createHash("sha256");
  let bytes = 0;
  const fh = await open(path, "r");
  try {
    for await (const c of fh.createReadStream({ highWaterMark: 1 << 20 })) {
      h.update(c);
      bytes += c.length;
    }
  } finally {
    await fh.close();
  }
  return { sha256: h.digest("hex"), bytes };
}

/** @returns {Promise<{sha256: string, bytes: number} | undefined>} undefined when there is no regular file */
async function hashIfFile(path) {
  try {
    const st = await stat(path);
    if (!st.isFile()) return undefined;
  } catch {
    return undefined;
  }
  return sha256File(path);
}

function within(dir, path) {
  const r = relative(dir, path);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

// ----------------------------------------------------------------------------------------------- manifest

/** Validates cipetpet-release.json and returns it. Anything unexpected is an integrity failure. */
function parseReleaseManifest(buf, where) {
  let m;
  try {
    m = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new CliError(`${where} is not valid JSON`, 3);
  }
  const bad = (msg) => {
    throw new CliError(`${where}: ${msg}`, 3);
  };
  if (!m || typeof m !== "object" || m.format !== 1) bad(`unsupported format ${JSON.stringify(m && m.format)} (this cipetpet understands 1; update cipetpet)`);
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(m.version)) bad("bad version");
  if (typeof m.ortVersion !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(m.ortVersion)) bad("bad ortVersion");
  if (!Array.isArray(m.assets) || m.assets.length === 0 || m.assets.length > MAX_ASSETS) bad("bad assets list");
  const seen = new Set();
  const perKind = { pack: 0, ort: 0, doc: 0 };
  for (const a of m.assets) {
    if (!a || typeof a !== "object") bad("bad asset entry");
    if (typeof a.name !== "string" || !NAME_RE.test(a.name) || a.name.startsWith(".")) bad(`unsafe asset name ${JSON.stringify(a.name)}`);
    if (a.name === MANIFEST_NAME) bad(`asset named ${MANIFEST_NAME}`);
    if (seen.has(a.name.toLowerCase())) bad(`duplicate asset ${a.name}`);
    seen.add(a.name.toLowerCase());
    if (a.kind !== "pack" && a.kind !== "ort" && a.kind !== "doc") bad(`${a.name}: unknown kind ${JSON.stringify(a.kind)}`);
    const limit = KIND_LIMITS[a.kind];
    if (++perKind[a.kind] > limit.count) bad(`more than ${limit.count} assets of kind ${a.kind}`);
    if (!Number.isSafeInteger(a.bytes) || a.bytes < 0 || a.bytes > limit.bytes) bad(`${a.name}: bad size`);
    if (typeof a.sha256 !== "string" || !SHA_RE.test(a.sha256)) bad(`${a.name}: bad sha256`);
    if (a.kind === "pack") {
      if (!a.name.endsWith(".cpet")) bad(`${a.name}: a pack must end in .cpet`);
      if (!PACK_NAME_RE.test(a.name)) bad(`${a.name}: unexpected pack name (lower-case letters, digits and "-", then .cpet)`);
      for (const k of ["model", "variant"]) if (typeof a[k] !== "string" || !NAME_RE.test(a[k])) bad(`${a.name}: bad ${k}`);
    } else if (a.kind === "ort") {
      if (!ORT_NAME_RE.test(a.name)) bad(`${a.name}: unexpected ONNX Runtime file name (only ort-wasm-simd-threaded[.asyncify].mjs|wasm)`);
      const want = a.name.includes(".asyncify.") ? "webgpu" : "wasm";
      if (a.backend !== want) bad(`${a.name}: backend must be ${want}`);
    } else if (!DOC_NAMES.has(a.name)) {
      bad(`${a.name}: unexpected document name (only LICENSE and NOTICE)`);
    }
  }
  return m;
}

/** Where an asset lives under --dir. */
const relPath = (a) => (a.kind === "ort" ? `ort/${a.name}` : a.name);
const packName = (a) => a.name.replace(/\.cpet$/, "");

// -------------------------------------------------------------------------------------------- arg parsing

const PULL_SPEC = {
  bool: ["ort", "no-ort", "webgpu", "no-docs", "ort-from-node-modules", "force", "dry-run", "list", "help"],
  value: ["dir", "tag", "repo", "packs", "models", "base-url", "manifest-sha256"],
};
const VERIFY_SPEC = { bool: ["strict", "help"], value: ["dir"] };

function parseFlags(argv, spec, command) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith("--")) throw new CliError(`unexpected argument "${a}" (see cipetpet ${command} --help)`, 1);
    let inline;
    const eq = a.indexOf("=");
    if (eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const key = a.slice(2);
    if (spec.bool.includes(key)) {
      if (inline !== undefined) throw new CliError(`--${key} does not take a value`, 1);
      out[key] = true;
    } else if (spec.value.includes(key)) {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("--"))) throw new CliError(`--${key} needs a value`, 1);
      out[key] = v;
    } else throw new CliError(`unknown option --${key} (see cipetpet ${command} --help)`, 1);
  }
  return out;
}

const PULL_HELP = `usage: cipetpet pull [options]

Downloads model packs and ONNX Runtime files of a GitHub Release, checks their SHA-256 against the release's
cipetpet-release.json and puts them into a folder you serve (default: public/cipetpet):

  <dir>/antalia-mini-int8.cpet, <dir>/duyu-small-int8.cpet   (the packs you asked for)
  <dir>/ort/ort-wasm-simd-threaded.{mjs,wasm}                 (ONNX Runtime; + .asyncify.* with --webgpu)
  <dir>/cipetpet-release.json, <dir>/LICENSE, <dir>/NOTICE

options:
  --dir DIR                 target folder (default public/cipetpet)
  --tag vX.Y.Z | latest     release (default: v<version of the installed cipetpet>, ${"v" + PKG.version} here)
  --repo owner/name         GitHub repository (default ${repoFromPackage() ?? "(none)"})
  --packs a,b | all         packs by name, e.g. antalia-mini-int8,duyu-small-q4 (default ${DEFAULT_PACKS.join(",")})
  --models antalia,duyu     the int8 pack of each model (can be combined with --packs)
  --no-ort                  do not fetch the ONNX Runtime files (--ort is the default)
  --webgpu                  also fetch the WebGPU (asyncify) ONNX Runtime files
  --no-docs                 do not fetch LICENSE and NOTICE
  --ort-from-node-modules   copy the ONNX Runtime files from the installed onnxruntime-web instead of downloading
  --force                   download again even when a file is present with the right hash, replace files that
                            were not put there by cipetpet pull, and accept a changed release of the same version
  --dry-run                 show what would happen, write nothing
  --list                    show the assets of the release and what is already in --dir, download nothing
  --base-url URL            folder URL that holds the release files (a mirror); disables the GitHub API
  --manifest-sha256 HEX     SHA-256 you expect for cipetpet-release.json (printed by release-assets); the release is
                            refused when it differs. Without it, the digest shipped in the npm package is used.

exit codes: 0 ok, 1 usage, 2 network or HTTP failure, 3 integrity failure`;

const VERIFY_HELP = `usage: cipetpet verify [--dir public/cipetpet] [--strict]

Hashes the files in --dir against <dir>/cipetpet-release.json. Files of the release that are not in --dir are
reported but are not an error (you may have pulled only some packs), unless --strict is given.
exit codes: 0 all present files match, 1 usage or no manifest, 3 a file is wrong (or missing with --strict)`;

function repoFromPackage() {
  const url = (PKG.repository && (PKG.repository.url || PKG.repository)) || "";
  const m = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_-][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/.exec(String(url));
  return m ? m[1] : undefined;
}

// ------------------------------------------------------------------------------------------------- pull

function ortSearchDirs() {
  const dirs = [];
  const climb = (from) => {
    for (let d = resolve(from); ; d = dirname(d)) {
      dirs.push(join(d, "node_modules", "onnxruntime-web"));
      if (dirname(d) === d) break;
    }
  };
  climb(process.cwd());
  climb(HERE);
  return [...new Set(dirs)];
}

/** Every onnxruntime-web visible from the current directory or from this script, nearest first. */
function listOrtPackages() {
  const out = [];
  for (const dir of ortSearchDirs()) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === "onnxruntime-web") out.push({ dir, version: String(pkg.version) });
    } catch {
      /* not there */
    }
  }
  return out;
}

/** The installed onnxruntime-web whose version is `want`; throws when there is none. */
function findOrtPackage(want) {
  const all = listOrtPackages();
  for (const p of all) if (p.version === want && existsSync(join(p.dir, "dist"))) return p.dir;
  if (all.length === 0) {
    throw new CliError(`--ort-from-node-modules: no onnxruntime-web in a node_modules folder above ${process.cwd()}; install it (npm install onnxruntime-web@${want}) or drop the flag`, 1);
  }
  throw new CliError(
    `--ort-from-node-modules: this release needs onnxruntime-web ${want}, found ${all.map((p) => `${p.version} (${p.dir})`).join(", ")}; install onnxruntime-web@${want} or drop the flag to download the files`,
    3,
  );
}

/** Is `name` installed in a node_modules folder above the current directory? */
function installedAbove(name) {
  for (let d = process.cwd(); ; d = dirname(d)) {
    if (existsSync(join(d, "node_modules", name, "package.json"))) return true;
    if (dirname(d) === d) return false;
  }
}

/** The manifest of an earlier pull in `dir`, or undefined (missing, unreadable or invalid). */
async function readLocalManifest(dir) {
  const path = join(dir, MANIFEST_NAME);
  try {
    if ((await stat(path)).size > MANIFEST_MAX_BYTES) return undefined;
    return parseReleaseManifest(await readFile(path), path);
  } catch {
    return undefined;
  }
}

/**
 * The file hashes come from the same place as the files, so something outside the download has to vouch for the
 * manifest: --manifest-sha256, or the digest that `release-assets --digest` put into the npm package at publish time.
 */
function checkManifestAnchor(flags, buf, manifest) {
  const got = createHash("sha256").update(buf).digest("hex");
  if (flags["manifest-sha256"] !== undefined) {
    const want = flags["manifest-sha256"].toLowerCase();
    if (got !== want) throw new CliError(`${MANIFEST_NAME} has SHA-256 ${got}, but --manifest-sha256 says ${want}`, 3);
    console.log(`manifest    ${MANIFEST_NAME} matches --manifest-sha256`);
    return;
  }
  const file = join(HERE, DIGEST_NAME);
  if (!existsSync(file)) return;
  let d;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CliError(`${file} is not valid JSON; reinstall cipetpet`, 3);
  }
  if (!d || d.format !== 1 || typeof d.version !== "string" || typeof d.manifestSha256 !== "string" || !SHA_RE.test(d.manifestSha256)) {
    throw new CliError(`${file} is not a release digest; reinstall cipetpet`, 3);
  }
  if (d.version !== manifest.version) {
    console.log(`note        release ${manifest.version} is not the version of this cipetpet package (${d.version}): its manifest cannot be checked against the package's digest`);
    return;
  }
  if (got !== d.manifestSha256) {
    throw new CliError(
      `${MANIFEST_NAME} of release ${manifest.version} has SHA-256 ${got}, but the cipetpet package you installed expects ${d.manifestSha256}. ` +
        `The release was changed after the package was published, or the server is not serving the real release. Nothing was written.`,
      3,
    );
  }
  console.log(`manifest    ${MANIFEST_NAME} matches the digest of the installed cipetpet ${d.version}`);
}

/** A published release must not change: the same version with other hashes than the earlier pull is refused. */
function checkNotChanged(local, manifest) {
  if (!local || local.version !== manifest.version) return;
  const before = new Map(local.assets.map((a) => [relPath(a), a.sha256]));
  for (const a of manifest.assets) {
    const was = before.get(relPath(a));
    if (was !== undefined && was !== a.sha256) {
      throw new CliError(
        `release ${manifest.version} has changed since you pulled it: ${relPath(a)} was ${was}, is now ${a.sha256}. ` +
          `A published release should never change. If you trust the new files, run pull again with --force. Nothing was written.`,
        3,
      );
    }
  }
}

async function loadManifest({ base, dir, tag, offlineOk }) {
  const url = new URL(MANIFEST_NAME, base).href;
  try {
    const buf = await fetchText(url, MANIFEST_MAX_BYTES, { what: `release manifest` });
    return { buf, manifest: parseReleaseManifest(buf, url), offline: false };
  } catch (e) {
    if (!(e instanceof CliError) || !e.network) throw e;
    // no network: a manifest from an earlier pull still tells which hashes the local files must have
    const local = join(dir, MANIFEST_NAME);
    if (offlineOk && existsSync(local)) {
      const buf = await readFile(local);
      const manifest = parseReleaseManifest(buf, local);
      const wanted = /^v(\d+\.\d+\.\d+.*)$/.exec(tag);
      if (!wanted || wanted[1] === manifest.version) {
        console.log(`offline (${e.message}); using ${local} (release ${manifest.version})`);
        return { buf, manifest, offline: true };
      }
    }
    throw new CliError(`${e.message}\n${OFFLINE_HINT}`, 2);
  }
}

/** Says which releases exist, when the API answers. */
async function describeMissingRelease(repo, tag, api, token) {
  let known = "";
  try {
    const buf = await fetchText(new URL(`repos/${repo}/releases?per_page=10`, api).href, API_MAX_BYTES, {
      token,
      tokenOrigin: api.origin,
      headers: { accept: "application/vnd.github+json" },
      connectMs: API_MS,
      idleMs: API_MS,
    });
    const tags = JSON.parse(buf.toString("utf8")).map((r) => r && r.tag_name).filter((t) => typeof t === "string" && NAME_RE.test(t));
    known = tags.length ? ` Existing releases: ${tags.join(", ")}.` : " The repository has no releases yet.";
  } catch {
    known = " (the GitHub API did not answer, so the existing releases are unknown)";
  }
  return new CliError(
    `release ${tag} of ${repo} not found.${known} Use --tag to pick one, or --tag latest.`,
    2,
    { notFound: true },
  );
}

async function resolveLatest(repo, api, token) {
  const url = new URL(`repos/${repo}/releases/latest`, api).href;
  try {
    const buf = await fetchText(url, API_MAX_BYTES, {
      token,
      tokenOrigin: api.origin,
      headers: { accept: "application/vnd.github+json" },
      connectMs: API_MS,
      idleMs: API_MS,
      what: "GitHub API",
    });
    const tag = JSON.parse(buf.toString("utf8")).tag_name;
    if (typeof tag !== "string" || !NAME_RE.test(tag)) throw new CliError("the GitHub API returned no usable tag_name", 2);
    return tag;
  } catch (e) {
    if (e instanceof CliError && e.notFound) throw new CliError(`${repo} has no published release yet (GitHub API answered 404 for releases/latest)`, 2, { notFound: true });
    throw e;
  }
}

/** Creates the folder of `dest` and makes sure it really is inside `dir` (a symlinked subfolder must not lead out). */
async function prepareFolder(dir, dest) {
  await mkdir(dirname(dest), { recursive: true });
  const [realDir, realTarget] = await Promise.all([realpath(dir), realpath(dirname(dest))]);
  if (realTarget !== realDir && !within(realDir, realTarget)) {
    throw new CliError(`refusing to write ${dest}: its folder resolves to ${realTarget}, outside ${realDir}`, 1);
  }
}

/** Streams `url` to `dest`, checking size and SHA-256 before the final rename. */
async function downloadAsset(url, dest, asset, ctx) {
  const part = join(dirname(dest), `.${asset.name}.part`);
  if (!within(ctx.dir, part) || !within(ctx.dir, dest)) throw new CliError(`refusing to write outside ${ctx.dir}`, 1);
  await prepareFolder(ctx.dir, dest);
  await rm(part, { force: true });
  ctx.parts.add(part);
  const conn = await openUrl(url);
  let fh;
  try {
    if (conn.res.status !== 200) {
      await conn.res.body?.cancel().catch(() => {});
      throw statusError(conn, `${asset.name}`);
    }
    const declared = conn.res.headers.get("content-length");
    if (declared !== null && Number(declared) > asset.bytes) {
      throw new CliError(`${asset.name}: the server announces ${declared} bytes, the manifest says ${asset.bytes}`, 3);
    }
    fh = await open(part, "wx", 0o644);
    const hash = createHash("sha256");
    let got = 0;
    let last = 0;
    const tty = process.stderr.isTTY;
    for await (const chunk of readChunks(conn)) {
      got += chunk.byteLength;
      if (got > asset.bytes) throw new CliError(`${asset.name}: received more than the ${asset.bytes} bytes the manifest lists`, 3);
      hash.update(chunk);
      await fh.write(chunk);
      const now = Date.now();
      if (tty && now - last > 150) {
        last = now;
        process.stderr.write(`\r  ${asset.name}  ${sizeText(got)} / ${sizeText(asset.bytes)}  ${Math.floor((got / Math.max(1, asset.bytes)) * 100)}%   `);
      }
    }
    await fh.close();
    fh = undefined;
    if (tty) process.stderr.write("\r\x1b[K");
    if (got !== asset.bytes) throw new CliError(`${asset.name}: got ${got} bytes, the manifest says ${asset.bytes}`, 3);
    const digest = hash.digest("hex");
    if (digest !== asset.sha256) throw new CliError(`${asset.name}: SHA-256 mismatch (got ${digest}, manifest ${asset.sha256})`, 3);
    await rename(part, dest);
    ctx.parts.delete(part);
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await rm(part, { force: true }).catch(() => {});
    ctx.parts.delete(part);
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
    throw e;
  } finally {
    conn.stop();
  }
}

/** Copies a file from the installed onnxruntime-web after checking it against the manifest. */
async function copyAsset(src, dest, asset, ctx) {
  const part = join(dirname(dest), `.${asset.name}.part`);
  if (!within(ctx.dir, part) || !within(ctx.dir, dest)) throw new CliError(`refusing to write outside ${ctx.dir}`, 1);
  let data;
  try {
    data = await readFile(src);
  } catch (e) {
    throw new CliError(`cannot read ${src}: ${e.message}`, 1);
  }
  const digest = createHash("sha256").update(data).digest("hex");
  if (data.byteLength !== asset.bytes || digest !== asset.sha256) {
    throw new CliError(`${src} does not match the release's ${asset.name} (${data.byteLength} bytes, sha256 ${digest}; manifest: ${asset.bytes} bytes, ${asset.sha256})`, 3);
  }
  await prepareFolder(ctx.dir, dest);
  await rm(part, { force: true });
  ctx.parts.add(part);
  try {
    const fh = await open(part, "wx", 0o644);
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    await rename(part, dest);
  } finally {
    await rm(part, { force: true }).catch(() => {});
    ctx.parts.delete(part);
  }
}

function selectPacks(flags, manifest) {
  const packs = manifest.assets.filter((a) => a.kind === "pack");
  const byName = new Map(packs.map((a) => [packName(a), a]));
  const chosen = new Set();
  const explicit = flags.packs !== undefined || flags.models !== undefined;
  if (flags.packs !== undefined) {
    for (const raw of flags.packs.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (raw === "all") {
        for (const n of byName.keys()) chosen.add(n);
        continue;
      }
      const n = raw.replace(/\.cpet$/, "");
      if (!byName.has(n)) throw new CliError(`pack "${raw}" is not in this release (available: ${[...byName.keys()].join(", ")})`, 1);
      chosen.add(n);
    }
  }
  if (flags.models !== undefined) {
    for (const raw of flags.models.split(",").map((s) => s.trim()).filter(Boolean)) {
      const id = MODEL_ALIASES[raw];
      if (!id) throw new CliError(`unknown model "${raw}" (use antalia and/or duyu)`, 1);
      const n = `${id}-int8`;
      if (!byName.has(n)) throw new CliError(`this release has no ${n} pack (available: ${[...byName.keys()].join(", ")})`, 1);
      chosen.add(n);
    }
  }
  if (!explicit) {
    for (const n of DEFAULT_PACKS) {
      if (!byName.has(n)) throw new CliError(`the default pack ${n} is not in this release (available: ${[...byName.keys()].join(", ")}); choose with --packs`, 1);
      chosen.add(n);
    }
  }
  if (chosen.size === 0) throw new CliError("no packs selected (--packs/--models were empty)", 1);
  return [...chosen].sort().map((n) => byName.get(n));
}

function urlPrefixFor(dir) {
  const rel = relative(process.cwd(), dir).split(sep);
  const i = rel.lastIndexOf("public");
  if (i < 0 || rel.includes("..")) return undefined;
  const rest = rel.slice(i + 1);
  return `/${rest.length ? `${rest.join("/")}/` : ""}`;
}

function printSnippet(dir, packs, { withOrt, webgpu, ortVersion }) {
  const prefix = urlPrefixFor(dir);
  const p = prefix ?? "/cipetpet/";
  console.log("\nUse it from your code:\n");
  // wasmPaths: the pulled ORT folder, or (--no-ort) the ORT folder you serve yourself; the CDN default only exists
  // in the browser bundle, so a bundler app must always say where ORT's files are
  const wasmPaths = withOrt ? `${p}ort/` : `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVersion}/dist/`;
  const optList = [...(webgpu && withOrt ? ['backend: "webgpu"'] : []), `wasmPaths: "${wasmPaths}"`];
  const opts = `{ ${optList.join(", ")} }`;
  // one example per model: two variants of the same model (--packs all) would declare the same constant twice
  const shown = new Map();
  for (const a of packs) {
    if (!MODEL_CLASSES[a.model]) continue;
    const cur = shown.get(a.model);
    if (!cur || (DEFAULT_PACKS.includes(a.name) && !DEFAULT_PACKS.includes(cur.name))) shown.set(a.model, a);
  }
  const examples = [...shown.values()];
  const classes = [...new Set(examples.map((a) => MODEL_CLASSES[a.model][0]))];
  if (classes.length) console.log(`  import { ${classes.join(", ")} } from "cipetpet";`);
  for (const a of examples) {
    const c = MODEL_CLASSES[a.model];
    console.log(`  const ${c[1]} = await ${c[0]}.load("${p}${a.name}", ${opts});`);
  }
  if (examples.length < packs.filter((a) => MODEL_CLASSES[a.model]).length) {
    console.log("\nThe other variants you pulled load the same way: use their file name instead.");
  }
  if (!withOrt) {
    console.log(`\nNo ONNX Runtime files were pulled: wasmPaths above points to the matching onnxruntime-web ${ortVersion} on jsDelivr; use the URL of your own copy of its dist/ folder if you have one.`);
  }
  if (webgpu && withOrt) console.log('\nbackend: "webgpu" falls back to the wasm files when the browser has no WebGPU.');
  if (installedAbove("cipetpet-react")) {
    console.log("\nWith cipetpet-react, wasmPaths goes into the model options of the provider:\n");
    const entries = examples
      .map((a) => {
        const kind = MODEL_CLASSES[a.model][1];
        const extra = kind === "stt" ? ", useWorker: true" : "";
        return `${kind}={{ source: "${p}${a.name}", ${optList.join(", ")}${extra} }}`;
      });
    console.log(`  <CipetpetProvider ${entries.join(" ")}>`);
  }
  if (prefix === undefined) {
    console.log(`\n${dir} is not inside a "public" folder: serve it from your web server and replace "${p}" above with its URL prefix.`);
  }
  console.log("Multi-threading needs COOP/COEP headers on your page, see RELEASES.md in the cipetpet package.");
}

async function cmdPull(argv) {
  const flags = parseFlags(argv, PULL_SPEC, "pull");
  if (flags.help) return console.log(PULL_HELP);
  if (flags.ort && flags["no-ort"]) throw new CliError("--ort and --no-ort exclude each other", 1);
  if (flags["list"] && flags["dry-run"]) throw new CliError("--list and --dry-run exclude each other", 1);
  if (flags["ort-from-node-modules"] && flags["no-ort"]) throw new CliError("--ort-from-node-modules needs the ONNX Runtime files (drop --no-ort)", 1);

  if (flags["manifest-sha256"] !== undefined && !SHA_RE.test(flags["manifest-sha256"].toLowerCase())) {
    throw new CliError("--manifest-sha256 needs 64 hex digits", 1);
  }
  const dir = resolve(process.cwd(), flags.dir ?? "public/cipetpet");
  if (dir === dirname(dir) || dir === resolve(homedir())) throw new CliError(`refusing to use ${dir} as the target folder`, 1);
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new CliError(`${dir} exists and is not a directory`, 1);

  const repo = flags.repo ?? repoFromPackage();
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new CliError(`bad or missing --repo (expected owner/name, got ${JSON.stringify(repo)})`, 1);
  let tag = flags.tag ?? `v${PKG.version}`;
  if (!NAME_RE.test(tag)) throw new CliError(`bad --tag ${JSON.stringify(tag)}`, 1);

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
  const api = apiBase();
  let base;
  let useApi = true;
  if (flags["base-url"]) {
    try {
      base = new URL(flags["base-url"].endsWith("/") ? flags["base-url"] : `${flags["base-url"]}/`);
    } catch {
      throw new CliError(`bad --base-url ${JSON.stringify(flags["base-url"])}`, 1);
    }
    checkUrl(base);
    useApi = false;
    if (tag === "latest") throw new CliError("--tag latest needs the GitHub API, which --base-url disables; give the tag explicitly", 1);
  }

  if (tag === "latest") {
    try {
      tag = await resolveLatest(repo, api, token);
    } catch (e) {
      if (!(e instanceof CliError && e.network && existsSync(join(dir, MANIFEST_NAME)))) throw e;
      tag = `v${parseReleaseManifest(await readFile(join(dir, MANIFEST_NAME)), "local manifest").version}`;
      console.log(`offline; "latest" taken from the local ${MANIFEST_NAME}: ${tag}`);
    }
    console.log(`latest release of ${repo}: ${tag}`);
  }
  if (!base) base = githubBase(repo, tag);

  let loaded;
  try {
    loaded = await loadManifest({ base, dir, tag, offlineOk: !flags.force });
  } catch (e) {
    if (e instanceof CliError && e.notFound && useApi) throw await describeMissingRelease(repo, tag, api, token);
    throw e;
  }
  const { buf: manifestBytes, manifest, offline } = loaded;
  const tagVersion = /^v(\d+\.\d+\.\d+.*)$/.exec(tag)?.[1];
  if (tagVersion && tagVersion !== manifest.version) {
    throw new CliError(`the manifest at ${base.href} is for cipetpet ${manifest.version}, not ${tagVersion} (${tag})`, 3);
  }

  checkManifestAnchor(flags, manifestBytes, manifest);
  const local = await readLocalManifest(dir);
  if (!flags.force) checkNotChanged(local, manifest);

  const packs = selectPacks(flags, manifest);
  const wantOrt = !flags["no-ort"];
  const ort = wantOrt ? manifest.assets.filter((a) => a.kind === "ort" && (a.backend !== "webgpu" || flags.webgpu)) : [];
  if (flags.webgpu && wantOrt && !manifest.assets.some((a) => a.kind === "ort" && a.backend === "webgpu")) {
    throw new CliError("--webgpu: this release has no WebGPU ONNX Runtime files", 1);
  }
  if (wantOrt && ort.length === 0) throw new CliError("this release lists no ONNX Runtime files (use --no-ort)", 1);
  const docs = flags["no-docs"] ? [] : manifest.assets.filter((a) => a.kind === "doc");
  const plan = [...packs, ...ort, ...docs].map((asset) => ({ asset, dest: join(dir, relPath(asset)), rel: relPath(asset) }));
  for (const p of plan) if (!within(dir, p.dest)) throw new CliError(`refusing to write outside ${dir}`, 1);

  console.log(`cipetpet ${manifest.version} (onnxruntime-web ${manifest.ortVersion}) from ${flags["base-url"] ? base.href : `github.com/${repo} ${tag}`}`);

  if (ort.length && !flags["ort-from-node-modules"]) {
    // the JS glue and the wasm of ORT have to be the same version as the ORT code in your bundle
    const installed = listOrtPackages()[0];
    if (installed && installed.version !== manifest.ortVersion) {
      console.error(
        `warning: this release ships the files of onnxruntime-web ${manifest.ortVersion}, but the onnxruntime-web installed here is ${installed.version} (${installed.dir}). ` +
          `ORT's .mjs/.wasm files must come from the same version as the ORT code your app uses, otherwise loading them fails at runtime. ` +
          `Install onnxruntime-web@${manifest.ortVersion} (the version cipetpet ${manifest.version} was built with), or use --ort-from-node-modules with a release that matches ${installed.version}.`,
      );
    }
  }

  if (flags.list) {
    const w = Math.max(...manifest.assets.map((a) => relPath(a).length));
    console.log(`\n${"file".padEnd(w)}  ${"kind".padEnd(4)}  ${"size".padStart(10)}  in ${dir}`);
    for (const a of [...manifest.assets].sort((x, y) => (relPath(x) < relPath(y) ? -1 : 1))) {
      const have = await hashIfFile(join(dir, relPath(a)));
      const state = !have ? "-" : have.sha256 === a.sha256 && have.bytes === a.bytes ? "ok" : "DIFFERENT";
      const def = a.kind === "pack" && DEFAULT_PACKS.includes(packName(a)) ? "  (default)" : "";
      console.log(`${relPath(a).padEnd(w)}  ${a.kind.padEnd(4)}  ${sizeText(a.bytes).padStart(10)}  ${state}${def}`);
    }
    return;
  }

  // What is in --dir now. A file that is there with other content is replaced only when an earlier pull put it
  // there (it is listed in the local manifest): a manifest must not be able to overwrite the project's own files.
  const ours = new Set((local?.assets ?? []).map(relPath));
  const foreign = [];
  for (const item of plan) {
    let st;
    try {
      st = await stat(item.dest);
    } catch {
      st = undefined;
    }
    if (st && !st.isFile()) throw new CliError(`${item.dest} exists and is not a file`, 1);
    item.have = st ? await hashIfFile(item.dest) : undefined;
    const same = item.have && item.have.bytes === item.asset.bytes && item.have.sha256 === item.asset.sha256;
    item.foreign = !!item.have && !same && !ours.has(item.rel) && !flags.force;
    if (item.foreign && item.asset.kind === "doc") item.skip = true;
    else if (item.foreign) foreign.push(item.rel);
  }
  if (foreign.length) {
    throw new CliError(
      `${foreign.join(", ")} already exist${foreign.length === 1 ? "s" : ""} in ${dir} with other content and ${foreign.length === 1 ? "was" : "were"} not put there by cipetpet pull ` +
        `(not listed in ${join(dir, MANIFEST_NAME)}). Nothing was written. Use another --dir, move the file away, or pass --force to replace it.`,
      1,
    );
  }

  const ctx = { dir, parts: new Set() };
  const onSignal = (sig) => () => {
    for (const p of ctx.parts) rmSync(p, { force: true });
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal("SIGINT"));
  process.once("SIGTERM", onSignal("SIGTERM"));

  let ortDist;
  if (flags["ort-from-node-modules"] && ort.length) ortDist = join(findOrtPackage(manifest.ortVersion), "dist");

  // leftovers of a killed earlier run would otherwise be served (and copied into dist/) next to the real files
  if (!flags["dry-run"]) {
    const stale = new Set([join(dir, `.${MANIFEST_NAME}.part`), ...plan.map((i) => join(dirname(i.dest), `.${i.asset.name}.part`))]);
    for (const f of stale) {
      try {
        if ((await lstat(f)).isFile()) await rm(f, { force: true });
      } catch {
        /* not there */
      }
    }
  }

  let downloaded = 0;
  let kept = 0;
  let totalBytes = 0;
  const t0 = Date.now();
  const missingOffline = [];
  for (const { asset, dest, rel, have: present, skip } of plan) {
    if (skip) {
      console.log(`${flags["dry-run"] ? "would skip" : "skipped"}     ${rel}  (a different ${rel} is already there and was not put there by cipetpet pull; --force replaces it)`);
      continue;
    }
    const have = flags.force ? undefined : present;
    if (have && have.bytes === asset.bytes && have.sha256 === asset.sha256) {
      kept++;
      console.log(`ok          ${rel}  (already there, ${sizeText(asset.bytes)})`);
      continue;
    }
    const fromModules = ortDist && asset.kind === "ort";
    const verb = fromModules ? "copy" : "download";
    const why = present ? " (replaces a file with a different hash)" : "";
    if (flags["dry-run"]) {
      console.log(`would ${verb}  ${rel}  ${sizeText(asset.bytes)}${why}`);
      continue;
    }
    if (offline && !fromModules) {
      missingOffline.push(rel);
      continue;
    }
    const started = Date.now();
    if (fromModules) {
      await copyAsset(join(ortDist, asset.name), dest, asset, ctx);
      console.log(`copied      ${rel}  ${sizeText(asset.bytes)} from ${ortDist}${why}`);
    } else {
      process.stderr.write(`  ${rel}: downloading ${sizeText(asset.bytes)} ...\n`);
      await downloadAsset(new URL(encodeURIComponent(asset.name), base).href, dest, asset, ctx);
      const secs = (Date.now() - started) / 1000;
      console.log(`downloaded  ${rel}  ${sizeText(asset.bytes)} in ${secs.toFixed(1)} s${why}`);
    }
    downloaded++;
    totalBytes += asset.bytes;
  }
  if (missingOffline.length) {
    throw new CliError(`offline and missing or changed: ${missingOffline.join(", ")}\n${OFFLINE_HINT}`, 2);
  }
  if (flags["dry-run"]) {
    console.log("\ndry run: nothing was written.");
    return;
  }

  // the manifest goes in last, so that its presence means "pulled completely"
  const manifestDest = join(dir, MANIFEST_NAME);
  const existing = await hashIfFile(manifestDest);
  const newSha = createHash("sha256").update(manifestBytes).digest("hex");
  if (!existing || existing.sha256 !== newSha) {
    const part = join(dir, `.${MANIFEST_NAME}.part`);
    await mkdir(dir, { recursive: true });
    await rm(part, { force: true });
    const fh = await open(part, "wx", 0o644);
    try {
      await fh.writeFile(manifestBytes);
    } finally {
      await fh.close();
    }
    await rename(part, manifestDest);
  }

  console.log(
    `\n${downloaded} file(s) written (${sizeText(totalBytes)}), ${kept} already up to date, in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${dir}`,
  );
  printSnippet(dir, packs, { withOrt: ort.length > 0, webgpu: !!flags.webgpu, ortVersion: manifest.ortVersion });
  console.log(`\nCheck them later with: cipetpet verify --dir ${relative(process.cwd(), dir) || "."}`);
}

// ----------------------------------------------------------------------------------------------- verify

async function cmdVerify(argv) {
  const flags = parseFlags(argv, VERIFY_SPEC, "verify");
  if (flags.help) return console.log(VERIFY_HELP);
  const dir = resolve(process.cwd(), flags.dir ?? "public/cipetpet");
  const manifestPath = join(dir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) throw new CliError(`${manifestPath} not found; run "cipetpet pull --dir ${flags.dir ?? "public/cipetpet"}" first`, 1);
  const st = statSync(manifestPath);
  if (st.size > MANIFEST_MAX_BYTES) throw new CliError(`${manifestPath} is larger than ${MANIFEST_MAX_BYTES} bytes`, 3);
  const manifest = parseReleaseManifest(await readFile(manifestPath), manifestPath);

  let ok = 0;
  let bad = 0;
  let missing = 0;
  for (const a of [...manifest.assets].sort((x, y) => (relPath(x) < relPath(y) ? -1 : 1))) {
    const path = join(dir, relPath(a));
    if (!within(dir, path)) throw new CliError(`refusing to read outside ${dir}`, 1);
    const have = await hashIfFile(path);
    if (!have) {
      missing++;
      console.log(`--          ${relPath(a)}  (not in this folder)`);
    } else if (have.bytes !== a.bytes) {
      bad++;
      console.log(`FAILED      ${relPath(a)}  size ${have.bytes}, expected ${a.bytes}`);
    } else if (have.sha256 !== a.sha256) {
      bad++;
      console.log(`FAILED      ${relPath(a)}  sha256 ${have.sha256}, expected ${a.sha256}`);
    } else {
      ok++;
      console.log(`ok          ${relPath(a)}`);
    }
  }
  const leftovers = [dir, join(dir, "ort")].flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.startsWith(".") && f.endsWith(".part")).map((f) => join(d, f)) : []));
  for (const l of leftovers) console.log(`note        ${l} is an unfinished download; delete it`);
  console.log(`\nrelease ${manifest.version}: ${ok} ok, ${bad} wrong, ${missing} not present`);
  if (bad) throw new CliError(`${bad} file(s) do not match ${MANIFEST_NAME}; run "cipetpet pull --force" to fetch them again`, 3);
  if (ok === 0) throw new CliError("none of the release's files is in this folder; nothing was verified", 3);
  if (flags.strict && missing) throw new CliError(`${missing} file(s) of the release are missing (--strict)`, 3);
}

// -------------------------------------------------------------------------------------------------- main

const HELP = `cipetpet ${PKG.version}

usage:
  cipetpet pull   [options]   download model packs and ONNX Runtime files from a GitHub Release  (--help for options)
  cipetpet verify [options]   check the downloaded files against cipetpet-release.json
  cipetpet --version`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return cmd === undefined ? 1 : 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(PKG.version);
    return 0;
  }
  if (cmd === "pull") await cmdPull(rest);
  else if (cmd === "verify") await cmdVerify(rest);
  else throw new CliError(`unknown command "${cmd}" (try: cipetpet pull, cipetpet verify)`, 1);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof CliError) {
      console.error(`cipetpet: ${e.message}`);
      process.exitCode = e.code;
    } else {
      console.error(`cipetpet: unexpected error: ${e && e.stack ? e.stack : e}`);
      process.exitCode = 1;
    }
  },
);
