#!/usr/bin/env node
// cipetpet-demo server (Node >= 20, no dependencies).
//
//   /               dist/ (the built app)
//   /packs/*        ../cipetpet/packs (model packs: Range requests, ETag revalidation)
//   /ort/*          onnxruntime-web's dist/ (the WASM runtime files ORT fetches at run time)
//   GET  /api/config  {proxy, defaultModel, provider, providers: [{id, name, kind, defaultModel}], packs: {file: "sha256-<base64>"}}
//   POST /api/chat    -> <provider>/chat/completions (OpenRouter or any OpenAI-compatible API, see providers.mjs),
//                        the API key added here (never sent to the browser); the body's "provider" picks one
//   GET  /api/models?provider=<id>  -> that provider's GET /models, as {data: [{id, name?, ...}]}
//
// Every response carries COOP same-origin + COEP require-corp (+ CORP same-origin), so the page is
// cross-origin isolated: SharedArrayBuffer is available and ONNX Runtime can run WASM threads.

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "./env.mjs";
import { DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_UPSTREAM, displayUrl, providersFromEnv, publicProvider } from "./providers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEMO_ROOT = resolve(HERE, "..");

export const DEFAULT_MODEL = DEFAULT_OPENROUTER_MODEL;
export const DEFAULT_UPSTREAM = DEFAULT_OPENROUTER_UPSTREAM;
export const BODY_LIMIT = 64 * 1024;
/** request fields forwarded to the provider; everything else is dropped ("provider" only picks one) */
export const ALLOWED_FIELDS = ["model", "messages", "temperature", "max_tokens", "stream", "top_p"];
const UPSTREAM_HEADERS_TIMEOUT_MS = 60_000;
const MODELS_TIMEOUT_MS = 10_000;
const MODELS_CACHE_MS = 5 * 60_000;
/** at most this many models of a provider's list reach the page */
export const MODELS_LIMIT = 2000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".cpet": "application/octet-stream",
  ".onnx": "application/octet-stream",
};

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "microphone=(self)",
  // nobody can frame the page (clickjacking the mic button)
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
};

// ---------------------------------------------------------------------------------------------- paths

/** onnxruntime-web's dist/ folder: an explicit dir, else resolved from ../cipetpet, else from this package */
export function findOrtDist(cipetpetDir, explicit) {
  /** @type {string[]} */
  const candidates = [];
  if (explicit) candidates.push(resolve(explicit));
  for (const base of [cipetpetDir, DEMO_ROOT]) {
    try {
      // resolve the package's main entry (its exports map may hide package.json) and walk up to its root
      const main = createRequire(join(base, "package.json")).resolve("onnxruntime-web");
      let dir = dirname(main);
      while (dir !== dirname(dir) && !existsSync(join(dir, "package.json"))) dir = dirname(dir);
      candidates.push(join(dir, "dist"));
    } catch {
      // not installed there
    }
    candidates.push(join(base, "node_modules", "onnxruntime-web", "dist"));
  }
  return candidates.find((d) => existsSync(join(d, "ort-wasm-simd-threaded.wasm"))) ?? null;
}

/** maps a URL path below `root`; null for anything that escapes it */
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const full = resolve(root, `.${decoded.startsWith("/") ? "" : "/"}${decoded}`);
  if (full !== root && !full.startsWith(root + sep)) return null;
  // dotfiles (.env, .git, .DS_Store ...) are never served
  if (relative(root, full).split(sep).some((seg) => seg.startsWith("."))) return null;
  return full;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * DNS-rebinding guard: a page on evil.example whose name is re-pointed at 127.0.0.1 sends `Host: evil.example`
 * (and passes the same-origin check of crossSite). Only localhost, IP literals (a name cannot be rebound to
 * those) and names the operator lists are accepted.
 * @param {string | undefined} hostHeader
 * @param {Iterable<string>} [extra] additional allowed host names (no port)
 */
