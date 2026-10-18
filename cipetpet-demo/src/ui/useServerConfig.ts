import { useEffect, useState } from "react";
import { OPENROUTER_DEFAULT_MODEL, OPENROUTER_ID, type ServerProvider } from "../llm/providers.ts";

export interface ServerConfig {
  loaded: boolean;
  /** the server has at least one chat provider: /api/chat works */
  proxy: boolean;
  /** the default provider's default model ("" when it has none) */
  defaultModel: string;
  /** the server's default provider (null without one) */
  provider: string | null;
  /** what /api/chat can reach: OpenRouter and the OpenAI-compatible APIs of the server's .env.local */
  providers: ServerProvider[];
  /** "sha256-<base64>" of each pack file the server has a current manifest entry for */
  packs: Record<string, string>;
}

export const FALLBACK_MODEL = OPENROUTER_DEFAULT_MODEL;

const NO_SERVER: Omit<ServerConfig, "loaded"> = { proxy: false, defaultModel: FALLBACK_MODEL, provider: null, providers: [], packs: {} };

function packDigests(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object") {
    for (const [file, digest] of Object.entries(value)) if (typeof digest === "string" && /^sha256-/.test(digest)) out[file] = digest;
  }
  return out;
}

function providerList(value: unknown): ServerProvider[] {
  if (!Array.isArray(value)) return [];
  const out: ServerProvider[] = [];
  for (const p of value) {
    if (!p || typeof p !== "object") continue;
    const { id, name, kind, defaultModel } = p as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id) || out.some((o) => o.id === id)) continue;
    out.push({
      id,
      name: typeof name === "string" && name ? name.slice(0, 60) : id,
      kind: kind === "openrouter" ? "openrouter" : "openai",
      defaultModel: typeof defaultModel === "string" ? defaultModel.slice(0, 200) : "",
    });
  }
  return out;
}

/** /api/config's answer, checked field by field. A server from before providers only said proxy + defaultModel:
 * that was OpenRouter. */
export function parseServerConfig(j: { proxy?: unknown; defaultModel?: unknown; provider?: unknown; providers?: unknown; packs?: unknown }): Omit<ServerConfig, "loaded"> {
  const proxy = j.proxy === true;
  const defaultModel = typeof j.defaultModel === "string" ? j.defaultModel : FALLBACK_MODEL;
  let providers = providerList(j.providers);
  if (proxy && providers.length === 0 && j.providers === undefined) {
    providers = [{ id: OPENROUTER_ID, name: "OpenRouter", kind: "openrouter", defaultModel: defaultModel || FALLBACK_MODEL }];
  }
  const provider = typeof j.provider === "string" && providers.some((p) => p.id === j.provider) ? j.provider : (providers[0]?.id ?? null);
  return { proxy: proxy && providers.length > 0, defaultModel, provider, providers, packs: packDigests(j.packs) };
}

/** GET /api/config; without the demo server (static hosting) the proxy is simply off */
export function useServerConfig(): ServerConfig {
  const [config, setConfig] = useState<ServerConfig>({ loaded: false, ...NO_SERVER });
  useEffect(() => {
    const abort = new AbortController();
    let timedOut = false;
    // the page waits for this answer before it starts the model downloads: do not wait for ever
    const timer = setTimeout(() => ((timedOut = true), abort.abort()), 4000);
    fetch("/api/config", { signal: abort.signal, headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: Parameters<typeof parseServerConfig>[0]) => setConfig({ loaded: true, ...parseServerConfig(j) }))
      .catch(() => {
        if (!abort.signal.aborted || timedOut) setConfig({ loaded: true, ...NO_SERVER });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, []);
  return config;
}
