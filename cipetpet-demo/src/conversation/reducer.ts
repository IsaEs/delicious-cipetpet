// The conversation state machine, as a pure reducer.
//
//   idle -> listening -> transcribing -> thinking -> speaking -> idle        (push-to-talk)
//                                                            \-> listening   (hands-free)
//   empty transcript:       transcribing -> listening (hands-free) / idle
//   barge-in (mic / VAD):   thinking | speaking -> listening, the reply is marked "interrupted"
//   stop (button / Esc):    any -> idle
//   error at any stage:     any -> idle, plus an error notice

import type { BackendKind, ChatErrorCode } from "../llm/types.ts";
import type { AssistantMessage, ConversationState, Message, Notice, NoticeKey, Phase, TurnTimings } from "./types.ts";

export type Action =
  | { type: "listen" }
  | { type: "listen-cancel" }
  | { type: "transcribe" }
  | { type: "transcript-empty" }
  | {
      type: "user-turn";
      text: string;
      source: "voice" | "text";
      userId: string;
      assistantId: string;
      model: string;
      backend: BackendKind;
      at: number;
      sttMs?: number;
      lang?: string;
      audioSeconds?: number;
      silent?: boolean;
    }
  | { type: "delta"; id: string; text: string }
  | { type: "sentence"; id: string; start: number; end: number }
  | { type: "timings"; id: string; timings: TurnTimings }
  | { type: "speaking"; id: string; index: number }
  | { type: "reply-done"; id: string }
  | { type: "turn-end"; id: string }
  | { type: "replay"; id: string }
  | { type: "audio"; id: string; seconds: number }
  | { type: "interrupt"; reason: "barge-in" | "stop" }
  | { type: "error"; message: string; code?: ChatErrorCode; key?: NoticeKey }
  | { type: "notice"; kind: Notice["kind"]; key: NoticeKey; message?: string }
  | { type: "dismiss"; id: number }
  | { type: "hands-free"; on: boolean }
  | { type: "clear" }
  | { type: "load"; messages: Message[] };

export function initialState(handsFree = false): ConversationState {
  return { phase: "idle", handsFree, messages: [], activeId: null, notices: [], nextNoticeId: 1, englishNoticeShown: false };
}

const MAX_NOTICES = 4;

function afterTurn(s: ConversationState): Phase {
  return s.handsFree ? "listening" : "idle";
}

function updateAssistant(s: ConversationState, id: string, f: (m: AssistantMessage) => AssistantMessage): ConversationState {
  let changed = false;
  const messages = s.messages.map((m) => {
    if (m.id !== id || m.role !== "assistant") return m;
    changed = true;
    return f(m);
  });
  return changed ? { ...s, messages } : s;
}

function pushNotice(s: ConversationState, n: Omit<Notice, "id">): ConversationState {
  // the same message twice in a row is shown once
  const last = s.notices[s.notices.length - 1];
  if (last && last.key === n.key && last.message === n.message) return s;
  const notices = [...s.notices, { ...n, id: s.nextNoticeId }].slice(-MAX_NOTICES);
  return { ...s, notices, nextNoticeId: s.nextNoticeId + 1 };
}

/** ends the active turn: a reply still pending / streaming gets `outcome` (a finished one stays "done"), and the
 * spoken-sentence marker goes away */
function settleActive(s: ConversationState, outcome: "done" | "interrupted" | "error"): ConversationState {
  if (!s.activeId) return s;
  const next = updateAssistant(s, s.activeId, (m) => ({
    ...m,
    speaking: null,
    status: m.status === "pending" || m.status === "streaming" ? outcome : m.status,
  }));
  return { ...next, activeId: null };
}