export function hostAllowed(hostHeader, extra = []) {
  if (!hostHeader) return true; // not a browser (HTTP/1.0 client): nothing to rebind
  let name;
  try {
    name = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (name === "localhost" || name.endsWith(".localhost") || IPV4.test(name) || (name.startsWith("[") && name.endsWith("]"))) return true;
  for (const e of extra) if (e === name) return true;
  return false;
}

/** {file: "sha256-..."} of the packs that packs/manifest.json lists and whose size on disk still matches */
export function packIntegrity(packsDir) {
  /** @type {Record<string, string>} */
  const out = {};
  try {
    const manifest = JSON.parse(readFileSync(join(packsDir, "manifest.json"), "utf8"));
    for (const p of Array.isArray(manifest?.packs) ? manifest.packs : []) {
      if (typeof p?.file !== "string" || !/^[\w.-]+\.cpet$/.test(p.file) || typeof p.integrity !== "string" || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(p.integrity)) continue;
      try {
        if (statSync(join(packsDir, p.file)).size === p.bytes) out[p.file] = p.integrity;
      } catch {
        // pack missing: no entry
      }
    }
  } catch {
    // no manifest: the packs load without a digest
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- helpers

function send(res, status, body, headers = {}) {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, { "Content-Length": buf.length, ...headers });
  res.end(res.req.method === "HEAD" ? undefined : buf);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
}

function sendError(res, status, message, headers) {
  sendJson(res, status, { error: { message, code: status } }, headers);
}

/** parses a single "bytes=a-b" range; "multi" for several ranges (served whole), null when unsatisfiable */
export function parseRange(header, size) {
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(header ?? "");
  if (!m) return header && header.includes(",") ? "multi" : undefined;
  let start;
  let end;
  if (m[1] === "") {
    if (m[2] === "") return null;
    const n = Number(m[2]);
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

/**
 * Serves one file: ETag / If-None-Match, Range (single range), HEAD.
 * @param {"immutable" | "day" | "revalidate"} caching
 */
function serveFile(req, res, file, caching) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Last-Modified": st.mtime.toUTCString(),
    "Cache-Control":
      caching === "immutable" ? "public, max-age=31536000, immutable" : caching === "day" ? "public, max-age=86400" : "no-cache",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  const range = req.headers.range && (!req.headers["if-range"] || req.headers["if-range"] === etag) ? parseRange(req.headers.range, st.size) : undefined;
  if (range === null) {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${st.size}`, "Content-Length": 0 });
    res.end();
    return true;
  }
  if (range && range !== "multi") {
    const len = range.end - range.start + 1;
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${st.size}`, "Content-Length": len });
    if (req.method === "HEAD") return res.end(), true;
    createReadStream(file, { start: range.start, end: range.end }).on("error", () => res.destroy()).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end(), true;
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
  return true;
}

/** resolves when `res` can take more data (or is closed), without leaving listeners behind */
function drained(res) {
  return new Promise((r) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      r(undefined);
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

/** reads a request body up to `limit` bytes; rejects with {status} on overflow */
function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) return reject(Object.assign(new Error("too large"), { status: 413 }));
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Validates the browser's request and keeps only ALLOWED_FIELDS.
 * @returns {{ ok: true, body: Record<string, unknown> } | { ok: false, message: string }}
 */
export function sanitizeChatRequest(input, defaultModel) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "body must be a JSON object" };
  /** @type {Record<string, unknown>} */
  const body = {};
  for (const k of ALLOWED_FIELDS) if (k in input) body[k] = input[k];

  if (body.model === undefined || body.model === "") body.model = defaultModel;
  if (body.model === undefined || body.model === "") return { ok: false, message: "no model: pick one in Settings (this provider has no default model)" };
  if (typeof body.model !== "string" || body.model.length > 200 || !/^[\w.:/@+-]+$/.test(body.model)) return { ok: false, message: "model must be a model id like openai/gpt-4o" };

  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > 200) return { ok: false, message: "messages must be a non-empty array (at most 200)" };
  const clean = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object" || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") {
      return { ok: false, message: "each message needs role system|user|assistant and string content" };
    }
    clean.push({ role: m.role, content: m.content });
  }
  body.messages = clean;

  const num = (k, lo, hi, int = false) => {
    if (body[k] === undefined) return true;
    const v = body[k];
    return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi && (!int || Number.isInteger(v));
  };
  if (!num("temperature", 0, 2)) return { ok: false, message: "temperature must be a number in 0..2" };
  if (!num("top_p", 0, 1)) return { ok: false, message: "top_p must be a number in 0..1" };
  if (!num("max_tokens", 1, 32768, true)) return { ok: false, message: "max_tokens must be an integer in 1..32768" };
  if (body.stream !== undefined && typeof body.stream !== "boolean") return { ok: false, message: "stream must be a boolean" };
  return { ok: true, body };
}

