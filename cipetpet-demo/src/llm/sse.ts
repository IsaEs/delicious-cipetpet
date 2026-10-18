// Server-sent events, as OpenAI-compatible chat APIs (OpenRouter) stream them.
//
// Robust against everything a network hands over: chunks split at any byte (also inside a multi-byte UTF-8
// character: the TextDecoder runs in stream mode), CRLF / CR / LF line ends (a CR at the end of a chunk waits
// for the next one, in case an LF follows), several events per chunk, comment / keep-alive lines
// (": OPENROUTER PROCESSING"), multi-line data, "data: [DONE]", and error payloads in the middle of the
// stream ({error: {message, code}}), which become a thrown ChatError.

import { abortError, errorFromPayload, errorFromResponse } from "./errors.ts";
import { ChatError } from "./types.ts";

export interface SseEvent {
  /** "message" unless the stream named it */
  event: string;
  data: string;
  id?: string;
}

/** Incremental, line-based SSE parser (WHATWG "event stream interpretation"). Feed it decoded text. */
export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;

  /** returns the events completed by this piece of text */
  feed(text: string): SseEvent[] {
    this.buf += text;
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      if (c === 13 && i === this.buf.length - 1) break; // lone CR at the end: an LF may follow in the next chunk
      this.line(this.buf.slice(start, i), out);
      if (c === 13 && this.buf.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** end of stream: a final event without its blank line still counts */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) this.line(this.buf.replace(/\r$/, ""), out);
    this.buf = "";
    this.line("", out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.data.length > 0) out.push({ event: this.event || "message", data: this.data.join("\n"), ...(this.id !== undefined ? { id: this.id } : {}) });
      this.data = [];
      this.event = "";
      return;
    }
    if (line.charCodeAt(0) === 58) return; // ":" comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    // "retry" and unknown fields are ignored
  }
}

/** Reads a byte stream as SSE events. Cancels the stream when `signal` aborts (and throws an AbortError). */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw abortError();
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      yield* parser.feed(decoder.decode(value, { stream: true }));
    }
    yield* parser.feed(decoder.decode());
    yield* parser.end();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // stops the network read when the consumer leaves early (break / return / throw)
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

interface ChatChunk {
  error?: unknown;
  choices?: { delta?: { content?: unknown }; message?: { content?: unknown }; finish_reason?: unknown }[];
}

/** text content of one chat-completion chunk; throws on an error payload */
export function chunkText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as ChatChunk;
  if (p.error) throw errorFromPayload(p);
  const choice = p.choices?.[0];
  if (!choice) return "";
  const content = choice.delta?.content ?? choice.message?.content;
  if (choice.finish_reason === "error" && !content) throw new ChatError("The reply stream failed: the provider ended it with an error", "stream");
  return typeof content === "string" ? content : "";
}

/**
 * The text deltas of a chat-completions response: an SSE stream, or (for a backend that ignored
 * `stream: true`) one JSON body. Non-2xx responses throw a ChatError carrying the upstream message.
 */
export async function* chatDeltas(res: Response, signal?: AbortSignal): AsyncGenerator<string, void, undefined> {
  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body) throw new ChatError("The reply stream failed: empty response", "stream", res.status);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const text = chunkText(await res.json());
    if (text) yield text;
    return;
  }
  for await (const ev of readSse(res.body, signal)) {
    const data = ev.data.trim();
    if (data === "[DONE]") return;
    if (!data) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      continue; // not JSON: a provider's keep-alive or debug line; nothing to show
    }
    const text = chunkText(payload);
    if (text) yield text;
  }
}
