// The chat backend contract shared by the proxy, direct and echo implementations.

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatStreamOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  signal?: AbortSignal;
}

/** Streams the assistant's reply as text deltas (in order; concatenated they are the whole reply). */
export interface ChatBackend {
  readonly kind: BackendKind;
  stream(messages: ChatMessage[], opts: ChatStreamOptions): AsyncGenerator<string, void, undefined>;
}

export type BackendKind = "proxy" | "direct" | "echo";

/** What went wrong, so the UI can show a localised message; `message` is always a readable English fallback. */
export type ChatErrorCode =
  | "invalid_key"
  | "credits"
  | "rate_limited"
  | "not_configured"
  | "bad_request"
  | "moderation"
  | "upstream"
  | "network"
  | "stream";

export class ChatError extends Error {
  override readonly name = "ChatError";
  constructor(
    message: string,
    readonly code: ChatErrorCode,
    readonly status?: number,
  ) {
    super(message);
  }
}