/** keeps id, name, pricing and context length of an OpenAI-style {data: [...]} model list */
export function sanitizeModelList(json) {
  const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : null;
  if (!data) return null;
  const out = [];
  for (const m of data) {
    if (out.length >= MODELS_LIMIT) break;
    if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id || m.id.length > 200) continue;
    /** @type {Record<string, unknown>} */
    const o = { id: m.id };
    if (typeof m.name === "string") o.name = m.name.slice(0, 200);
    if (typeof m.context_length === "number") o.context_length = m.context_length;
    if (m.pricing && typeof m.pricing === "object") {
      const { prompt, completion } = m.pricing;
      if ((typeof prompt === "string" || typeof prompt === "number") && (typeof completion === "string" || typeof completion === "number")) o.pricing = { prompt, completion };
    }
    out.push(o);
  }
  return { data: out };
}

/** a request from another site (CSRF against the local proxy) */
function crossSite(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------- server

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   distDir?: string, packsDir?: string, ortDir?: string | null, cipetpetDir?: string,
 *   log?: (line: string) => void,
 *   fetch?: typeof fetch,
 * }} [options]
 */
export function createDemoServer(options = {}) {
  const env = options.env ?? loadEnv(join(DEMO_ROOT, ".env.local")).env;
  const cipetpetDir = options.cipetpetDir ?? resolve(DEMO_ROOT, "..", "cipetpet");
  const distDir = resolve(options.distDir ?? join(DEMO_ROOT, "dist"));
  const packsDir = resolve(options.packsDir ?? env.CIPETPET_PACKS ?? join(cipetpetDir, "packs"));
  const ortDir = options.ortDir === undefined ? findOrtDist(cipetpetDir, env.ORT_DIST) : options.ortDir;
  const log = options.log ?? ((line) => console.log(line));
  const doFetch = options.fetch ?? globalThis.fetch;

  const { providers, defaultId } = providersFromEnv(env, log);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const defaultProvider = defaultId ? byId.get(defaultId) : undefined;
  const defaultModel = defaultProvider?.defaultModel || (defaultProvider ? "" : DEFAULT_MODEL);
  const appName = (env.OPENROUTER_APP_NAME ?? "").trim() || "cipetpet demo";
  let siteUrl = (env.OPENROUTER_SITE_URL ?? "").trim();
  const allowedHosts = new Set(
    [...(env.ALLOWED_HOSTS ?? "").split(","), env.HOST ?? ""].map((h) => h.trim().toLowerCase().replace(/^\[|\]$/g, "")).filter(Boolean),
  );
  /** @type {Map<string, { at: number, list: unknown }>} */
  const modelCache = new Map();

  /** the headers every upstream request of `p` carries: the key, and OpenRouter's app attribution */
  function upstreamHeaders(p, accept) {
    /** @type {Record<string, string>} */
    const h = { Accept: accept };
    if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
    if (p.kind === "openrouter") Object.assign(h, { "HTTP-Referer": siteUrl, "X-Title": appName });
    return h;
  }

  /** the provider a request names (or the default); a response was sent when it returns undefined */
  function pickProvider(res, id) {
    if (providers.length === 0) {
      sendError(
        res,
        503,
        "The chat proxy has no provider: put OPENROUTER_API_KEY=... (OpenRouter) or LLM_PROVIDERS=... (any OpenAI-compatible API) in cipetpet-demo/.env.local and restart the server (or use the echo / direct mode in Settings).",
      );
      return undefined;
    }
    if (id === undefined || id === null || id === "") return defaultProvider;
    const p = typeof id === "string" ? byId.get(id) : undefined;
    if (!p) sendError(res, 400, `unknown provider ${JSON.stringify(String(id).slice(0, 40))} (this server has: ${providers.map((x) => x.id).join(", ")})`);
    return p;
  }

  async function proxyModels(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "use GET", { Allow: "GET" });
    if (crossSite(req)) return sendError(res, 403, "cross-site requests are not allowed");
    const p = pickProvider(res, url.searchParams.get("provider"));
    if (!p) return;
    const hit = modelCache.get(p.id);
    if (hit && Date.now() - hit.at < MODELS_CACHE_MS) return sendJson(res, 200, hit.list);
    let up;
    try {
      up = await doFetch(`${p.baseUrl}/models`, {
        headers: upstreamHeaders(p, "application/json"),
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (e) {
      return sendError(res, 502, `could not reach ${p.name} (${e?.cause?.code ?? e?.name ?? "network error"})`);
    }
    if (!up.ok) {
      up.body?.cancel().catch(() => {});
      return sendError(res, 502, `${p.name} answered ${up.status} to GET /models`);
    }
    let list;
    try {
      list = sanitizeModelList(await up.json());
    } catch {
      list = null;
    }
    if (!list) return sendError(res, 502, `${p.name}'s GET /models is not an OpenAI-style model list`);
    modelCache.set(p.id, { at: Date.now(), list });
    return sendJson(res, 200, list);
  }

  async function proxyChat(req, res) {
    if (req.method !== "POST") return sendError(res, 405, "use POST", { Allow: "POST" });
    if (crossSite(req)) return sendError(res, 403, "cross-site requests are not allowed");
    if (providers.length === 0) return void pickProvider(res, undefined); // 503, with what to configure
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return sendError(res, 415, "Content-Type must be application/json");

    let raw;
    try {
      raw = await readBody(req, BODY_LIMIT);
    } catch (e) {
      if (e.status === 413) return sendError(res, 413, `request body over ${BODY_LIMIT / 1024} KB`, { Connection: "close" });
      return sendError(res, 400, "could not read the request body");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendError(res, 400, "body is not valid JSON");
    }
    const provider = pickProvider(res, parsed?.provider);
    if (!provider) return;
    const checked = sanitizeChatRequest(parsed, provider.defaultModel);
    if (!checked.ok) return sendError(res, 400, checked.message);

    // the browser going away (tab closed, Stop pressed) aborts the upstream request
    const upstreamAbort = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) upstreamAbort.abort();
    };
    res.on("close", onClose);
    const headersTimer = setTimeout(() => upstreamAbort.abort(new Error("upstream timeout")), UPSTREAM_HEADERS_TIMEOUT_MS);

    let up;
    try {
      up = await doFetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...upstreamHeaders(provider, checked.body.stream ? "text/event-stream" : "application/json"), "Content-Type": "application/json" },
        body: JSON.stringify(checked.body),
        signal: upstreamAbort.signal,
        redirect: "error", // never follow a redirect with the key attached
      });
    } catch (e) {
      clearTimeout(headersTimer);
      if (res.destroyed || res.writableEnded) return;
      const timeout = upstreamAbort.signal.reason instanceof Error && upstreamAbort.signal.reason.message === "upstream timeout";
      return sendError(res, timeout ? 504 : 502, timeout ? `${provider.name} did not answer in time` : `could not reach ${provider.name} (${e?.cause?.code ?? e?.name ?? "network error"})`);
    }
    clearTimeout(headersTimer);
    if (res.destroyed) {
      up.body?.cancel().catch(() => {});
      return;
    }

    res.writeHead(up.status, {
      "Content-Type": up.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    if (!up.body) return res.end();
    const reader = up.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // write as it comes, no buffering; respect back-pressure from a slow client
        if (!res.write(value)) await drained(res);
        if (res.destroyed) break;
      }
    } catch {
      // upstream failed or was aborted mid-stream: end the response as is (the client sees a cut stream)
    } finally {
      reader.cancel().catch(() => {});
      res.off("close", onClose);
      if (!res.destroyed) res.end();
    }
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.setHeader(k, v);
    res.on("finish", () => {
      // method, path and status only: never headers or bodies (the proxy's key, users' messages)
      log(`${req.method} ${(req.url ?? "").split("?")[0]} ${res.statusCode} ${Date.now() - started}ms`);
    });
    try {
      if (!hostAllowed(req.headers.host, allowedHosts)) {
        return sendError(res, 403, "unexpected Host header (DNS-rebinding protection); list the name in ALLOWED_HOSTS to serve it");
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/api/config") {
        if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "use GET", { Allow: "GET" });
        return sendJson(res, 200, {
          proxy: providers.length > 0,
          defaultModel,
          provider: defaultId,
          providers: providers.map(publicProvider),
          packs: packIntegrity(packsDir),
        });
      }
      if (path === "/api/chat") return await proxyChat(req, res);
      if (path === "/api/models") return await proxyModels(req, res, url);
      if (path.startsWith("/api/")) return sendError(res, 404, "no such endpoint");

      if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "method not allowed", { Allow: "GET, HEAD" });

      if (path.startsWith("/packs/")) {
        const file = safeJoin(packsDir, path.slice("/packs".length));
        // revalidated on every use (ETag): the URL has no version, and the packs get rebuilt
        if (file && serveFile(req, res, file, "revalidate")) return;
        return sendError(res, 404, "no such pack (build the packs in ../cipetpet: npm run packs)");
      }
      if (path.startsWith("/ort/")) {
        const file = ortDir && safeJoin(ortDir, path.slice("/ort".length));
        if (file && serveFile(req, res, file, "day")) return;
        return sendError(res, 404, ortDir ? "no such ORT file" : "onnxruntime-web not found (npm install in ../cipetpet)");
      }

      const file = safeJoin(distDir, path === "/" ? "/index.html" : path);
      if (file && serveFile(req, res, file, "revalidate")) return;
      if (path === "/" || path === "/index.html") return sendError(res, 503, "dist/ is empty: run npm run build (or npm run dev)");
      return sendError(res, 404, "not found");
    } catch (e) {
      if (!res.headersSent) sendError(res, 500, "internal error");
      else res.destroy();
      log(`error handling ${req.method} ${(req.url ?? "").split("?")[0]}: ${e?.message ?? e}`);
    }
  });

  return {
    server,
    get proxyEnabled() {
      return providers.length > 0;
    },
    /** id, name, URL (no credentials) and default model of each provider, for the startup log */
    providers: providers.map((p) => ({ ...publicProvider(p), url: displayUrl(p.baseUrl), hasKey: p.apiKey !== "", isDefault: p.id === defaultId })),
    paths: { distDir, packsDir, ortDir },
    /** @param {number} port @param {string} host */
    listen(port, host) {
      return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : port;
          if (!siteUrl) siteUrl = `http://localhost:${actualPort}`;
          resolveListen(`http://${host.includes(":") ? `[${host}]` : host}:${actualPort}`);
        });
      });
    },
    close() {
      return new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r(undefined));
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------- CLI

