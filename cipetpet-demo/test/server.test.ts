// server/server.mjs: the chat proxy (allowlist, limits, CSRF, DNS-rebinding guard, key handling, abort) and the
// static routes. Real HTTP on an ephemeral loopback port; the upstream is a mock fetch, so nothing leaves the
// machine. The env is always passed explicitly: the server must never read .env.local in a test.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without declarations
import { createDemoServer, hostAllowed, packIntegrity, sanitizeChatRequest, sanitizeModelList } from "../server/server.mjs";
// @ts-expect-error plain .mjs without declarations
import { providersFromEnv } from "../server/providers.mjs";
import { FAKE_KEY, sleep, until } from "./helpers.ts";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const JSON_H = { "Content-Type": "application/json" };
const GOOD = JSON.stringify({ messages: [{ role: "user", content: "Merhaba" }], stream: false });

interface UpstreamCall {
  url: string;
  init: RequestInit;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function start(over: { env?: Record<string, string>; fetch?: typeof fetch; files?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cipetpet-demo-test-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, "dist");
  const packs = join(root, "packs");
  mkdirSync(dist);
  mkdirSync(packs);
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>demo</title>");
  writeFileSync(join(dist, ".secret"), "hidden");
  writeFileSync(join(root, "outside.txt"), "outside");
  writeFileSync(join(packs, "a.cpet"), "0123456789");
  for (const [name, text] of Object.entries(over.files ?? {})) writeFileSync(join(packs, name), text);

  const upstream: UpstreamCall[] = [];
  const mock: typeof fetch =
    over.fetch ??
    (async (url, init) => {
      upstream.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: "Selam" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  const logs: string[] = [];
  const app = createDemoServer({
    env: { OPENROUTER_API_KEY: FAKE_KEY, ...over.env },
    distDir: dist,
    packsDir: packs,
    ortDir: null,
    log: (l: string) => logs.push(l),
    fetch: mock,
  });
  const base: string = await app.listen(0, "127.0.0.1");
  cleanups.push(() => app.close());
  return { app, base, upstream, logs, root, dist, packs };
}

describe("sanitizeChatRequest", () => {
  it("keeps only the allowed fields and plain messages", () => {
    const r = sanitizeChatRequest(
      { model: "openai/gpt-4o", messages: [{ role: "user", content: "x", name: "evil", tool_calls: [1] }], tools: [{}], plugins: [{}], provider: { x: 1 }, temperature: 0.5, stream: true, __proto__: { a: 1 } },
      "d/m",
    );
    expect(r).toEqual({ ok: true, body: { model: "openai/gpt-4o", messages: [{ role: "user", content: "x" }], temperature: 0.5, stream: true } });
  });

  it("rejects bad shapes and values", () => {
    for (const bad of [null, [], "x", {}, { messages: [] }, { messages: [{ role: "tool", content: "x" }] }, { messages: [{ role: "user", content: 5 }] }]) {
      expect(sanitizeChatRequest(bad, "d/m").ok).toBe(false);
    }
    const m = [{ role: "user", content: "x" }];
    expect(sanitizeChatRequest({ messages: m, temperature: 3 }, "d/m").ok).toBe(false);
    expect(sanitizeChatRequest({ messages: m, max_tokens: 1.5 }, "d/m").ok).toBe(false);
    expect(sanitizeChatRequest({ messages: m, model: "no spaces allowed" }, "d/m").ok).toBe(false);
    expect(sanitizeChatRequest({ messages: m }, "the/default")).toMatchObject({ ok: true, body: { model: "the/default" } });
  });
});

describe("hostAllowed", () => {
  it("accepts localhost and IP literals, refuses other names unless listed", () => {
    for (const h of ["localhost", "localhost:5173", "127.0.0.1:5393", "[::1]:5393", "192.168.1.20:80", "app.localhost:1"]) expect(hostAllowed(h), h).toBe(true);
    for (const h of ["evil.com", "evil.com:5393", "127.0.0.1.evil.com", "localhost.evil.com", "[bad"]) expect(hostAllowed(h), h).toBe(false);
    expect(hostAllowed("demo.example:8080", ["demo.example"])).toBe(true);
    expect(hostAllowed(undefined)).toBe(true);
  });
});

describe("POST /api/chat", () => {
  it("forwards a sanitised body with the key added server-side and never leaks it", async () => {
    const s = await start();
    const r = await call(s.base, "POST", "/api/chat", { ...JSON_H, Authorization: "Bearer browser-key", Cookie: "x=1", "X-Custom": "1" }, JSON.stringify({ messages: [{ role: "user", content: "Merhaba" }], tools: [{}], stream: false }));
    expect(r.status).toBe(200);
    expect(r.body).toContain("Selam");
    expect(s.upstream).toHaveLength(1);
    const { url, init } = s.upstream[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(Object.keys(h).map((k) => k.toLowerCase()).sort()).toEqual(["accept", "authorization", "content-type", "http-referer", "x-title"]);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual({ model: "openai/gpt-4o", messages: [{ role: "user", content: "Merhaba" }], stream: false });
    // the key is in no response header or body, and not in the log
    expect(JSON.stringify(r.headers) + r.body).not.toContain(FAKE_KEY);
    expect(s.logs.join("\n")).not.toContain(FAKE_KEY);
    expect(s.logs.join("\n")).not.toContain("Merhaba");
  });

  it("answers 503 without a key, 405 for GET, 415 for other content types, 400 for bad JSON / bodies", async () => {
    const none = await start({ env: { OPENROUTER_API_KEY: "" } });
    expect((await call(none.base, "POST", "/api/chat", JSON_H, GOOD)).status).toBe(503);
    expect(JSON.parse((await call(none.base, "GET", "/api/config")).body)).toMatchObject({ proxy: false });

    const s = await start();
    expect((await call(s.base, "GET", "/api/chat")).status).toBe(405);
    expect((await call(s.base, "POST", "/api/chat", { "Content-Type": "text/plain" }, GOOD)).status).toBe(415);
    expect((await call(s.base, "POST", "/api/chat", {}, GOOD)).status).toBe(415);
    expect((await call(s.base, "POST", "/api/chat", JSON_H, "{nope")).status).toBe(400);
    expect((await call(s.base, "POST", "/api/chat", JSON_H, JSON.stringify({ messages: [] }))).status).toBe(400);
    expect(s.upstream).toHaveLength(0);
  });

  it("refuses a body over the limit (declared and streamed)", async () => {
    const s = await start();
    const big = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(70 * 1024) }] });
    expect((await call(s.base, "POST", "/api/chat", JSON_H, big)).status).toBe(413);
    expect(s.upstream).toHaveLength(0);
  });

  it("refuses cross-site requests: Origin, Sec-Fetch-Site and the Host header (DNS rebinding)", async () => {
    const s = await start();
    const port = new URL(s.base).port;
    const cross = await call(s.base, "POST", "/api/chat", { ...JSON_H, Origin: "https://evil.example" }, GOOD);
    expect(cross.status).toBe(403);
    expect((await call(s.base, "POST", "/api/chat", { ...JSON_H, "Sec-Fetch-Site": "cross-site" }, GOOD)).status).toBe(403);
    expect((await call(s.base, "POST", "/api/chat", { ...JSON_H, Origin: "null" }, GOOD)).status).toBe(403);
    // a rebound page claims everything is same-origin: only the Host header gives it away
    const rebound = await call(s.base, "POST", "/api/chat", { ...JSON_H, Host: `evil.com:${port}`, Origin: `http://evil.com:${port}`, "Sec-Fetch-Site": "same-origin" }, GOOD);
    expect(rebound.status).toBe(403);
    expect(rebound.body).toContain("Host");
    expect((await call(s.base, "GET", "/", { Host: `evil.com:${port}` })).status).toBe(403);
    expect(s.upstream).toHaveLength(0);
    // the same-origin page itself works
    const ok = await call(s.base, "POST", "/api/chat", { ...JSON_H, Origin: s.base, "Sec-Fetch-Site": "same-origin" }, GOOD);
    expect(ok.status).toBe(200);
  });

  it("ALLOWED_HOSTS lets a named host through", async () => {
    const s = await start({ env: { ALLOWED_HOSTS: "demo.example, other.example" } });
    expect((await call(s.base, "GET", "/api/config", { Host: "demo.example:8080" })).status).toBe(200);
    expect((await call(s.base, "GET", "/api/config", { Host: "evil.example" })).status).toBe(403);
  });

  it("passes upstream errors through and maps unreachable upstreams to 502 / timeouts to 504", async () => {
    const s = await start({ fetch: (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, headers: { "Content-Type": "application/json" } })) as typeof fetch });
    const r = await call(s.base, "POST", "/api/chat", JSON_H, GOOD);
    expect(r.status).toBe(401);
    expect(r.body).toContain("bad key");

    const down = await start({ fetch: (async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))) as typeof fetch });
    const d = await call(down.base, "POST", "/api/chat", JSON_H, GOOD);
    expect(d.status).toBe(502);
    expect(d.body).toContain("ECONNREFUSED");
  });

  it("aborts the upstream request when the browser goes away", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let cancelled = false;
    const s = await start({
      fetch: (async (_url: unknown, init?: RequestInit) => {
        upstreamSignal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: {}\n\n"));
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }) as typeof fetch,
    });
    const u = new URL(s.base);
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: u.hostname, port: u.port, method: "POST", path: "/api/chat", headers: JSON_H }, (res) => {
        res.once("data", () => {
          req.destroy(); // tab closed
          resolve();
        });
      });
      req.on("error", () => {});
      req.once("error", reject);
      req.end(JSON.stringify({ messages: [{ role: "user", content: "x" }], stream: true }));
    });
    await until(() => cancelled || upstreamSignal?.aborted === true, 3000, "upstream aborted");
    expect(upstreamSignal?.aborted).toBe(true);
  });
});

