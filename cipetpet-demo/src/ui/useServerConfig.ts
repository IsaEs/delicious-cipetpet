import { useEffect, useState } from "react";

export interface ServerConfig {
  loaded: boolean;
  /** the server holds an OpenRouter key: /api/chat works */
  proxy: boolean;
  defaultModel: string;
  /** "sha256-<base64>" of each pack file the server has a current manifest entry for */
  packs: Record<string, string>;
}

export const FALLBACK_MODEL = "openai/gpt-4o";

function packDigests(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object") {
    for (const [file, digest] of Object.entries(value)) if (typeof digest === "string" && /^sha256-/.test(digest)) out[file] = digest;
  }
  return out;
}

/** GET /api/config; without the demo server (static hosting) the proxy is simply off */
export function useServerConfig(): ServerConfig {
  const [config, setConfig] = useState<ServerConfig>({ loaded: false, proxy: false, defaultModel: FALLBACK_MODEL, packs: {} });
  useEffect(() => {
    const abort = new AbortController();
    let timedOut = false;
    // the page waits for this answer before it starts the model downloads: do not wait for ever
    const timer = setTimeout(() => ((timedOut = true), abort.abort()), 4000);
    fetch("/api/config", { signal: abort.signal, headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { proxy?: unknown; defaultModel?: unknown; packs?: unknown }) =>
        setConfig({
          loaded: true,
          proxy: j.proxy === true,
          defaultModel: typeof j.defaultModel === "string" && j.defaultModel ? j.defaultModel : FALLBACK_MODEL,
          packs: packDigests(j.packs),
        }),
      )
      .catch(() => {
        if (!abort.signal.aborted || timedOut) setConfig({ loaded: true, proxy: false, defaultModel: FALLBACK_MODEL, packs: {} });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, []);
  return config;
}
