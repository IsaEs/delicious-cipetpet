// The model picker's list, fetched only when the user opens the picker:
// * OpenRouter: its public model index (no key needed), with a short built-in list when that fails;
// * a provider of the demo server: GET /api/models?provider=<id> (the server asks the provider with its key);
// * a direct OpenAI-compatible endpoint: GET <base>/models with the user's key.
// Every one is the OpenAI {data: [{id, ...}]} shape; OpenRouter's entries also carry names and prices.

import { extractErrorMessage } from "./errors.ts";

export interface ModelOption {
  id: string;
  name: string;
  /** USD per million prompt / completion tokens, when known */
  promptPrice?: number;
  completionPrice?: number;
  context?: number;
}

export const FALLBACK_MODELS: ModelOption[] = [
  { id: "openai/gpt-4o", name: "OpenAI: GPT-4o" },
  { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o mini" },
  { id: "anthropic/claude-3.5-haiku", name: "Anthropic: Claude 3.5 Haiku" },
  { id: "google/gemini-2.0-flash-001", name: "Google: Gemini 2.0 Flash" },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Meta: Llama 3.3 70B Instruct" },
  { id: "mistralai/mistral-small-3.1-24b-instruct", name: "Mistral: Mistral Small 3.1" },
];

export const MODELS_URL = "https://openrouter.ai/api/v1/models";

function perMillion(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? Math.round(n * 1e6 * 1000) / 1000 : undefined;
}

/** parses OpenRouter's {data: [{id, name, pricing: {prompt, completion}, context_length}]} */
export function parseModels(json: unknown): ModelOption[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("unexpected model list format");
  const out: ModelOption[] = [];
  for (const m of data) {
    if (!m || typeof m !== "object" || typeof (m as { id?: unknown }).id !== "string") continue;
    const o = m as { id: string; name?: unknown; pricing?: { prompt?: unknown; completion?: unknown }; context_length?: unknown };
    out.push({
      id: o.id,
      name: typeof o.name === "string" ? o.name : o.id,
      promptPrice: perMillion(o.pricing?.prompt),
      completionPrice: perMillion(o.pricing?.completion),
      context: typeof o.context_length === "number" ? o.context_length : undefined,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface ModelList {
  models: ModelOption[];
  /** false when the list could not be fetched (OpenRouter: the built-in fallback is shown, others: none) */
  live: boolean;
  /** why it could not be fetched */
  error?: string;
}

/** Where a model list comes from. */
export type ModelSource =
  | { kind: "openrouter" }
  | { kind: "proxy"; provider: string }
  | { kind: "direct"; baseUrl: string; getKey: () => string };

const cached = new Map<string, Promise<ModelList>>();

const sourceKey = (s: ModelSource): string => (s.kind === "openrouter" ? "openrouter" : s.kind === "proxy" ? `proxy:${s.provider}` : `direct:${s.baseUrl}`);

/** Fetches OpenRouter's public list once per page (failures are not cached, so reopening the picker retries). */
export function loadModels(f: typeof fetch = globalThis.fetch.bind(globalThis), timeoutMs = 8000): Promise<ModelList> {
  return loadModelsFrom({ kind: "openrouter" }, f, timeoutMs);
}

/** Fetches a source's list once per page; a failure is not cached. */
export function loadModelsFrom(source: ModelSource, f: typeof fetch = globalThis.fetch.bind(globalThis), timeoutMs = 8000): Promise<ModelList> {
  const key = sourceKey(source);
  let list = cached.get(key);
  if (!list) {
    list = fetchList(source, f, timeoutMs).catch((e: unknown) => {
      cached.delete(key);
      const error = e instanceof Error ? e.message : String(e);
      return source.kind === "openrouter" ? { models: FALLBACK_MODELS, live: false } : { models: [], live: false, error };
    });
    cached.set(key, list);
  }
  return list;
}

async function fetchList(source: ModelSource, f: typeof fetch, timeoutMs: number): Promise<ModelList> {
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  if (source.kind === "openrouter") {
    res = await f(MODELS_URL, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  } else if (source.kind === "proxy") {
    res = await f(`/api/models?provider=${encodeURIComponent(source.provider)}`, { signal, headers: { Accept: "application/json" } });
  } else {
    const key = source.getKey().trim();
    res = await f(`${source.baseUrl}/models`, {
      signal,
      headers: key ? { Accept: "application/json", Authorization: `Bearer ${key}` } : { Accept: "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = extractErrorMessage(JSON.parse(await res.text())) ?? "";
    } catch {
      // no readable body
    }
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const models = parseModels(await res.json());
  if (models.length === 0) throw new Error("empty list");
  return { models, live: true };
}

/** for tests */
export function resetModelCache(): void {
  cached.clear();
}
