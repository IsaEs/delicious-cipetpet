import { describe, expect, it } from "vitest";
import { buildHistory } from "../src/conversation/history.ts";
import { initialState, reducer, type Action } from "../src/conversation/reducer.ts";
import type { AssistantMessage, ConversationState, Message } from "../src/conversation/types.ts";

const run = (actions: Action[], s: ConversationState = initialState()) => actions.reduce(reducer, s);

const userTurn = (id = "a1", text = "Merhaba"): Action => ({
  type: "user-turn",
  text,
  source: "voice",
  userId: `u-${id}`,
  assistantId: id,
  model: "openai/gpt-4o",
  backend: "proxy",
  at: 1,
  sttMs: 420,
  lang: "tr",
});

const assistant = (s: ConversationState, id = "a1") => s.messages.find((m) => m.id === id) as AssistantMessage;

describe("conversation reducer", () => {
  it("push-to-talk: idle -> listening -> transcribing -> thinking -> speaking -> idle", () => {
    const steps: Action[] = [
      { type: "listen" },
      { type: "transcribe" },
      userTurn(),
      { type: "delta", id: "a1", text: "Merhaba! " },
      { type: "sentence", id: "a1", start: 0, end: 8 },
      { type: "speaking", id: "a1", index: 0 },
      { type: "delta", id: "a1", text: "Nasılsın?" },
      { type: "reply-done", id: "a1" },
      { type: "turn-end", id: "a1" },
    ];
    const phases: string[] = [];
    let s = initialState();
    for (const a of steps) {
      s = reducer(s, a);
      phases.push(s.phase);
    }
    expect(phases).toEqual(["listening", "transcribing", "thinking", "thinking", "thinking", "speaking", "speaking", "speaking", "idle"]);
    const m = assistant(s);
    expect(m).toMatchObject({ text: "Merhaba! Nasılsın?", status: "done", speaking: null, sentences: [{ start: 0, end: 8 }], timings: { sttMs: 420 } });
    expect(s.messages[0]).toMatchObject({ role: "user", text: "Merhaba", sttMs: 420, source: "voice" });
    expect(s.activeId).toBeNull();
  });

  it("hands-free: the end of a turn goes back to listening", () => {
    const s = run([{ type: "hands-free", on: true }, { type: "listen" }, { type: "transcribe" }, userTurn(), { type: "turn-end", id: "a1" }]);
    expect(s.phase).toBe("listening");
  });

  it("an empty transcript goes back to listening (hands-free) or idle, without a message", () => {
    const push = run([{ type: "listen" }, { type: "transcribe" }, { type: "transcript-empty" }]);
    expect(push.phase).toBe("idle");
    expect(push.messages).toEqual([]);
    const hf = run([{ type: "hands-free", on: true }, { type: "listen" }, { type: "transcribe" }, { type: "transcript-empty" }]);
    expect(hf.phase).toBe("listening");
  });

  it("barge-in while the reply streams: back to listening, the reply marked interrupted", () => {
    const s = run([userTurn(), { type: "delta", id: "a1", text: "Uzun bir" }, { type: "speaking", id: "a1", index: 0 }, { type: "interrupt", reason: "barge-in" }]);
    expect(s.phase).toBe("listening");
    expect(assistant(s)).toMatchObject({ status: "interrupted", speaking: null, text: "Uzun bir" });
    // late events of the interrupted turn are ignored
    const late = run([{ type: "delta", id: "a1", text: " cümle" }, { type: "speaking", id: "a1", index: 1 }, { type: "turn-end", id: "a1" }], s);
    expect(late).toBe(s);
  });

  it("barge-in after the text finished keeps it 'done'", () => {
    const s = run([userTurn(), { type: "delta", id: "a1", text: "Bitti." }, { type: "reply-done", id: "a1" }, { type: "speaking", id: "a1", index: 0 }, { type: "listen" }]);
    expect(s.phase).toBe("listening");
    expect(assistant(s).status).toBe("done");
  });

  it("stop: any phase -> idle", () => {
    for (const pre of [[{ type: "listen" }], [{ type: "listen" }, { type: "transcribe" }], [userTurn()], [userTurn(), { type: "speaking", id: "a1", index: 0 }]] as Action[][]) {
      const s = run([...pre, pre.length === 1 && pre[0].type === "listen" ? { type: "listen-cancel" } : { type: "interrupt", reason: "stop" }]);
      expect(s.phase).toBe("idle");
    }
    expect(run([{ type: "listen" }, { type: "transcribe" }, { type: "listen-cancel" }]).phase).toBe("idle");
  });

  it("errors: back to idle with a dismissible notice; the reply marked as failed", () => {
    let s = run([userTurn(), { type: "delta", id: "a1", text: "Yar" }, { type: "error", message: "OpenRouter rejected the request: invalid API key (401)", code: "invalid_key" }]);
    expect(s.phase).toBe("idle");
    expect(assistant(s).status).toBe("error");
    expect(s.notices).toEqual([{ id: 1, kind: "error", key: "generic", message: "OpenRouter rejected the request: invalid API key (401)", code: "invalid_key" }]);
    s = reducer(s, { type: "dismiss", id: 1 });
    expect(s.notices).toEqual([]);
  });

  it("an error while listening (mic denied) also returns to idle", () => {
    const s = run([{ type: "listen" }, { type: "error", key: "mic", message: "Permission denied" }]);
    expect(s.phase).toBe("idle");
    expect(s.notices[0]).toMatchObject({ key: "mic", message: "Permission denied" });
  });

  it("shows the English/TTS hint only once, and dedupes repeated notices", () => {
    let s = run([
      { type: "notice", kind: "info", key: "english-tts" },
      { type: "notice", kind: "info", key: "english-tts" },
    ]);
    expect(s.notices).toHaveLength(1);
    s = reducer(s, { type: "dismiss", id: s.notices[0].id });
    s = reducer(s, { type: "notice", kind: "info", key: "english-tts" });
    expect(s.notices).toHaveLength(0);
    s = run([{ type: "error", message: "x" }, { type: "error", message: "x" }, { type: "error", message: "y" }], s);
    expect(s.notices.map((n) => n.message)).toEqual(["x", "y"]);
  });

  it("replay: speaks an old reply and returns", () => {
    let s = run([userTurn(), { type: "delta", id: "a1", text: "Merhaba." }, { type: "turn-end", id: "a1" }]);
    s = reducer(s, { type: "replay", id: "a1" });
    expect(s).toMatchObject({ phase: "speaking", activeId: "a1" });
    s = reducer(s, { type: "speaking", id: "a1", index: 0 });
    expect(assistant(s).speaking).toBe(0);
    s = reducer(s, { type: "turn-end", id: "a1" });
    expect(s.phase).toBe("idle");
    expect(assistant(s)).toMatchObject({ status: "done", speaking: null });
  });

  it("a new user turn settles the previous one", () => {
    const s = run([userTurn("a1"), { type: "delta", id: "a1", text: "Ya" }, userTurn("a2", "Dur")]);
    expect(assistant(s, "a1").status).toBe("interrupted");
    expect(s.activeId).toBe("a2");
    expect(s.messages).toHaveLength(4);
  });

  it("clear keeps hands-free and the notice counter", () => {
    const s = run([{ type: "hands-free", on: true }, userTurn(), { type: "error", message: "x" }, { type: "clear" }]);
    expect(s).toMatchObject({ messages: [], handsFree: true, phase: "idle", nextNoticeId: 2 });
  });
});

