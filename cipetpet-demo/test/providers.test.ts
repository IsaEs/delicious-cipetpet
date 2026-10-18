// @vitest-environment jsdom
// Chat providers on the page: OpenAI-compatible endpoints in direct mode, the server's providers in proxy mode, the
// model list per provider, the settings that hold them (and their migration), and the direct-mode keys.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDirectBackend } from "../src/llm/direct.ts";
import { loadModelsFrom, resetModelCache } from "../src/llm/models.ts";
import { createProxyBackend } from "../src/llm/proxy.ts";
import { insecureUrl, newProviderId, normalizeBaseUrl } from "../src/llm/providers.ts";
import { ChatError, type ChatMessage } from "../src/llm/types.ts";
import { chatTarget } from "../src/ui/chatTarget.ts";
import { DEFAULT_SETTINGS, loadRememberedKey, sanitizeSettings, useApiKeys, type Settings } from "../src/ui/settings.ts";
import { parseServerConfig, type ServerConfig } from "../src/ui/useServerConfig.ts";
import { collect, enc, sseResponse } from "./helpers.ts";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "Merhaba" }];
const STREAM = enc.encode('data: {"choices":[{"delta":{"content":"Selam"}}]}\n\ndata: [DONE]\n\n');

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init ?? {}));
}

beforeEach(() => localStorage.clear());
afterEach(() => resetModelCache());

describe("provider helpers", () => {
  it("normalizeBaseUrl keeps the API root of what was pasted, and refuses what is not usable", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("  http://localhost:11434/v1/chat/completions ")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("https://api.groq.com/openai/v1/models?x=1#y")).toBe("https://api.groq.com/openai/v1");
    expect(normalizeBaseUrl("ftp://x.example/v1")).toBeNull();
    expect(normalizeBaseUrl("https://user:secret@x.example/v1")).toBeNull();
    expect(normalizeBaseUrl("not a url")).toBeNull();
  });

  it("insecureUrl flags plain http except to this machine", () => {
    expect(insecureUrl("http://gpu.lan:8000/v1")).toBe(true);
    expect(insecureUrl("http://localhost:11434/v1")).toBe(false);
    expect(insecureUrl("http://127.0.0.1:1234/v1")).toBe(false);
    expect(insecureUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("newProviderId makes a short unique id, never 'openrouter'", () => {
    expect(newProviderId("Ollama (local)", [])).toBe("ollama-local");
    expect(newProviderId("Ollama (local)", ["openrouter", "ollama-local"])).toBe("ollama-local-2");
    expect(newProviderId("OpenRouter", ["openrouter"])).toBe("openrouter-2");
    expect(newProviderId("!!!", [])).toBe("custom");
  });
});

describe("direct backend, OpenAI-compatible", () => {
  it("posts to <base>/chat/completions with the key, and without OpenRouter's attribution headers", async () => {
    const f = mockFetch(() => sseResponse([STREAM]));
    const backend = createDirectBackend({ getKey: () => "sk-test", baseUrl: "https://api.openai.com/v1/", kind: "openai", name: "OpenAI", fetch: f });
    expect((await collect(backend.stream(MESSAGES, { model: "gpt-4o-mini" }))).join("")).toBe("Selam");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.has("http-referer")).toBe(false);
    expect(headers.has("x-title")).toBe(false);
    expect(init?.credentials).toBe("omit");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-4o-mini", stream: true });
  });

  it("needs no key (a local server), but does need a model", async () => {
    const f = mockFetch(() => sseResponse([STREAM]));
    const backend = createDirectBackend({ getKey: () => "", baseUrl: "http://localhost:11434/v1", kind: "openai", name: "Ollama", fetch: f });
    await collect(backend.stream(MESSAGES, { model: "llama3.2" }));
    expect(new Headers(f.mock.calls[0][1]?.headers).has("authorization")).toBe(false);
    await expect(collect(backend.stream(MESSAGES, { model: "" }))).rejects.toMatchObject({ code: "not_configured", message: expect.stringContaining("Ollama") });
    expect(f).toHaveBeenCalledOnce();
  });

  it("a failed request hints at CORS (a browser cannot tell it from an unreachable host)", async () => {
    const f = mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const backend = createDirectBackend({ getKey: () => "", baseUrl: "http://localhost:1234/v1", kind: "openai", name: "LM Studio", fetch: f });
    const err = await collect(backend.stream(MESSAGES, { model: "m" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect((err as ChatError).code).toBe("network");
    expect((err as ChatError).message).toMatch(/localhost:1234.*LM Studio.*CORS/);
  });
});

describe("proxy backend with providers", () => {
  it("names the provider in the body when one is chosen, and leaves it out otherwise", async () => {
    let provider = "groq";
    const f = mockFetch(() => sseResponse([STREAM]));
    const backend = createProxyBackend({ fetch: f, getProvider: () => provider });
    await collect(backend.stream(MESSAGES, { model: "llama-3.3-70b" }));
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toMatchObject({ provider: "groq", model: "llama-3.3-70b" });
    provider = "";
    await collect(backend.stream(MESSAGES, { model: "m" }));
    expect(JSON.parse(String(f.mock.calls[1][1]?.body))).not.toHaveProperty("provider");
  });
});

describe("model lists per provider", () => {
  it("a server provider's list comes from /api/models", async () => {
    const f = mockFetch((url) => {
      expect(url).toBe("/api/models?provider=ollama");
      return new Response(JSON.stringify({ data: [{ id: "qwen2.5:7b" }, { id: "llama3.2:3b" }] }));
    });
    const list = await loadModelsFrom({ kind: "proxy", provider: "ollama" }, f);
    expect(list).toEqual({ live: true, models: [{ id: "llama3.2:3b", name: "llama3.2:3b" }, { id: "qwen2.5:7b", name: "qwen2.5:7b" }].map((m) => expect.objectContaining(m)) });
  });

  it("a direct endpoint's list is GET <base>/models with the user's key; a failure says why and is retried", async () => {
    const bad = mockFetch(() => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 }));
    const source = { kind: "direct" as const, baseUrl: "https://api.openai.com/v1", getKey: () => "sk-wrong" };
    expect(await loadModelsFrom(source, bad)).toEqual({ models: [], live: false, error: "HTTP 401: Incorrect API key" });
    expect(bad.mock.calls[0][0]).toBe("https://api.openai.com/v1/models");
    expect(new Headers(bad.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer sk-wrong");
    const good = mockFetch(() => new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] })));
    expect((await loadModelsFrom(source, good)).live).toBe(true);
  });
});

