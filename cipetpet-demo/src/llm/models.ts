// The model picker's list: OpenRouter's public model index (no key needed), fetched only when the user opens
// the picker, with a short built-in list when that fails (offline, blocked, slow).

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
  /** false when the built-in fallback is shown */
  live: boolean;
}

let cached: Promise<ModelList> | undefined;

/** Fetches the list once per page (failures are not cached, so reopening the picker retries). */
export function loadModels(f: typeof fetch = globalThis.fetch.bind(globalThis), timeoutMs = 8000): Promise<ModelList> {
  cached ??= (async () => {
    try {
      const res = await f(MODELS_URL, { signal: AbortSignal.timeout(timeoutMs), credentials: "omit", referrerPolicy: "no-referrer" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const models = parseModels(await res.json());
      if (models.length === 0) throw new Error("empty list");
      return { models, live: true };
    } catch {
      cached = undefined;
      return { models: FALLBACK_MODELS, live: false };
    }
  })();
  return cached;
}

/** for tests */
export function resetModelCache(): void {
  cached = undefined;
}
