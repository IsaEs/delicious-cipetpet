// Downloads the upstream model files that tools/build-packs.ts needs, from the pinned Hugging Face commits
// listed in tools/upstream.lock.json, and verifies every file's SHA-256 (and size) against the lock.
//
//   npx tsx tools/fetch-upstream.ts [--out .upstream] [--lock tools/upstream.lock.json] [--only antalia-mini]
//                                   [--verify-only] [--base-url URL]
//
// The result has the layout build-packs.ts reads by default: <out>/antalia-mini/{assets,models}/... and
// <out>/duyu-small/{*.json,*.npz,spm.model,int8/,q4/}. Files already in <out> with the right hash are kept
// (no download); a file with a wrong hash is replaced. A file whose download does not match the lock is
// never left behind: it is written to a ".part" file and only renamed into place after the check.
// Exit codes: 0 ok, 1 usage / bad lock, 2 network failure, 3 hash or size mismatch.
//
// --verify-only hashes what is in <out> and downloads nothing. --base-url (tests, mirrors) fetches
// <base-url>/<repo id>/<path> instead of the Hugging Face resolve URLs; http is allowed for loopback only.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface LockFile {
  path: string;
  bytes: number;
  sha256: string;
  /** stored with Git LFS on Hugging Face (its LFS oid is the sha256) */
  lfs: boolean;
  /** Git blob id, for files that are not LFS */
  gitBlob?: string;
}
export interface LockRepo {
  /** local folder name under --out, also what build-packs.ts expects ("antalia-mini", "duyu-small") */
  id: string;
  /** "space" repos live under /spaces/ on Hugging Face */
  kind: "space" | "model";
  repo: string;
  commit: string;
  files: LockFile[];
}
export interface Lock {
  format: 1;
  repos: LockRepo[];
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly code: 1 | 2 | 3,
  ) {
    super(message);
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** Checks the structure of a lock and the safety of its paths (they become file names under --out). */
export function parseLock(text: string): Lock {
  let lock: Lock;
  try {
    lock = JSON.parse(text) as Lock;
  } catch (e) {
    throw new FetchError(`upstream lock is not valid JSON: ${(e as Error).message}`, 1);
  }
  const bad = (m: string): never => {
    throw new FetchError(`upstream lock: ${m}`, 1);
  };
  if (!lock || lock.format !== 1 || !Array.isArray(lock.repos) || lock.repos.length === 0) bad("expected {format: 1, repos: [...]}");
  const ids = new Set<string>();
  for (const r of lock.repos) {
    if (!r || !/^[a-z0-9][a-z0-9-]*$/.test(String(r.id))) bad(`bad repo id ${JSON.stringify(r?.id)}`);
    if (ids.has(r.id)) bad(`duplicate repo id ${r.id}`);
    ids.add(r.id);
    if (r.kind !== "space" && r.kind !== "model") bad(`${r.id}: kind must be "space" or "model"`);
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(r.repo))) bad(`${r.id}: bad repo ${JSON.stringify(r.repo)}`);
    if (!COMMIT.test(String(r.commit))) bad(`${r.id}: commit must be a full 40-character sha`);
    if (!Array.isArray(r.files) || r.files.length === 0) bad(`${r.id}: no files`);
    const seen = new Set<string>();
    for (const f of r.files) {
      const p = String(f?.path);
      const parts = p.split("/");
      if (!p || p.startsWith("/") || p.includes("\\") || parts.some((s) => s === "" || s === "." || s === ".." || !/^[A-Za-z0-9._-]+$/.test(s))) {
        bad(`${r.id}: unsafe path ${JSON.stringify(f?.path)}`);
      }
      if (seen.has(p)) bad(`${r.id}: duplicate path ${p}`);
      seen.add(p);
      if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) bad(`${r.id}/${p}: bad bytes`);
      if (!SHA256.test(String(f.sha256))) bad(`${r.id}/${p}: bad sha256`);
    }
  }
  return lock;
}

