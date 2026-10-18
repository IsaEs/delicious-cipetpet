// "proxy" backend: the browser posts to this demo's own server (/api/chat), which adds the OpenRouter key
// server-side and streams the reply back. The key never reaches the page.

import { abortError, isAbortError } from "./errors.ts";
import { chatDeltas } from "./sse.ts";
import { ChatError, type ChatBackend, type ChatMessage, type ChatStreamOptions } from "./types.ts";

export interface ProxyBackendOptions {
  /** default "/api/chat" */
  endpoint?: string;
  fetch?: typeof fetch;
}

export function requestBody(messages: ChatMessage[], opts: ChatStreamOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { model: opts.model, messages, stream: true };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.topP !== undefined) body.top_p = opts.topP;
  return body;
}

/** fetch() that maps network failures to ChatError("network") and keeps AbortErrors as they are */
export async function send(f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await f(url, init);
  } catch (e) {
    if (isAbortError(e) || init.signal?.aborted) throw abortError();
    const where = /^https?:/i.test(url) ? new URL(url).host : "the demo server";
    throw new ChatError(`Network error: could not reach ${where} (${(e as Error).message})`, "network");
  }
}

export function createProxyBackend(options: ProxyBackendOptions = {}): ChatBackend {
  const endpoint = options.endpoint ?? "/api/chat";
  return {
    kind: "proxy",
    async *stream(messages, opts) {
      const f = options.fetch ?? globalThis.fetch.bind(globalThis);
      const res = await send(f, endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(requestBody(messages, opts)),
        signal: opts.signal,
      });
      yield* chatDeltas(res, opts.signal);
    },
  };
}
