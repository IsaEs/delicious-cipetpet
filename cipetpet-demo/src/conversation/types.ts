import type { BackendKind, ChatErrorCode } from "../llm/types.ts";

export type Phase = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

export interface TurnTimings {
  /** speech to text compute, ms */
  sttMs?: number;
  /** request sent -> first token, ms */
  ttftMs?: number;
  /** end of the user's turn (stop pressed / silence detected / text sent) -> first audio out, ms */
  ttfaMs?: number;
  /** end of the user's turn -> last audio played, ms */
  totalMs?: number;
}

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
  source: "voice" | "text";
  at: number;
  sttMs?: number;
  lang?: string;
  audioSeconds?: number;
}

export interface SentenceSpan {
  start: number;
  end: number;
}

export type AssistantStatus = "pending" | "streaming" | "done" | "interrupted" | "error";

export interface AssistantMessage {
  id: string;
  role: "assistant";
  text: string;
  status: AssistantStatus;
  /** the reply's sentences, as offsets into `text`, in the order they are spoken */
  sentences: SentenceSpan[];
  /** index into `sentences` being played right now */
  speaking: number | null;
  timings: TurnTimings;
  model: string;
  backend: BackendKind;
  at: number;
  /** true when the reply was shown without speech (TTS not loaded) */
  silent?: boolean;
  /** seconds of synthesised speech the controller keeps for this reply (it can be downloaded); unset when none */
  audioSeconds?: number;
}

export type Message = UserMessage | AssistantMessage;

export type NoticeKey = "english-tts" | "tts-not-ready" | "stt-not-ready" | "mic" | "generic";

export interface Notice {
  id: number;
  kind: "error" | "info";
  /** a localisable key, or "generic" with `message` */
  key: NoticeKey;
  message?: string;
  code?: ChatErrorCode;
}

export interface ConversationState {
  phase: Phase;
  handsFree: boolean;
  messages: Message[];
  /** the assistant message the current turn writes to / speaks */
  activeId: string | null;
  notices: Notice[];
  nextNoticeId: number;
  /** the "Antalia speaks Turkish only" hint was shown */
  englishNoticeShown: boolean;
}