export function reducer(s: ConversationState, a: Action): ConversationState {
  switch (a.type) {
    case "listen":
      return s.phase === "listening" ? s : { ...settleActive(s, "interrupted"), phase: "listening" };

    case "listen-cancel":
      return s.phase === "listening" || s.phase === "transcribing" ? { ...s, phase: "idle" } : s;

    case "transcribe":
      return s.phase === "listening" ? { ...s, phase: "transcribing" } : s;

    case "transcript-empty":
      return s.phase === "transcribing" ? { ...s, phase: afterTurn(s) } : s;

    case "user-turn": {
      const base = settleActive(s, "interrupted");
      const user: Message = {
        id: a.userId,
        role: "user",
        text: a.text,
        source: a.source,
        at: a.at,
        ...(a.sttMs !== undefined ? { sttMs: a.sttMs } : {}),
        ...(a.lang !== undefined ? { lang: a.lang } : {}),
        ...(a.audioSeconds !== undefined ? { audioSeconds: a.audioSeconds } : {}),
      };
      const assistant: AssistantMessage = {
        id: a.assistantId,
        role: "assistant",
        text: "",
        status: "pending",
        sentences: [],
        speaking: null,
        timings: a.sttMs !== undefined ? { sttMs: a.sttMs } : {},
        model: a.model,
        backend: a.backend,
        at: a.at,
        ...(a.silent ? { silent: true } : {}),
      };
      return { ...base, phase: "thinking", messages: [...base.messages, user, assistant], activeId: a.assistantId };
    }

    case "delta":
      if (a.id !== s.activeId || !a.text) return s;
      return updateAssistant(s, a.id, (m) => ({ ...m, text: m.text + a.text, status: "streaming" }));

    case "sentence":
      if (a.id !== s.activeId) return s;
      return updateAssistant(s, a.id, (m) => ({ ...m, sentences: [...m.sentences, { start: a.start, end: a.end }] }));

    case "timings":
      return updateAssistant(s, a.id, (m) => ({ ...m, timings: { ...m.timings, ...a.timings } }));

    case "speaking":
      if (a.id !== s.activeId) return s;
      return { ...updateAssistant(s, a.id, (m) => ({ ...m, speaking: a.index })), phase: "speaking" };

    case "reply-done":
      if (a.id !== s.activeId) return s;
      return updateAssistant(s, a.id, (m) => (m.status === "pending" || m.status === "streaming" ? { ...m, status: "done" } : m));

    case "turn-end": {
      if (a.id !== s.activeId) return s;
      const settled = settleActive(s, "done");
      return { ...settled, phase: afterTurn(settled) };
    }

    case "replay": {
      const base = settleActive(s, "interrupted");
      const target = base.messages.find((m) => m.id === a.id);
      if (!target || target.role !== "assistant") return base;
      return { ...base, activeId: a.id, phase: "speaking" };
    }

    case "audio":
      return updateAssistant(s, a.id, (m) => {
        const { audioSeconds: _dropped, ...rest } = m;
        return a.seconds > 0 ? { ...rest, audioSeconds: a.seconds } : rest;
      });

    case "interrupt": {
      if (s.phase === "idle" && !s.activeId) return s;
      const settled = settleActive(s, "interrupted");
      return { ...settled, phase: a.reason === "barge-in" ? "listening" : "idle" };
    }

    case "error": {
      const settled = settleActive(s, "error");
      return pushNotice({ ...settled, phase: "idle" }, { kind: "error", key: a.key ?? "generic", message: a.message, ...(a.code ? { code: a.code } : {}) });
    }

    case "notice": {
      if (a.key === "english-tts") {
        if (s.englishNoticeShown) return s;
        return pushNotice({ ...s, englishNoticeShown: true }, { kind: a.kind, key: a.key, message: a.message });
      }
      return pushNotice(s, { kind: a.kind, key: a.key, message: a.message });
    }

    case "dismiss":
      return { ...s, notices: s.notices.filter((n) => n.id !== a.id) };

    case "hands-free":
      return s.handsFree === a.on ? s : { ...s, handsFree: a.on };

    case "clear":
      return { ...initialState(s.handsFree), englishNoticeShown: s.englishNoticeShown, nextNoticeId: s.nextNoticeId };

    case "load":
      return { ...s, messages: a.messages };
  }
}
