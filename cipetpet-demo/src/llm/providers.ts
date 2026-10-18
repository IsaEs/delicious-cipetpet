// Chat providers. Every one speaks the OpenAI chat completions API (POST <base>/chat/completions with SSE,
// GET <base>/models); they differ in where the key lives:
//
// * server providers: what the demo server proxies (OpenRouter and the LLM_PROVIDERS of its .env.local), listed by
//   /api/config; the key stays on the server.
// * direct providers: the browser calls the API itself with a key typed into Settings: OpenRouter, or an
//   OpenAI-compatible endpoint the user added (OpenAI, Groq, a local Ollama / LM Studio ...). Its key is kept like
//   the OpenRouter key (memory, or localStorage when "remember" is ticked), never in the settings object.

export type ProviderKind = "openrouter" | "openai";

/** A provider of the demo server, as /api/config describes it (no key, no URL). */
export interface ServerProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  /** "" when the server has none: the page has to pick a model */
  defaultModel: string;
}

/** An OpenAI-compatible endpoint the user added for direct mode. */
export interface CustomProvider {
  id: string;
  name: string;
  /** the API root, e.g. https://api.openai.com/v1 (no trailing slash) */
  baseUrl: string;
}

export const OPENROUTER_ID = "openrouter";
export const OPENROUTER_API = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_MODEL = "openai/gpt-4o";

/** Where a direct request goes, and what the UI needs to know about it. */
export interface DirectProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** OpenRouter's default model; a custom endpoint has none */
  defaultModel: string;
}

export const OPENROUTER_DIRECT: DirectProvider = {
  id: OPENROUTER_ID,
  name: "OpenRouter",
  kind: "openrouter",
  baseUrl: OPENROUTER_API,
  defaultModel: OPENROUTER_DEFAULT_MODEL,
};

/** The direct providers: OpenRouter first, then the user's own endpoints. */
export function directProviders(custom: readonly CustomProvider[]): DirectProvider[] {
  return [OPENROUTER_DIRECT, ...custom.map((c): DirectProvider => ({ id: c.id, name: c.name, kind: "openai", baseUrl: c.baseUrl, defaultModel: "" }))];
}

/**
 * The API root of what the user pasted: http(s) only, no credentials, query or fragment, no trailing slash, and
 * without a pasted "/chat/completions" or "/models" endpoint at the end. null when it is not usable.
 */
export function normalizeBaseUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null; // a key belongs in the key field, not in a URL that ends up in settings
  const path = u.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|completions|models)$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** true for a plain-http URL to anything but this machine: the key would cross the network unencrypted */
export function insecureUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** a short id for a new custom provider, unique among `taken` */
export function newProviderId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "custom";
  let id = base === OPENROUTER_ID ? `${base}-2` : base;
  for (let n = 2; used.has(id) || id === OPENROUTER_ID; n++) id = `${base}-${n}`;
  return id;
}

/** the key of a provider in the per-provider model map: "proxy:<id>" or "direct:<id>" */
export const modelKey = (mode: "proxy" | "direct", id: string): string => `${mode}:${id}`;
