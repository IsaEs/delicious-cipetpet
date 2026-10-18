import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectBackend } from "../src/llm/direct.ts";
import { createEchoBackend, defaultEchoReply } from "../src/llm/echo.ts";
import { FALLBACK_MODELS, loadModels, MODELS_URL, parseModels, resetModelCache } from "../src/llm/models.ts";
import { createProxyBackend } from "../src/llm/proxy.ts";
import { ChatError, type ChatMessage } from "../src/llm/types.ts";
import { collect, enc, FAKE_KEY, sseResponse } from "./helpers.ts";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "Türkçe yanıt ver." },
  { role: "user", content: "Merhaba" },
];

const STREAM = enc.encode(
  'data: {"choices":[{"delta":{"content":"Mer"}}]}\n\n' + 'data: {"choices":[{"delta":{"content":"haba!"}}]}\n\n' + "data: [DONE]\n\n",
);

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init ?? {}));
}

describe("proxy backend", () => {
  it("posts the conversation to /api/chat, with no key, and streams the deltas", async () => {
    const f = mockFetch(() => sseResponse([STREAM]));
    const backend = createProxyBackend({ fetch: f });
    const out = await collect(backend.stream(MESSAGES, { model: "openai/gpt-4o", temperature: 0.7, maxTokens: 300 }));
    expect(out.join("")).toBe("Merhaba!");
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/chat");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({ model: "openai/gpt-4o", messages: MESSAGES, stream: true, temperature: 0.7, max_tokens: 300 });
  });

  it("passes the abort signal to fetch", async () => {
    const abort = new AbortController();
    const f = mockFetch((_u, init) => {
      expect(init.signal).toBe(abort.signal);
      return sseResponse([STREAM]);
    });
    await collect(createProxyBackend({ fetch: f }).stream(MESSAGES, { model: "m", signal: abort.signal }));
  });

  it("reports the proxy's 503 (no key on the server) with its explanation", async () => {
    const f = mockFetch(
      () => new Response(JSON.stringify({ error: { message: "The chat proxy has no OpenRouter API key: put OPENROUTER_API_KEY=... in .env.local" } }), { status: 503 }),
    );
    await expect(collect(createProxyBackend({ fetch: f }).stream(MESSAGES, { model: "m" }))).rejects.toMatchObject({
      code: "not_configured",
      message: expect.stringContaining("OPENROUTER_API_KEY"),
    });
  });

  it("turns a network failure into ChatError(network)", async () => {
    const f = mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const err = await collect(createProxyBackend({ fetch: f }).stream(MESSAGES, { model: "m" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(err).toMatchObject({ code: "network" });
  });

  it("keeps an abort an AbortError (not a network error)", async () => {
    const abort = new AbortController();
    abort.abort();
    const f = mockFetch(() => Promise.reject(new DOMException("aborted", "AbortError")));
    const err = await collect(createProxyBackend({ fetch: f }).stream(MESSAGES, { model: "m", signal: abort.signal })).catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("direct backend", () => {
  it("calls openrouter.ai with the user's key and attribution headers", async () => {
    let key = FAKE_KEY;
    const f = mockFetch(() => sseResponse([STREAM]));
    const backend = createDirectBackend({ getKey: () => key, siteUrl: "http://localhost:5173", fetch: f });
    expect((await collect(backend.stream(MESSAGES, { model: "anthropic/claude-3.5-haiku" }))).join("")).toBe("Merhaba!");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers.get("http-referer")).toBe("http://localhost:5173");
    expect(headers.get("x-title")).toBe("cipetpet demo");
    expect(init?.credentials).toBe("omit");
    expect(JSON.parse(String(init?.body)).model).toBe("anthropic/claude-3.5-haiku");

    // the key is read per request
    key = "sk-or-v1-OTHER-TEST-KEY";
    await collect(backend.stream(MESSAGES, { model: "m" }));
    expect(new Headers(f.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer sk-or-v1-OTHER-TEST-KEY");
  });

  it("fails fast without a key and never calls fetch", async () => {
    const f = mockFetch(() => sseResponse([STREAM]));
    const backend = createDirectBackend({ getKey: () => "  ", fetch: f });
    await expect(collect(backend.stream(MESSAGES, { model: "m" }))).rejects.toMatchObject({ code: "invalid_key" });
    expect(f).not.toHaveBeenCalled();
  });

  it("maps 401 / 402 / 429 to readable errors", async () => {
    for (const [status, re] of [
      [401, /invalid API key/],
      [402, /credits/],
      [429, /rate limited/],
    ] as const) {
      const f = mockFetch(() => new Response(JSON.stringify({ error: { message: "x", code: status } }), { status }));
      await expect(collect(createDirectBackend({ getKey: () => FAKE_KEY, fetch: f }).stream(MESSAGES, { model: "m" }))).rejects.toThrow(re);
    }
  });
});

describe("echo backend", () => {
  it("streams a canned Turkish reply word by word, quoting the user", async () => {
    const backend = createEchoBackend({ firstTokenMs: 1, wordMs: 0 });
    const out = await collect(backend.stream(MESSAGES, { model: "x" }));
    const reply = defaultEchoReply("Merhaba");
    // one chunk per word (the reply is short on purpose, so no minimum count), and the chunks rebuild the reply exactly
    expect(out).toHaveLength(reply.match(/\S+\s*/g)!.length);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((piece) => piece.trim().split(/\s+/).length === 1)).toBe(true);
    expect(out.join("")).toBe(reply);
    expect(out.join("")).toContain('"Merhaba"');
  });

  it("stops with an AbortError when aborted", async () => {
    const abort = new AbortController();
    const backend = createEchoBackend({ firstTokenMs: 1, wordMs: 5 });
    const got: string[] = [];
    const err = await (async () => {
      try {
        for await (const w of backend.stream(MESSAGES, { model: "x", signal: abort.signal })) {
          got.push(w);
          if (got.length === 2) abort.abort();
        }
      } catch (e) {
        return e;
      }
    })();
    expect(got).toHaveLength(2);
    expect((err as Error).name).toBe("AbortError");
  });
});

describe("model list", () => {
  afterEach(() => resetModelCache());

  it("parses OpenRouter's model index", () => {
    const models = parseModels({
      data: [
        { id: "z/model", name: "Z Model", pricing: { prompt: "0.0000025", completion: "0.00001" }, context_length: 128000 },
        { id: "a/model", name: "A Model", pricing: { prompt: "0", completion: "0" } },
        { nope: true },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["a/model", "z/model"]);
    expect(models[1]).toMatchObject({ promptPrice: 2.5, completionPrice: 10, context: 128000 });
  });

  it("fetches the public list (no key) and caches it", async () => {
    const f = mockFetch((url, init) => {
      expect(url).toBe(MODELS_URL);
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      return new Response(JSON.stringify({ data: [{ id: "openai/gpt-4o", name: "GPT-4o" }] }));
    });
    const a = await loadModels(f);
    const b = await loadModels(f);
    expect(a).toEqual({ live: true, models: [expect.objectContaining({ id: "openai/gpt-4o" })] });
    expect(b).toBe(a);
    expect(f).toHaveBeenCalledOnce();
  });

  it("falls back to the built-in list on failure, and retries next time", async () => {
    const fail = mockFetch(() => Promise.reject(new TypeError("offline")));
    expect(await loadModels(fail)).toEqual({ live: false, models: FALLBACK_MODELS });
    const bad = mockFetch(() => new Response("nope", { status: 500 }));
    expect(await loadModels(bad)).toEqual({ live: false, models: FALLBACK_MODELS });
    expect(bad).toHaveBeenCalledOnce();
  });
});
