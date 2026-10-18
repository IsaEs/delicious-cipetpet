// "echo" backend: an offline stand-in for the LLM. It streams a canned Turkish reply word by word, so the
// whole voice loop (speak -> transcribe -> "think" -> speak back) can be tried without any key or network.

import { abortError } from "./errors.ts";
import type { ChatBackend } from "./types.ts";

export interface EchoBackendOptions {
  /** delay before the first word (default 350 ms) and between words (default 45 ms) */
  firstTokenMs?: number;
  wordMs?: number;
  /** a custom reply, for tests */
  reply?: (lastUserText: string) => string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** keeps the echoed text short and speakable */
function quote(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > 120 ? `${t.slice(0, 117).replace(/\s+\S*$/, "")}…` : t;
}

export function defaultEchoReply(lastUserText: string): string {
  const q = quote(lastUserText);
  const heard = q ? `Şunu duydum: "${q.replace(/[.!?…]+$/, "")}". ` : "";
  return (
    `${heard}`
  );
}

export function createEchoBackend(options: EchoBackendOptions = {}): ChatBackend {
  const firstMs = options.firstTokenMs ?? 350;
  const wordMs = options.wordMs ?? 45;
  const reply = options.reply ?? defaultEchoReply;
  return {
    kind: "echo",
    async *stream(messages, opts) {
      const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      // words with their following whitespace, so the deltas concatenate back to the exact reply
      const pieces = reply(last).match(/\S+\s*/g) ?? [];
      await sleep(firstMs, opts.signal);
      for (let i = 0; i < pieces.length; i++) {
        if (i > 0) await sleep(wordMs, opts.signal);
        yield pieces[i];
      }
    },
  };
}