/** The pinned download URL of one file. */
export function resolveUrl(repo: LockRepo, file: LockFile): string {
  const prefix = repo.kind === "space" ? "spaces/" : "";
  const path = file.path.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${prefix}${repo.repo}/resolve/${repo.commit}/${path}`;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function checkUrl(u: URL, allowHttp = true): void {
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && isLoopback(u.hostname)) {
    if (allowHttp) return;
    throw new FetchError(`refusing to follow a redirect from https to ${u.protocol}//${u.host}`, 2);
  }
  throw new FetchError(`refusing to download from ${u.protocol}//${u.host} (https only)`, 2);
}

/** GET that checks every hop of a redirect chain before requesting it (https only; a chain that started on https
 * never drops to http://localhost). */
async function getFollowing(url: string, signal: AbortSignal): Promise<Response> {
  let cur = new URL(url);
  const startedOnHttp = cur.protocol === "http:";
  for (let hops = 0; ; hops++) {
    checkUrl(cur, startedOnHttp);
    const res = await fetch(cur, { signal, redirect: "manual", headers: { "user-agent": "cipetpet-fetch-upstream" } });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => {});
      if (hops >= 10) throw new FetchError(`too many redirects starting at ${url}`, 2);
      cur = new URL(loc, cur);
      continue;
    }
    return res;
  }
}

function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    let bytes = 0;
    createReadStream(path)
      .on("data", (c) => {
        h.update(c);
        bytes += (c as Buffer).length;
      })
      .on("error", rej)
      .on("end", () => res({ sha256: h.digest("hex"), bytes }));
  });
}

export interface FetchOptions {
  lock: Lock;
  out: string;
  only?: string[];
  /** hash what is in `out` only */
  verifyOnly?: boolean;
  baseUrl?: string;
  /** attempts per file for network errors and 5xx answers */
  attempts?: number;
  log?: (line: string) => void;
}

export interface FetchSummary {
  files: number;
  bytes: number;
  downloaded: number;
  reused: number;
}

async function download(url: string, dest: string, file: LockFile, label: string): Promise<void> {
  const part = `${dest}.part`;
  rmSync(part, { force: true });
  const ctl = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const arm = (ms: number) => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(new Error(`no data for ${ms / 1000} s`)), ms);
  };
  try {
    arm(60_000);
    const res = await getFollowing(url, ctl.signal);
    if (res.status === 404) throw new FetchError(`${label}: HTTP 404 for ${url} (is the pinned commit still there?)`, 2);
    if (res.status !== 200) throw new FetchError(`${label}: HTTP ${res.status} for ${url}`, 2);
    const declared = res.headers.get("content-length");
    if (declared !== null && Number(declared) > file.bytes) {
      await res.body?.cancel();
      throw new FetchError(`${label}: the server announces ${declared} bytes, the lock says ${file.bytes}`, 3);
    }
    if (!res.body) throw new FetchError(`${label}: empty response`, 2);
    const hash = createHash("sha256");
    let got = 0;
    const out = createWriteStream(part, { flags: "wx" });
    const closed = new Promise<void>((ok, fail) => {
      out.on("error", fail);
      out.on("close", ok);
    });
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        arm(60_000);
        got += chunk.byteLength;
        if (got > file.bytes) throw new FetchError(`${label}: more than the ${file.bytes} bytes the lock lists`, 3);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
    } finally {
      out.end();
      await closed.catch(() => {});
    }
    if (got !== file.bytes) throw new FetchError(`${label}: got ${got} bytes, the lock says ${file.bytes}`, 3);
    const digest = hash.digest("hex");
    if (digest !== file.sha256) {
      throw new FetchError(`${label}: SHA-256 mismatch (got ${digest}, the lock says ${file.sha256})`, 3);
    }
    renameSync(part, dest);
  } catch (e) {
    rmSync(part, { force: true });
    if (e instanceof FetchError) throw e;
    const cause = e instanceof Error ? (ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e) : e;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const inner = cause instanceof Error && (cause as { cause?: Error }).cause?.message;
    throw new FetchError(`${label}: download failed: ${detail}${inner ? ` (${inner})` : ""}`, 2);
  } finally {
    clearTimeout(idle);
  }
}

