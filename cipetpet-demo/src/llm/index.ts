export type { BackendKind, ChatBackend, ChatErrorCode, ChatMessage, ChatRole, ChatStreamOptions } from "./types.ts";
export { ChatError } from "./types.ts";
export { createProxyBackend } from "./proxy.ts";
export { createDirectBackend, OPENROUTER_API } from "./direct.ts";
export { createEchoBackend } from "./echo.ts";
export { chatDeltas, readSse, SseParser } from "./sse.ts";
export { isAbortError } from "./errors.ts";
export { FALLBACK_MODELS, loadModels, type ModelOption } from "./models.ts";
