// The chat providers the /api/chat proxy can reach, read from the environment. Every provider speaks the OpenAI
// chat completions API (POST <base>/chat/completions, SSE when stream: true; GET <base>/models):
//
//   OpenRouter                OPENROUTER_API_KEY (+ OPENROUTER_MODEL, OPENROUTER_SITE_URL, OPENROUTER_APP_NAME,
//                             OPENROUTER_UPSTREAM for tests)                                   -> id "openrouter"
//   any OpenAI-compatible     LLM_PROVIDERS=openai,ollama  and for each id:
//   endpoint                    LLM_<ID>_BASE_URL   e.g. https://api.openai.com/v1, http://127.0.0.1:11434/v1  (required)
//                               LLM_<ID>_API_KEY    sent as "Authorization: Bearer"; leave it out for local servers
//                               LLM_<ID>_MODEL      the model used when the page does not pick one
//                               LLM_<ID>_NAME       shown in the page (default: the id)
//                             (<ID> is the id in capitals, "-" as "_": LLM_PROVIDERS=lm-studio -> LLM_LM_STUDIO_BASE_URL)
//   LLM_DEFAULT_PROVIDER=<id> the provider the page uses until the user picks one (default: the first one)

export const OPENROUTER_ID = "openrouter";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o";
export const DEFAULT_OPENROUTER_UPSTREAM = "https://openrouter.ai/api/v1";
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   kind: "openrouter" | "openai",
 *   baseUrl: string,
 *   apiKey: string,
 *   defaultModel: string,
 * }} Provider
 */

/** `<id>_X` env prefix of a provider id */
export const envPrefix = (id) => `LLM_${id.toUpperCase().replace(/-/g, "_")}_`;

/** the base URL without credentials, query or trailing slash, for logs and the page */
export function displayUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "(invalid URL)";
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} [log] warnings
 * @returns {{ providers: Provider[], defaultId: string | null }}
 */
export function providersFromEnv(env, log = () => {}) {
  const get = (k) => (env[k] ?? "").trim();
  /** @type {Provider[]} */
  const providers = [];

  /** checks a base URL; null (and a warning) when it is unusable */
  const checkUrl = (raw, what, hasKey) => {
    let u;
    try {
      u = new URL(raw);
    } catch {
      log(`warning: ${what} is not a valid URL; ignored`);
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      log(`warning: ${what} must be an http(s) URL; ignored`);
      return null;
    }
    if (u.protocol !== "https:" && !LOOPBACK.has(u.hostname) && hasKey) {
      log(`warning: ${what} ${u.origin} is not https: the API key is sent to it as is`);
    }
    return raw.replace(/\/+$/, "");
  };

  const openrouterKey = get("OPENROUTER_API_KEY");
  if (openrouterKey) {
    const baseUrl = checkUrl(get("OPENROUTER_UPSTREAM") || DEFAULT_OPENROUTER_UPSTREAM, "OPENROUTER_UPSTREAM", true);
    if (baseUrl) {
      providers.push({ id: OPENROUTER_ID, name: "OpenRouter", kind: "openrouter", baseUrl, apiKey: openrouterKey, defaultModel: get("OPENROUTER_MODEL") || DEFAULT_OPENROUTER_MODEL });
    }
  }

  const ids = get("LLM_PROVIDERS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const id of ids) {
    if (!ID.test(id)) {
      log(`warning: LLM_PROVIDERS: "${id}" is not a valid id (a-z, 0-9, "-", "_", at most 32 characters); ignored`);
      continue;
    }
    if (providers.some((p) => p.id === id)) {
      log(`warning: LLM_PROVIDERS: "${id}" is listed twice (or clashes with the OpenRouter key); the first one is used`);
      continue;
    }
    const pre = envPrefix(id);
    const rawUrl = get(`${pre}BASE_URL`);
    if (!rawUrl) {
      log(`warning: LLM_PROVIDERS lists "${id}" but ${pre}BASE_URL is not set; ignored`);
      continue;
    }
    const apiKey = get(`${pre}API_KEY`);
    const baseUrl = checkUrl(rawUrl, `${pre}BASE_URL`, apiKey !== "");
    if (!baseUrl) continue;
    const defaultModel = get(`${pre}MODEL`);
    if (!defaultModel) log(`warning: ${pre}MODEL is not set: the page has to pick a model for "${id}"`);
    providers.push({ id, name: get(`${pre}NAME`).slice(0, 60) || id, kind: "openai", baseUrl, apiKey, defaultModel });
  }

  let defaultId = providers[0]?.id ?? null;
  const wanted = get("LLM_DEFAULT_PROVIDER").toLowerCase();
  if (wanted) {
    if (providers.some((p) => p.id === wanted)) defaultId = wanted;
    else log(`warning: LLM_DEFAULT_PROVIDER "${wanted}" is not a configured provider; using ${defaultId ?? "none"}`);
  }
  return { providers, defaultId };
}

/** what /api/config tells the page about a provider: never the key or the URL's credentials */
export function publicProvider(p) {
  return { id: p.id, name: p.name, kind: p.kind, defaultModel: p.defaultModel };
}
