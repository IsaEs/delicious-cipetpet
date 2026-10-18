// The messages sent to the LLM: the system prompt plus the most recent turns that fit a character budget
// (a cheap stand-in for a token budget: ~4 characters per token for Turkish).

import type { ChatMessage } from "../llm/types.ts";
import type { Message } from "./types.ts";

export interface HistoryOptions {
  /** total characters of the turns (system prompt not counted); default 12000 */
  maxChars?: number;
  /** at most this many user+assistant pairs; default 12 */
  maxTurns?: number;
}

export function buildHistory(systemPrompt: string, messages: Message[], opts: HistoryOptions = {}): ChatMessage[] {
  const maxChars = opts.maxChars ?? 12000;
  const maxMessages = Math.max(1, (opts.maxTurns ?? 12) * 2);

  // only finished content: skip empty / failed replies, mark cut-off ones
  const turns: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (m.text.trim()) turns.push({ role: "user", content: m.text.trim() });
      continue;
    }
    if (m.status === "error" || m.status === "pending" || !m.text.trim()) continue;
    turns.push({ role: "assistant", content: m.status === "interrupted" ? `${m.text.trim()} …` : m.text.trim() });
  }

  const picked: ChatMessage[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const isLast = picked.length === 0;
    if (!isLast && (picked.length >= maxMessages || chars + t.content.length > maxChars)) break;
    // the newest message always goes in, cut to the budget if it alone is too long
    const content = isLast && t.content.length > maxChars ? t.content.slice(-maxChars) : t.content;
    picked.unshift({ role: t.role, content });
    chars += content.length;
  }
  // the conversation part must start with the user
  while (picked.length > 1 && picked[0].role !== "user") picked.shift();

  const system = systemPrompt.trim();
  return system ? [{ role: "system", content: system }, ...picked] : picked;
}