async function main() {
  const envFile = process.env.DEMO_ENV_FILE === "none" ? null : (process.env.DEMO_ENV_FILE || join(DEMO_ROOT, ".env.local"));
  const { env, loadedFile } = loadEnv(envFile);
  const port = Number(env.PORT ?? 5173);
  const host = env.HOST || "127.0.0.1";
  const app = createDemoServer({ env });
  const url = await app.listen(Number.isFinite(port) ? port : 5173, host);
  const { distDir, packsDir, ortDir } = app.paths;
  console.log(`cipetpet demo on ${url}`);
  console.log(`  app:   ${distDir}${existsSync(join(distDir, "index.html")) ? "" : "  (empty: run npm run build)"}`);
  console.log(`  packs: ${packsDir}${existsSync(packsDir) ? "" : "  (missing: build them in ../cipetpet)"}`);
  console.log(`  ort:   ${ortDir ?? "(onnxruntime-web not found: npm install in ../cipetpet)"}`);
  if (app.proxyEnabled) {
    console.log(`  chat proxy: on (settings from ${loadedFile ? ".env.local and the environment" : "the environment"})`);
    for (const p of app.providers) {
      const model = p.defaultModel ? `model ${p.defaultModel}` : "no default model";
      console.log(`    ${p.isDefault ? "*" : " "} ${p.id}: ${p.name}, ${p.url}, ${model}${p.hasKey ? "" : ", no API key"}`);
    }
  } else {
    console.log("  chat proxy: off (no OPENROUTER_API_KEY or LLM_PROVIDERS; the page offers echo / direct mode)");
  }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && app.proxyEnabled) {
    console.warn(`  warning: listening on ${host}: anyone who can reach this address can use your providers' keys through /api/chat`);
  }
  const shutdown = () => {
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`cipetpet demo server: ${e?.message ?? e}`);
    process.exit(1);
  });
}

export { main };