/** Downloads (or only verifies) the files of the lock. Throws FetchError. */
export async function fetchUpstream(opts: FetchOptions): Promise<FetchSummary> {
  const log = opts.log ?? (() => {});
  const out = resolve(opts.out);
  const attempts = Math.max(1, opts.attempts ?? 3);
  const repos = opts.lock.repos.filter((r) => !opts.only || opts.only.includes(r.id));
  if (opts.only) {
    const unknown = opts.only.filter((id) => !opts.lock.repos.some((r) => r.id === id));
    if (unknown.length) throw new FetchError(`unknown repo id(s): ${unknown.join(", ")} (lock has ${opts.lock.repos.map((r) => r.id).join(", ")})`, 1);
  }
  let base: URL | undefined;
  if (opts.baseUrl) {
    try {
      base = new URL(opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
    } catch {
      throw new FetchError(`bad --base-url ${opts.baseUrl}`, 1);
    }
    checkUrl(base);
  }
  const summary: FetchSummary = { files: 0, bytes: 0, downloaded: 0, reused: 0 };
  for (const repo of repos) {
    for (const file of repo.files) {
      const label = `${repo.id}/${file.path}`;
      const dest = resolve(out, repo.id, file.path);
      const rel = relative(out, dest);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new FetchError(`${label}: path leaves ${out}`, 1);
      summary.files++;
      summary.bytes += file.bytes;

      let present: { sha256: string; bytes: number } | undefined;
      if (existsSync(dest) && statSync(dest).isFile()) present = await hashFile(dest);
      if (present && present.bytes === file.bytes && present.sha256 === file.sha256) {
        summary.reused++;
        log(`ok        ${label}`);
        continue;
      }
      if (opts.verifyOnly) {
        throw new FetchError(
          present ? `${label}: SHA-256 mismatch (got ${present.sha256}, the lock says ${file.sha256})` : `${label}: missing`,
          3,
        );
      }
      mkdirSync(dirname(dest), { recursive: true });
      const url = base ? new URL(`${repo.id}/${file.path.split("/").map(encodeURIComponent).join("/")}`, base).href : resolveUrl(repo, file);
      let lastError: FetchError | undefined;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          log(`download  ${label} (${(file.bytes / 1024 / 1024).toFixed(2)} MiB)${attempt > 1 ? ` attempt ${attempt}` : ""}`);
          await download(url, dest, file, label);
          lastError = undefined;
          break;
        } catch (e) {
          lastError = e instanceof FetchError ? e : new FetchError(String(e), 2);
          if (lastError.code !== 2) break; // a mismatch is not worth retrying
          if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
      if (lastError) {
        rmSync(dest, { force: true }); // never keep a file that is wrong
        throw lastError;
      }
      summary.downloaded++;
    }
  }
  return summary;
}

function usage(): string {
  return "usage: tsx tools/fetch-upstream.ts [--out .upstream] [--lock tools/upstream.lock.json] [--only antalia-mini,duyu-small] [--verify-only] [--base-url URL]";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let out = join(ROOT, ".upstream");
  let lockPath = join(ROOT, "tools/upstream.lock.json");
  let only: string[] | undefined;
  let verifyOnly = false;
  let baseUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new FetchError(`${a} needs a value`, 1);
      return v;
    };
    if (a === "--out") out = resolve(value());
    else if (a === "--lock") lockPath = resolve(value());
    else if (a === "--only") only = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--verify-only") verifyOnly = true;
    else if (a === "--base-url") baseUrl = value();
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      return;
    } else throw new FetchError(`unknown argument ${a}\n${usage()}`, 1);
  }
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch (e) {
    throw new FetchError(`cannot read ${lockPath}: ${(e as Error).message}`, 1);
  }
  const lock = parseLock(text);
  const t0 = performance.now();
  const s = await fetchUpstream({ lock, out, only, verifyOnly, baseUrl, log: (l) => console.error(l) });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(
    `${verifyOnly ? "verified" : "fetched"} ${s.files} file(s), ${(s.bytes / 1024 / 1024).toFixed(1)} MiB in ${out}: ` +
      `${s.downloaded} downloaded, ${s.reused} already present with the right hash (${secs} s)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`fetch-upstream: ${e instanceof Error ? e.message : e}`);
    process.exit(e instanceof FetchError ? e.code : 1);
  });
}
