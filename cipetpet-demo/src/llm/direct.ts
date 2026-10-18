// "direct" backend: the browser calls the provider itself with a key the user pasted into Settings: OpenRouter, or
// any OpenAI-compatible API (OpenAI, Groq, a local Ollama / LM Studio ...). Simple, but the key lives in this browser
// (memory, or localStorage if the user ticked "remember"), so any script running on the page could read it. The
// proxy backend is the safe default. The provider must allow cross-origin requests from this page (CORS); OpenRouter
// and most hosted APIs do, local servers often need it switched on (OLLAMA_ORIGINS, LM Studio's CORS toggle).

import { chatDeltas } from "./sse.ts";
import { requestBody, send } from "./proxy.ts";
import { OPENROUTER_API, type ProviderKind } from "./providers.ts";
import { ChatError, type ChatBackend } from "./types.ts";

export { OPENROUTER_API } from "./providers.ts";

export interface DirectBackendOptions {
  /** returns the current key (read on every request, so Settings changes apply at once) */
  getKey: () => string;
  /** default https://openrouter.ai/api/v1 */
  baseUrl?: string;
  /** "openrouter" (default): a key is required and the app attribution headers are sent. "openai": any
   * OpenAI-compatible API; the key is optional (local servers) and no extra headers are sent, since a header the
   * server does not list in Access-Control-Allow-Headers would fail the CORS preflight. */
  kind?: ProviderKind;
  /** for error messages; default "OpenRouter" / the base URL's host */
  name?: string;
  /** HTTP-Referer / X-Title attribution (OpenRouter only); default location.origin / "cipetpet demo" */
  siteUrl?: string;
  appName?: string;
  fetch?: typeof fetch;
}

export function createDirectBackend(options: DirectBackendOptions): ChatBackend {
  const base = (options.baseUrl ?? OPENROUTER_API).replace(/\/+$/, "");
  const kind = options.kind ?? "openrouter";
  const name = options.name ?? (kind === "openrouter" ? "OpenRouter" : hostOf(base));
  return {
    kind: "direct",
    async *stream(messages, opts) {
      const key = options.getKey().trim();
      if (!key && kind === "openrouter") throw new ChatError("No OpenRouter API key: paste one in Settings, or use the proxy / echo mode", "invalid_key");
      if (!opts.model) throw new ChatError(`No model chosen for ${name}: pick one in Settings`, "not_configured");
      const f = options.fetch ?? globalThis.fetch.bind(globalThis);
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
      if (key) headers.Authorization = `Bearer ${key}`;
      if (kind === "openrouter") {
        const siteUrl = options.siteUrl ?? globalThis.location?.origin;
        if (siteUrl) headers["HTTP-Referer"] = siteUrl;
        headers["X-Title"] = options.appName ?? "cipetpet demo";
      }
      let res: Response;
      try {
        res = await send(f, `${base}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody(messages, opts)),
          signal: opts.signal,
          // no cookies, no referrer beyond the explicit header
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
      } catch (e) {
        // a browser reports a CORS refusal exactly like an unreachable host
        if (e instanceof ChatError && e.code === "network" && kind === "openai") {
          throw new ChatError(`${e.message}. If ${name} is running, it may not allow requests from this page (CORS)`, "network");
        }
        throw e;
      }
      yield* chatDeltas(res, opts.signal);
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