describe("buildHistory", () => {
  const u = (id: string, text: string): Message => ({ id, role: "user", text, source: "voice", at: 0 });
  const a = (id: string, text: string, status: AssistantMessage["status"] = "done"): Message => ({
    id,
    role: "assistant",
    text,
    status,
    sentences: [],
    speaking: null,
    timings: {},
    model: "m",
    backend: "proxy",
    at: 0,
  });

  it("puts the system prompt first, then the turns, skipping failed / pending replies", () => {
    const h = buildHistory("Sistem.", [u("1", "Selam"), a("2", "Merhaba!"), u("3", "Nasılsın?"), a("4", "", "error"), u("5", "Orada mısın?"), a("6", "", "pending")]);
    expect(h).toEqual([
      { role: "system", content: "Sistem." },
      { role: "user", content: "Selam" },
      { role: "assistant", content: "Merhaba!" },
      { role: "user", content: "Nasılsın?" },
      { role: "user", content: "Orada mısın?" },
    ]);
  });

  it("marks interrupted replies", () => {
    expect(buildHistory("", [u("1", "Anlat"), a("2", "Bir varmış", "interrupted"), u("3", "Dur")])[1]).toEqual({ role: "assistant", content: "Bir varmış …" });
  });

  it("keeps the most recent turns within the character budget and turn limit, starting with a user turn", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 30; i++) msgs.push(u(`u${i}`, `soru ${i} `.repeat(10)), a(`a${i}`, `yanıt ${i} `.repeat(10)));
    msgs.push(u("last", "son soru"));
    const h = buildHistory("S", msgs, { maxChars: 1000, maxTurns: 50 });
    const chars = h.slice(1).reduce((n, m) => n + m.content.length, 0);
    expect(chars).toBeLessThanOrEqual(1000);
    expect(h[1].role).toBe("user");
    expect(h[h.length - 1]).toEqual({ role: "user", content: "son soru" });

    const byTurns = buildHistory("S", msgs, { maxChars: 1e9, maxTurns: 3 });
    expect(byTurns.length).toBeLessThanOrEqual(1 + 6);
    expect(byTurns[byTurns.length - 1].content).toBe("son soru");
  });

  it("always sends the newest message, cut to the budget if needed", () => {
    const h = buildHistory("S", [u("1", "x".repeat(5000))], { maxChars: 100 });
    expect(h[1].content).toHaveLength(100);
  });
});
