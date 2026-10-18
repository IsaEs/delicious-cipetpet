// "direct" backend: the browser calls openrouter.ai itself with a key the user pasted into Settings. Simple,
// but the key lives in this browser (memory, or localStorage if the user ticked "remember"), so any script
// running on the page could read it. The proxy backend is the safe default.

import { chatDeltas } from "./sse.ts";
import { requestBody, send } from "./proxy.ts";
import { ChatError, type ChatBackend } from "./types.ts";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";

export interface DirectBackendOptions {
  /** returns the current key (read on every request, so Settings changes apply at once) */
  getKey: () => string;
  /** default https://openrouter.ai/api/v1 */
  baseUrl?: string;
  /** HTTP-Referer / X-Title attribution; default location.origin / "cipetpet demo" */
  siteUrl?: string;
  appName?: string;
  fetch?: typeof fetch;
}

export function createDirectBackend(options: DirectBackendOptions): ChatBackend {
  const base = (options.baseUrl ?? OPENROUTER_API).replace(/\/+$/, "");
  return {
    kind: "direct",
    async *stream(messages, opts) {
      const key = options.getKey().trim();
      if (!key) throw new ChatError("No OpenRouter API key: paste one in Settings, or use the proxy / echo mode", "invalid_key");
      const f = options.fetch ?? globalThis.fetch.bind(globalThis);
      const siteUrl = options.siteUrl ?? globalThis.location?.origin;
      const res = await send(f, `${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(siteUrl ? { "HTTP-Referer": siteUrl } : {}),
          "X-Title": options.appName ?? "cipetpet demo",
        },
        body: JSON.stringify(requestBody(messages, opts)),
        signal: opts.signal,
        // no cookies, no referrer beyond the explicit header
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      yield* chatDeltas(res, opts.signal);
    },
  };
}