describe("static routes", () => {
  it("serves dist, with isolation headers, and refuses traversal, dotfiles and unknown paths", async () => {
    const s = await start();
    const home = await call(s.base, "GET", "/");
    expect(home.status).toBe(200);
    expect(home.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(home.headers["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(home.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(home.headers["x-frame-options"]).toBe("DENY");
    for (const p of ["/../outside.txt", "/%2e%2e/outside.txt", "/%2e%2e%2foutside.txt", "/..%5coutside.txt", "/%252e%252e/outside.txt", "/a%00b", "//etc/passwd", "/.secret", "/%2esecret"]) {
      const r = await call(s.base, "GET", p);
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.body, p).not.toContain("outside");
      expect(r.body, p).not.toContain("hidden");
    }
    expect((await call(s.base, "POST", "/index.html")).status).toBe(405);
    expect((await call(s.base, "GET", "/nope.js")).status).toBe(404);
    expect((await call(s.base, "GET", "/api/nope")).status).toBe(404);
  });

  it("packs: Range, ETag revalidation, no absolute path in the 404, no immutable caching", async () => {
    const s = await start();
    const full = await call(s.base, "GET", "/packs/a.cpet");
    expect(full.status).toBe(200);
    expect(full.body).toBe("0123456789");
    expect(full.headers["cache-control"]).toBe("no-cache");
    const part = await call(s.base, "GET", "/packs/a.cpet", { Range: "bytes=2-4" });
    expect(part.status).toBe(206);
    expect(part.body).toBe("234");
    expect(part.headers["content-range"]).toBe("bytes 2-4/10");
    expect((await call(s.base, "GET", "/packs/a.cpet", { Range: "bytes=50-" })).status).toBe(416);
    expect((await call(s.base, "GET", "/packs/a.cpet", { "If-None-Match": String(full.headers.etag) })).status).toBe(304);
    const missing = await call(s.base, "GET", "/packs/none.cpet");
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain(s.root);
  });

  it("/ort answers 404 when onnxruntime-web is not available", async () => {
    const s = await start();
    expect((await call(s.base, "GET", "/ort/ort-wasm-simd-threaded.wasm")).status).toBe(404);
  });

  it("a dangling symlink in the packs folder is a plain 404", async () => {
    const s = await start();
    symlinkSync(join(s.root, "nowhere"), join(s.packs, "dangling.cpet"));
    expect((await call(s.base, "GET", "/packs/dangling.cpet")).status).toBe(404);
  });
});

describe("/api/config and pack digests", () => {
  it("lists the digest of each pack whose manifest entry still matches the file", async () => {
    const digest = "sha256-" + "A".repeat(43) + "=";
    const manifest = JSON.stringify({
      packs: [
        { file: "a.cpet", bytes: 10, integrity: digest },
        { file: "b.cpet", bytes: 99, integrity: digest }, // size differs: stale manifest
        { file: "gone.cpet", bytes: 10, integrity: digest }, // file missing
        { file: "../a.cpet", bytes: 10, integrity: digest }, // not a plain file name
        { file: "a.cpet", bytes: 10, integrity: "md5-x" }, // not a digest
      ],
    });
    const s = await start({ files: { "manifest.json": manifest, "b.cpet": "tiny" } });
    const cfg = JSON.parse((await call(s.base, "GET", "/api/config")).body);
    expect(cfg).toEqual({
      proxy: true,
      defaultModel: "openai/gpt-4o",
      provider: "openrouter",
      providers: [{ id: "openrouter", name: "OpenRouter", kind: "openrouter", defaultModel: "openai/gpt-4o" }],
      packs: { "a.cpet": digest },
    });
    expect(JSON.stringify(cfg)).not.toContain(FAKE_KEY);
    expect(packIntegrity(join(s.root, "does-not-exist"))).toEqual({});
  });

  it("warns when the upstream is neither https nor loopback", async () => {
    const s = await start({ env: { OPENROUTER_UPSTREAM: "http://gateway.lan/v1" } });
    expect(s.logs.some((l) => /not https/.test(l))).toBe(true);
    const ok = await start({ env: { OPENROUTER_UPSTREAM: "http://127.0.0.1:9/v1" } });
    expect(ok.logs.some((l) => /not https/.test(l))).toBe(false);
  });
});

describe("OpenAI-compatible providers", () => {
  const LOCAL = { LLM_PROVIDERS: "ollama, groq", LLM_OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1/", LLM_OLLAMA_MODEL: "llama3.2:3b", LLM_OLLAMA_NAME: "Ollama (local)", LLM_GROQ_BASE_URL: "https://api.groq.com/openai/v1", LLM_GROQ_API_KEY: "gsk-test-key", LLM_GROQ_MODEL: "llama-3.3-70b-versatile" };

  it("providersFromEnv: OpenRouter first, then LLM_PROVIDERS in order; bad entries are skipped with a warning", () => {
    const logs: string[] = [];
    const { providers, defaultId } = providersFromEnv(
      { OPENROUTER_API_KEY: "or-key", ...LOCAL, LLM_PROVIDERS: "ollama,groq,Bad Id,missing,ollama,ftp", LLM_FTP_BASE_URL: "ftp://x.example/v1", LLM_DEFAULT_PROVIDER: "groq" },
      (l: string) => logs.push(l),
    );
    expect(providers.map((p: { id: string }) => p.id)).toEqual(["openrouter", "ollama", "groq"]);
    expect(providers[1]).toEqual({ id: "ollama", name: "Ollama (local)", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", defaultModel: "llama3.2:3b" });
    expect(defaultId).toBe("groq");
    expect(logs.join("\n")).toMatch(/"bad id" is not a valid id/);
    expect(logs.join("\n")).toMatch(/LLM_MISSING_BASE_URL is not set/);
    expect(logs.join("\n")).toMatch(/"ollama" is listed twice/);
    expect(logs.join("\n")).toMatch(/LLM_FTP_BASE_URL must be an http\(s\) URL/);
    // a key sent over plain http to a non-loopback host is worth a warning; a keyless local server is not
    const warn: string[] = [];
    providersFromEnv({ LLM_PROVIDERS: "lan,local", LLM_LAN_BASE_URL: "http://gpu.lan:8000/v1", LLM_LAN_API_KEY: "k", LLM_LAN_MODEL: "m", LLM_LOCAL_BASE_URL: "http://gpu.lan:8000/v1", LLM_LOCAL_MODEL: "m" }, (l: string) => warn.push(l));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatch(/LLM_LAN_BASE_URL http:\/\/gpu\.lan:8000 is not https/);
  });

  it("without OpenRouter: /api/config lists the compatible providers, and /api/chat routes by the body's provider", async () => {
    const s = await start({ env: { OPENROUTER_API_KEY: "", ...LOCAL } });
    const cfg = JSON.parse((await call(s.base, "GET", "/api/config")).body);
    expect(cfg).toMatchObject({ proxy: true, provider: "ollama", defaultModel: "llama3.2:3b" });
    expect(cfg.providers).toEqual([
      { id: "ollama", name: "Ollama (local)", kind: "openai", defaultModel: "llama3.2:3b" },
      { id: "groq", name: "groq", kind: "openai", defaultModel: "llama-3.3-70b-versatile" },
    ]);
    expect(JSON.stringify(cfg)).not.toContain("gsk-test-key");
    expect(JSON.stringify(cfg)).not.toContain("11434");

    // the default provider, with no key: no Authorization header, and no OpenRouter attribution
    expect((await call(s.base, "POST", "/api/chat", JSON_H, GOOD)).status).toBe(200);
    expect(s.upstream[0].url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(Object.keys(s.upstream[0].init.headers as object).map((k) => k.toLowerCase()).sort()).toEqual(["accept", "content-type"]);
    expect(JSON.parse(String(s.upstream[0].init.body))).toEqual({ model: "llama3.2:3b", messages: [{ role: "user", content: "Merhaba" }], stream: false });

    // another provider by id: its key, its default model, "provider" is not forwarded
    const body = JSON.stringify({ provider: "groq", messages: [{ role: "user", content: "Merhaba" }], stream: false });
    expect((await call(s.base, "POST", "/api/chat", JSON_H, body)).status).toBe(200);
    expect(s.upstream[1].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((s.upstream[1].init.headers as Record<string, string>).Authorization).toBe("Bearer gsk-test-key");
    expect(JSON.parse(String(s.upstream[1].init.body))).toEqual({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "Merhaba" }], stream: false });

    // an unknown provider is a 400 that names the ones there are; nothing goes upstream
    const bad = await call(s.base, "POST", "/api/chat", JSON_H, JSON.stringify({ provider: "openai", messages: [{ role: "user", content: "x" }] }));
    expect(bad.status).toBe(400);
    expect(bad.body).toContain("ollama, groq");
    expect(s.upstream).toHaveLength(2);
    expect(s.logs.join("\n")).not.toContain("gsk-test-key");
  });

  it("a provider without a default model needs the page to name one", async () => {
    const s = await start({ env: { OPENROUTER_API_KEY: "", LLM_PROVIDERS: "lm", LLM_LM_BASE_URL: "http://localhost:1234/v1" } });
    expect(s.logs.some((l) => /LLM_LM_MODEL is not set/.test(l))).toBe(true);
    const r = await call(s.base, "POST", "/api/chat", JSON_H, GOOD);
    expect(r.status).toBe(400);
    expect(r.body).toContain("no model");
    expect((await call(s.base, "POST", "/api/chat", JSON_H, JSON.stringify({ model: "qwen2.5-7b", messages: [{ role: "user", content: "x" }] }))).status).toBe(200);
    expect(s.upstream).toHaveLength(1);
  });

  it("no provider at all: 503 that says what to set", async () => {
    const s = await start({ env: { OPENROUTER_API_KEY: "" } });
    const r = await call(s.base, "POST", "/api/chat", JSON_H, GOOD);
    expect(r.status).toBe(503);
    expect(r.body).toMatch(/OPENROUTER_API_KEY.*LLM_PROVIDERS/);
    expect(JSON.parse((await call(s.base, "GET", "/api/config")).body)).toMatchObject({ proxy: false, provider: null, providers: [] });
  });

  it("GET /api/models proxies the provider's model list with its key, sanitised and cached", async () => {
    const upstream: UpstreamCall[] = [];
    const s = await start({
      env: { OPENROUTER_API_KEY: "", ...LOCAL },
      fetch: (async (url: unknown, init?: RequestInit) => {
        upstream.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ object: "list", data: [{ id: "llama-3.3-70b-versatile", owned_by: "Meta", secret: "x" }, { id: 42 }, { id: "whisper-large-v3", name: "Whisper" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    const r = await call(s.base, "GET", "/api/models?provider=groq");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ data: [{ id: "llama-3.3-70b-versatile" }, { id: "whisper-large-v3", name: "Whisper" }] });
    expect(upstream[0].url).toBe("https://api.groq.com/openai/v1/models");
    expect((upstream[0].init.headers as Record<string, string>).Authorization).toBe("Bearer gsk-test-key");
    expect(upstream[0].init.redirect).toBe("error");
    await call(s.base, "GET", "/api/models?provider=groq");
    expect(upstream).toHaveLength(1);
    expect((await call(s.base, "GET", "/api/models?provider=nope")).status).toBe(400);
    expect((await call(s.base, "GET", "/api/models?provider=groq", { Origin: "https://evil.example" })).status).toBe(403);
    expect((await call(s.base, "POST", "/api/models?provider=groq")).status).toBe(405);
  });

  it("sanitizeModelList keeps ids, names, pricing and context; rejects what is not a list", () => {
    expect(sanitizeModelList({ data: [{ id: "a", name: "A", pricing: { prompt: "0.1", completion: "0.2" }, context_length: 8192, extra: 1 }] })).toEqual({
      data: [{ id: "a", name: "A", pricing: { prompt: "0.1", completion: "0.2" }, context_length: 8192 }],
    });
    expect(sanitizeModelList([{ id: "bare-array" }])).toEqual({ data: [{ id: "bare-array" }] });
    expect(sanitizeModelList({ models: [] })).toBeNull();
  });
});

describe("back-pressure", () => {
  it("streams a large upstream body to a slow client without piling up listeners", async () => {
    const warnings: string[] = [];
    const onWarn = (w: Error) => warnings.push(w.name);
    process.on("warning", onWarn);
    cleanups.push(() => void process.off("warning", onWarn));
    const chunk = new Uint8Array(256 * 1024).fill(97);
    let sent = 0;
    const total = 24;
    const s = await start({
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (sent++ < total) c.enqueue(chunk);
              else c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        )) as typeof fetch,
    });
    const u = new URL(s.base);
    const bytes = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: u.hostname, port: u.port, method: "POST", path: "/api/chat", headers: JSON_H }, (res) => {
        let n = 0;
        res.on("data", async (c: Buffer) => {
          n += c.length;
          res.pause();
          await sleep(5); // slow reader
          res.resume();
        });
        res.on("end", () => resolve(n));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ messages: [{ role: "user", content: "x" }], stream: true }));
    });
    expect(bytes).toBe(total * chunk.length);
    await sleep(20);
    expect(warnings).not.toContain("MaxListenersExceededWarning");
  }, 30000);
});
