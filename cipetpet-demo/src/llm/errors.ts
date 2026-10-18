// Turns an upstream failure (non-2xx response, or an error event in the middle of a stream) into a ChatError
// with a short, actionable message.

import { ChatError, type ChatErrorCode } from "./types.ts";

/** pulls a human message out of the usual error shapes: {error: {message}}, {error: "..."}, {message} */
export function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" && body.trim() ? body.trim() : undefined;
  const o = body as { error?: unknown; message?: unknown };
  if (typeof o.error === "string") return o.error;
  if (o.error && typeof o.error === "object") {
    const m = (o.error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  if (typeof o.message === "string") return o.message;
  return undefined;
}

function codeFor(status: number): ChatErrorCode {
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 402) return "credits";
  if (status === 429) return "rate_limited";
  if (status === 503) return "not_configured";
  if (status === 400 || status === 404 || status === 413 || status === 415 || status === 422) return "bad_request";
  return "upstream";
}

const LEAD: Record<ChatErrorCode, string> = {
  invalid_key: "OpenRouter rejected the request: invalid API key",
  credits: "OpenRouter: not enough credits for this request (402)",
  rate_limited: "OpenRouter: rate limited (429), wait a moment and try again",
  not_configured: "The chat proxy is not available",
  bad_request: "The request was rejected",
  moderation: "The request was flagged by moderation",
  upstream: "The model provider returned an error",
  network: "Network error",
  stream: "The reply stream failed",
};

/** Builds the error for a non-2xx response. Reads (and so consumes) the body. */
export async function errorFromResponse(res: Response): Promise<ChatError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // body unavailable; the status alone has to do
  }
  let detail: string | undefined;
  try {
    detail = extractErrorMessage(JSON.parse(text));
  } catch {
    detail = text.trim().slice(0, 300) || undefined;
  }
  const code = codeFor(res.status);
  // 503 from our own proxy carries the full explanation ("set OPENROUTER_API_KEY ..."): show it as is
  const message =
    code === "not_configured" && detail
      ? detail
      : `${LEAD[code]}${code === "invalid_key" ? ` (${res.status})` : ""}${detail && !LEAD[code].includes(detail) ? `: ${detail}` : ""}`;
  return new ChatError(message, code, res.status);
}

/** Builds the error for an `{error: {...}}` payload received mid-stream. */
export function errorFromPayload(payload: unknown): ChatError {
  const err = (payload as { error?: { code?: unknown } }).error;
  const raw = err && typeof err === "object" ? err.code : undefined;
  const status = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  const code: ChatErrorCode = Number.isFinite(status) ? codeFor(status) : "stream";
  const detail = extractErrorMessage(payload) ?? "unknown error";
  return new ChatError(`${LEAD[code === "upstream" ? "stream" : code]}: ${detail}`, code, Number.isFinite(status) ? status : undefined);
}

export function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

export function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}