describe("settings", () => {
  it("migrate the single model of older settings to OpenRouter (proxy and direct)", () => {
    const s = sanitizeSettings({ model: "anthropic/claude-3.5-haiku", backend: "direct" });
    expect(s.models).toEqual({ "proxy:openrouter": "anthropic/claude-3.5-haiku", "direct:openrouter": "anthropic/claude-3.5-haiku" });
    expect(s).not.toHaveProperty("model");
    expect(s.directProvider).toBe("openrouter");
    expect(s.ttsModel).toBe("antalia");
  });

  it("keep only usable custom providers and model entries; a missing direct provider falls back to OpenRouter", () => {
    const s = sanitizeSettings({
      customProviders: [
        { id: "groq", name: " Groq ", baseUrl: "https://api.groq.com/openai/v1/" },
        { id: "groq", name: "dupe", baseUrl: "https://x.example/v1" },
        { id: "openrouter", name: "fake", baseUrl: "https://x.example/v1" },
        { id: "bad id", name: "x", baseUrl: "https://x.example/v1" },
        { id: "ftp", name: "x", baseUrl: "ftp://x.example" },
        { id: "noname", baseUrl: "http://localhost:11434/v1" },
      ],
      directProvider: "gone",
      models: { "direct:groq": " llama-3.3-70b ", "evil key": "x", "proxy:openrouter": "" },
      ttsModel: "ema",
    });
    expect(s.customProviders).toEqual([
      { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
      { id: "noname", name: "noname", baseUrl: "http://localhost:11434/v1" },
    ]);
    expect(s.directProvider).toBe("openrouter");
    expect(s.models).toEqual({ "direct:groq": "llama-3.3-70b" });
    expect(s.ttsModel).toBe("ema");
    expect(sanitizeSettings({ directProvider: "groq", customProviders: s.customProviders }).directProvider).toBe("groq");
  });
});

describe("/api/config and the chat target", () => {
  it("parseServerConfig reads the providers; a server from before providers meant OpenRouter", () => {
    expect(parseServerConfig({ proxy: true, defaultModel: "openai/gpt-4o", packs: {} })).toMatchObject({
      proxy: true,
      provider: "openrouter",
      providers: [{ id: "openrouter", name: "OpenRouter", kind: "openrouter", defaultModel: "openai/gpt-4o" }],
    });
    const cfg = parseServerConfig({
      proxy: true,
      defaultModel: "",
      provider: "lm",
      providers: [{ id: "ollama", name: "Ollama", kind: "openai", defaultModel: "llama3.2" }, { id: "lm", kind: "openai" }, { id: "BAD" }, "x"],
    });
    expect(cfg.providers).toEqual([
      { id: "ollama", name: "Ollama", kind: "openai", defaultModel: "llama3.2" },
      { id: "lm", name: "lm", kind: "openai", defaultModel: "" },
    ]);
    expect(cfg.provider).toBe("lm");
    expect(parseServerConfig({ proxy: false, providers: [] })).toMatchObject({ proxy: false, provider: null, providers: [] });
  });

  const server: ServerConfig = {
    loaded: true,
    proxy: true,
    defaultModel: "openai/gpt-4o",
    provider: "openrouter",
    providers: [
      { id: "openrouter", name: "OpenRouter", kind: "openrouter", defaultModel: "openai/gpt-4o" },
      { id: "ollama", name: "Ollama", kind: "openai", defaultModel: "llama3.2" },
    ],
    packs: {},
  };
  const settings = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

  it("proxy: the chosen server provider (else the server's default) and its model", () => {
    expect(chatTarget(settings({}), server)).toMatchObject({ backend: "proxy", providerId: "openrouter", model: "openai/gpt-4o", modelKey: "proxy:openrouter" });
    expect(chatTarget(settings({ proxyProvider: "ollama" }), server)).toMatchObject({ providerId: "ollama", kind: "openai", model: "llama3.2" });
    expect(chatTarget(settings({ proxyProvider: "ollama", models: { "proxy:ollama": "qwen2.5:7b" } }), server).model).toBe("qwen2.5:7b");
    expect(chatTarget(settings({ proxyProvider: "removed" }), server).providerId).toBe("openrouter");
  });

  it("direct: OpenRouter or a custom endpoint; echo when the server has nothing and the user chose nothing", () => {
    const custom = { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" };
    const t = chatTarget(settings({ backend: "direct", directProvider: "groq", customProviders: [custom] }), server);
    expect(t).toMatchObject({ backend: "direct", providerId: "groq", kind: "openai", defaultModel: "", model: "", direct: { baseUrl: custom.baseUrl } });
    expect(chatTarget(settings({ backend: "direct" }), server)).toMatchObject({ providerId: "openrouter", model: "openai/gpt-4o" });
    expect(chatTarget(settings({}), { ...server, proxy: false, provider: null, providers: [] })).toMatchObject({ backend: "echo", model: "" });
  });
});

describe("direct-mode keys", () => {
  it("are kept per provider, in memory unless remembered; the OpenRouter key keeps its old storage name", () => {
    localStorage.setItem("cipetpet-demo:openrouter-key", "sk-or-old");
    const { result } = renderHook(() => useApiKeys());
    expect(result.current.get("openrouter")).toBe("sk-or-old");
    expect(result.current.remembered("openrouter")).toBe(true);

    act(() => result.current.set("groq", "gsk-1"));
    expect(result.current.get("groq")).toBe("gsk-1");
    expect(loadRememberedKey("groq")).toBe("");
    act(() => result.current.setRemember("groq", true));
    expect(localStorage.getItem("cipetpet-demo:key:groq")).toBe("gsk-1");

    act(() => result.current.forget("groq"));
    expect(result.current.get("groq")).toBe("");
    expect(localStorage.getItem("cipetpet-demo:key:groq")).toBeNull();
    expect(result.current.get("openrouter")).toBe("sk-or-old");
  });
});
