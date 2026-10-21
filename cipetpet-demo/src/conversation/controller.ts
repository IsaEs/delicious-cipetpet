// ConversationController: runs the voice loop on top of the pure reducer.
//
//   mic -> (VAD) -> STT -> LLM stream -> SentenceStream -> toSpeakable -> TTS -> gapless playback
//
// Latency: speech starts with the reply's first sentence, not its end. One loop synthesises sentences in
// order and pushes their audio into a single gapless queue without waiting for playback, so sentence k+1 is
// synthesised while sentence k plays. Every async step checks a generation counter: a barge-in, Stop or a
// new turn bumps it and aborts the in-flight work (LLM fetch, STT, TTS) through one AbortController, so a
// stale continuation never touches the state and nothing hangs.
//
// The controller knows nothing about React or cipetpet: the engines come in through `ControllerDeps`.

import { ChatError, type ChatBackend } from "../llm/types.ts";
import { isAbortError, abortError } from "../llm/errors.ts";
import { SentenceStream, splitSentences, type Sentence } from "../speech/sentences.ts";
import { toSpeakable } from "../speech/speakable.ts";
import { EnergyVad, type VadEvent, type VadOptions } from "../voice/vad.ts";
import { STT_SAMPLE_RATE, type AudioOut, type MicInput, type MicSession, type SttEngine, type TtsEngine } from "../voice/types.ts";
import type { DuyuLanguage } from "../voice/languages.ts";
import { buildHistory, type HistoryOptions } from "./history.ts";
import { initialState, reducer, type Action } from "./reducer.ts";
import type { AssistantMessage, ConversationState, TurnTimings } from "./types.ts";

export interface ConversationSettings {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  sttLang: DuyuLanguage;
  sttBeam: number;
  ttsSpeed: number;
  ttsSeed: number;
  /** hands-free end-of-utterance detection */
  vad: VadOptions;
  /** ask the browser for echo cancellation on the mic */
  echoCancellation: boolean;
  /** hands-free: speaking while the assistant talks interrupts it (only with echo cancellation, else the
   * assistant would interrupt itself) */
  bargeIn: boolean;
  history: HistoryOptions;
}

export interface ControllerDeps {
  /** null while the model is not loaded */
  getStt(): SttEngine | null;
  getTts(): TtsEngine | null;
  getBackend(): ChatBackend;
  getSettings(): ConversationSettings;
  mic: MicInput;
  audio: AudioOut;
  now?: () => number;
  newId?: () => string;
  /** press longer than this = hold-to-talk (release ends the turn); shorter = tap-to-toggle. Default 350 ms */
  holdMs?: number;
  /** hands-free: an idle mic session is renewed after this long without speech (bounds memory). Default 30 s */
  idleRecycleMs?: number;
  /** push-to-talk recordings stop by themselves at this length. Default 25 s */
  maxUtteranceMs?: number;
}

type Listener = () => void;

interface MicEntry {
  mode: "listen" | "monitor";
  session: MicSession | null;
  vad: EnergyVad | null;
  openedAt: number;
  /** seconds into the recording where the utterance begins (VAD start minus pre-roll) */
  offsetSec?: number;
  finishing?: boolean;
}

/** audio kept before the VAD's speech start, so the first syllable is not clipped */
const PREROLL_SEC = 0.3;
/** recordings shorter than this are treated as "nothing said" */
const MIN_AUDIO_SEC = 0.25;

const defaultIds = (() => {
  let n = 0;
  return () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `m${Date.now().toString(36)}${(n++).toString(36)}`);
})();

function errorInfo(e: unknown): { message: string; code?: ChatError["code"] } {
  if (e instanceof ChatError) return { message: e.message, code: e.code };
  if (e instanceof Error) return { message: e.message || e.name };
  return { message: String(e) };
}

/** waits for all, but rejects (and aborts the rest through `abort`) as soon as one fails */
async function allOrAbort(tasks: Promise<unknown>[], abort: AbortController): Promise<void> {
  await Promise.all(
    tasks.map((t) =>
      t.catch((e: unknown) => {
        abort.abort();
        throw e;
      }),
    ),
  );
}

/** Synthesises queued sentences in order and pushes their audio to the playback queue without waiting for it. */
class Speaker {
  private queue: Sentence[] = [];
  private closed = false;
  private wake: (() => void) | undefined;
  readonly done: Promise<void>;

  constructor(
    private readonly tts: TtsEngine,
    private readonly audio: AudioOut,
    private readonly opts: { speed: number; seed: number; signal: AbortSignal },
    private readonly onFirstAudio: (index: number, startsInSec: number) => void,
    /** every chunk handed to the player, in order (kept for "download the audio") */
    private readonly onChunk: (chunk: Float32Array) => void = () => {},
  ) {
    opts.signal.addEventListener("abort", () => this.wake?.(), { once: true });
    this.done = this.run();
  }

  enqueue(s: Sentence): void {
    this.queue.push(s);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  private async run(): Promise<void> {
    const { signal } = this.opts;
    for (;;) {
      // the next sentence was not there yet: its audio follows a wait for the language model, not for synthesis
      let waited = false;
      while (this.queue.length === 0) {
        if (signal.aborted) throw abortError();
        if (this.closed) return;
        waited = true;
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = undefined;
      }
      if (signal.aborted) throw abortError();
      const sentence = this.queue.shift()!;
      const text = toSpeakable(sentence.text);
      if (!text) continue;
      let first = true;
      for await (const chunk of this.tts.stream(text, { speed: this.opts.speed, seed: this.opts.seed, signal })) {
        if (signal.aborted) throw abortError();
        const startsIn = this.audio.push(chunk, this.tts.sampleRate, first && waited);
        this.onChunk(chunk);
        if (first) {
          first = false;
          this.onFirstAudio(sentence.index, startsIn);
        }
      }
    }
  }
}

/** the synthesised speech kept for "download", newest replies first: about 55 MB of float samples at 48 kHz */
export const AUDIO_KEEP_SECONDS = 300;

interface Recording {
  chunks: Float32Array[];
  sampleRate: number;
  seconds: number;
}

/** ChatError codes that more listening cannot fix */
const PERMANENT_ERRORS = new Set<string>(["invalid_key", "credits", "not_configured"]);

export class ConversationController {
  private state: ConversationState;
  private readonly listeners = new Set<Listener>();
  private level = 0;
  private readonly levelListeners = new Set<Listener>();

  /** bumped by every new turn, barge-in, stop: stale async continuations compare and bail out */
  private gen = 0;
  private turnAbort: AbortController | null = null;
  private mic: MicEntry | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private press: { at: number; started: boolean } | null = null;
  private disposed = false;
  /** each reply's last complete synthesis (a replay replaces it once it is done), oldest first */
  private readonly recordings = new Map<string, Recording>();

  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly holdMs: number;
  private readonly idleRecycleMs: number;
  private readonly maxUtteranceMs: number;

  constructor(
    private readonly deps: ControllerDeps,
    initial?: Partial<Pick<ConversationState, "handsFree" | "messages">>,
  ) {
    this.state = { ...initialState(initial?.handsFree ?? false), messages: initial?.messages ?? [] };
    this.now = deps.now ?? (() => performance.now());
    this.newId = deps.newId ?? defaultIds;
    this.holdMs = deps.holdMs ?? 350;
    this.idleRecycleMs = deps.idleRecycleMs ?? 30000;
    this.maxUtteranceMs = deps.maxUtteranceMs ?? 25000;
  }

  // ------------------------------------------------------------------------------ store

  getState = (): ConversationState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** live mic level 0..1 (kept out of the state: it changes ~20 times a second) */
  getLevel = (): number => this.level;

  subscribeLevel = (fn: Listener): (() => void) => {
    this.levelListeners.add(fn);
    return () => this.levelListeners.delete(fn);
  };

  private dispatch(a: Action): void {
    if (this.disposed) return;
    const next = reducer(this.state, a);
    if (next === this.state) return;
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  private setLevel(v: number): void {
    if (v === this.level) return;
    this.level = v;
    for (const fn of this.levelListeners) fn();
  }

  // ------------------------------------------------------------------------------ user intents

  /** mic button / Space pressed. Starts listening (interrupting the assistant), or ends a tap-started turn. */
  micDown(): void {
    this.deps.audio.unlock(); // the user gesture that lets audio play
    const phase = this.state.phase;
    this.press = { at: this.now(), started: false };
    if (phase === "listening") {
      void this.finishListening();
      return;
    }
    if (phase === "transcribing") return;
    this.press.started = true;
    void this.startListening();
  }

  /** mic button / Space released: after a hold, this ends the turn; after a tap, listening goes on. */
  micUp(): void {
    const p = this.press;
    this.press = null;
    if (!p?.started) return;
    // a release during the permission prompt (session not open yet) counts as a tap
    if (this.now() - p.at >= this.holdMs && this.state.phase === "listening" && this.mic?.mode === "listen" && this.mic.session) {
      void this.finishListening();
    }
  }

  /** a tap: micDown + micUp */
  toggleMic(): void {
    this.micDown();
    this.micUp();
  }

  /** typed input instead of speech */
  sendText(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.deps.audio.unlock();
    this.halt();
    if (this.state.phase === "listening" || this.state.phase === "transcribing") this.dispatch({ type: "listen-cancel" });
    else if (this.state.phase !== "idle") this.dispatch({ type: "interrupt", reason: "stop" });
    void this.runTurn({ text: t, source: "text", turnStart: this.now() });
  }

  /** Stop button / Esc: everything stops, back to idle (hands-free stays on but waits for the mic button) */
  stop(): void {
    this.press = null;
    const phase = this.state.phase;
    this.halt();
    if (phase === "listening" || phase === "transcribing") this.dispatch({ type: "listen-cancel" });
    else this.dispatch({ type: "interrupt", reason: "stop" });
  }

  setHandsFree(on: boolean): void {
    this.dispatch({ type: "hands-free", on });
    if (on) {
      this.deps.audio.unlock();
      if (this.state.phase === "idle") void this.startListening();
      else if (this.mic?.mode === "listen" && !this.mic.vad) this.mic.vad = new EnergyVad(this.deps.getSettings().vad);
      return;
    }
    if (this.mic?.mode === "monitor") this.closeMic();
    // Nobody has spoken yet: nothing to keep, so the mic closes and the next press opens it. An utterance
    // in progress (speech detected) now ends with the mic button instead.
    else if (this.mic?.mode === "listen" && this.mic.vad && this.mic.offsetSec === undefined) {
      this.closeMic();
      this.dispatch({ type: "listen-cancel" });
    } else if (this.mic) this.mic.vad = null;
  }

  /** plays an assistant reply again */
  speakAgain(id: string): void {
    const msg = this.state.messages.find((m): m is AssistantMessage => m.id === id && m.role === "assistant");
    if (!msg || !msg.text.trim()) return;
    const tts = this.deps.getTts();
    if (!tts) {
      this.dispatch({ type: "notice", kind: "error", key: "tts-not-ready" });
      return;
    }
    this.deps.audio.unlock();
    this.halt();
    if (this.state.phase === "listening" || this.state.phase === "transcribing") this.dispatch({ type: "listen-cancel" });
    const gen = this.gen;
    const abort = new AbortController();
    this.turnAbort = abort;
    this.dispatch({ type: "replay", id });
    const s = this.deps.getSettings();
    const spans = msg.sentences.length
      ? msg.sentences.map((sp, index) => ({ text: msg.text.slice(sp.start, sp.end), start: sp.start, end: sp.end, index }))
      : splitSentences(msg.text);
    const rec = this.record(id, tts.sampleRate);
    const speaker = new Speaker(
      tts,
      this.deps.audio,
      { speed: s.ttsSpeed, seed: s.ttsSeed, signal: abort.signal },
      (index, startsIn) => this.later(startsIn * 1000, gen, () => this.dispatch({ type: "speaking", id, index })),
      rec.onChunk,
    );
    void speaker.done.then(rec.keep, rec.keep);
    for (const sp of spans) speaker.enqueue(sp);
    speaker.close();
    void (async () => {
      try {
        await speaker.done;
        if (gen !== this.gen) return;
        await this.deps.audio.finish();
        if (gen !== this.gen) return;
        this.endTurn(id);
      } catch (e) {
        this.fail(e, gen);
      }
    })();
  }

  clear(): void {
    this.stop();
    this.recordings.clear();
    this.dispatch({ type: "clear" });
  }

  /** the speech last synthesised for a reply, joined (null when none is kept) */
  getAudio(id: string): { audio: Float32Array; sampleRate: number } | null {
    const r = this.recordings.get(id);
    if (!r) return null;
    const audio = new Float32Array(r.chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of r.chunks) {
      audio.set(c, offset);
      offset += c.length;
    }
    return { audio, sampleRate: r.sampleRate };
  }

  /** collects one synthesis of a reply; `keep` (when the speaker is done, finished or stopped) makes it the reply's
   * recording, replacing an earlier one, and drops the oldest recordings past AUDIO_KEEP_SECONDS */
  private record(id: string, sampleRate: number): { onChunk(chunk: Float32Array): void; keep(): void } {
    const rec: Recording = { chunks: [], sampleRate, seconds: 0 };
    return {
      onChunk: (chunk) => {
        rec.chunks.push(chunk);
        rec.seconds += chunk.length / sampleRate;
      },
      keep: () => {
        if (rec.seconds === 0 || this.disposed) return;
        this.recordings.delete(id); // re-inserted: newest last
        this.recordings.set(id, rec);
        this.dispatch({ type: "audio", id, seconds: Math.round(rec.seconds * 10) / 10 });
        let total = 0;
        for (const r of this.recordings.values()) total += r.seconds;
        for (const [old, r] of this.recordings) {
          if (total <= AUDIO_KEEP_SECONDS || old === id) break;
          this.recordings.delete(old);
          total -= r.seconds;
          this.dispatch({ type: "audio", id: old, seconds: 0 });
        }
      },
    };
  }

  dismiss(id: number): void {
    this.dispatch({ type: "dismiss", id });
  }

  dispose(): void {
    this.halt();
    this.disposed = true;
    this.recordings.clear();
    this.listeners.clear();
    this.levelListeners.clear();
  }

  // ------------------------------------------------------------------------------ listening

  private async startListening(): Promise<void> {
    if (!this.deps.getStt()) {
      this.dispatch({ type: "notice", kind: "error", key: "stt-not-ready" });
      return;
    }
    const phase = this.state.phase;
    if (phase === "thinking" || phase === "speaking") {
      // barge-in by button: a running barge-in monitor becomes the listening session (no new getUserMedia)
      const monitor = this.mic?.mode === "monitor" ? this.mic : null;
      this.halt(monitor !== null);
      this.dispatch({ type: "interrupt", reason: "barge-in" });
      if (monitor?.session) {
        monitor.mode = "listen";
        monitor.offsetSec = monitor.session.duration;
        monitor.vad = this.state.handsFree ? new EnergyVad(this.deps.getSettings().vad) : null;
        monitor.openedAt = this.now();
        return;
      }
    } else {
      this.dispatch({ type: "listen" });
    }
    await this.openMic("listen");
  }

  private async openMic(mode: MicEntry["mode"]): Promise<void> {
    this.closeMic();
    const s = this.deps.getSettings();
    const vadOpts: VadOptions =
      mode === "monitor"
        ? // stricter while the assistant talks: what is left of its own voice after echo cancellation must not trigger
          { ...s.vad, ratio: (s.vad.ratio ?? 3) * 1.5, minLevel: (s.vad.minLevel ?? 0.012) * 1.5, startMs: Math.max(250, s.vad.startMs ?? 150) }
        : s.vad;
    const entry: MicEntry = {
      mode,
      session: null,
      vad: mode === "monitor" || this.state.handsFree ? new EnergyVad(vadOpts) : null,
      openedAt: this.now(),
    };
    this.mic = entry;
    try {
      const session = await this.deps.mic.open({ onLevel: (l) => this.onLevel(entry, l), echoCancellation: s.echoCancellation });
      if (this.mic !== entry) {
        session.cancel();
        return;
      }
      entry.session = session;
      entry.openedAt = this.now();
    } catch (e) {
      if (this.mic !== entry) return;
      this.mic = null;
      if (mode === "monitor") return; // barge-in is a nicety; the turn goes on without it
      this.dispatch({ type: "error", key: "mic", message: errorInfo(e).message });
    }
  }

  private closeMic(): void {
    const m = this.mic;
    this.mic = null;
    m?.session?.cancel();
    this.setLevel(0);
  }

  private onLevel(entry: MicEntry, level: number): void {
    if (this.mic !== entry || entry.finishing) return;
    this.setLevel(Math.min(1, level));
    const t = this.now();
    const session = entry.session;
    let ev: VadEvent | null = null;
    if (entry.vad) ev = entry.vad.process(level, t);

    if (ev?.type === "speech-start") {
      const ago = (t - ev.at) / 1000;
      const base = entry.offsetSec ?? 0;
      entry.offsetSec = Math.max(base, (session?.duration ?? 0) - ago - PREROLL_SEC);
      if (entry.mode === "monitor") {
        // barge-in by voice: stop the assistant, keep this recording as the user's turn
        entry.mode = "listen";
        entry.vad = this.state.handsFree ? entry.vad : null;
        this.halt(true);
        this.dispatch({ type: "interrupt", reason: "barge-in" });
      }
      return;
    }
    if (entry.mode !== "listen") return;
    if (ev?.type === "speech-end") {
      void this.finishListening();
      return;
    }
    if (!session) return;
    // The cap counts from where this utterance starts (a barge-in reuses a recording that began with the
    // assistant's reply). A hands-free session without speech has no utterance yet; the idle recycle below
    // renews it, so silence is never sent to the recogniser.
    const utterance = entry.vad === null || entry.offsetSec !== undefined;
    if (utterance && (session.duration - (entry.offsetSec ?? 0)) * 1000 >= this.maxUtteranceMs) {
      void this.finishListening();
      return;
    }
    // hands-free and nobody spoke for a while: renew the session so the recording does not grow forever
    if (entry.vad && !entry.vad.inSpeech && entry.offsetSec === undefined && t - entry.openedAt >= this.idleRecycleMs) {
      void this.openMic("listen");
    }
  }

  private async finishListening(): Promise<void> {
    const entry = this.mic;
    if (!entry || entry.mode !== "listen" || this.state.phase !== "listening") return;
    if (!entry.session) return; // still opening (permission prompt): nothing recorded yet
    entry.finishing = true;
    this.mic = null;
    this.setLevel(0);
    const turnStart = this.now();
    const gen = this.gen;
    const abort = new AbortController();
    this.turnAbort = abort;
    this.dispatch({ type: "transcribe" });
    try {
      let audio = await entry.session.stop();
      if (gen !== this.gen) return;
      const offset = Math.floor((entry.offsetSec ?? 0) * STT_SAMPLE_RATE);
      if (offset > 0 && offset < audio.length) audio = audio.subarray(offset);
      const audioSeconds = audio.length / STT_SAMPLE_RATE;
      const stt = this.deps.getStt();
      if (!stt) throw new Error("speech recognition is not loaded");
      let text = "";
      let lang = "";
      const t0 = this.now();
      if (audioSeconds >= MIN_AUDIO_SEC) {
        const s = this.deps.getSettings();
        const r = await stt.transcribe(audio, { lang: s.sttLang, beam: s.sttBeam, signal: abort.signal });
        if (gen !== this.gen) return;
        text = r.text.trim();
        lang = r.lang;
      }
      const sttMs = Math.round(this.now() - t0);
      if (!/[\p{L}\p{N}]/u.test(text)) {
        this.dispatch({ type: "transcript-empty" });
        if (this.state.handsFree && this.state.phase === "listening") await this.openMic("listen");
        return;
      }
      if (lang === "en") this.dispatch({ type: "notice", kind: "info", key: "english-tts" });
      await this.runTurn({ text, source: "voice", sttMs, lang, audioSeconds, turnStart });
    } catch (e) {
      this.fail(e, gen);
    }
  }

  // ------------------------------------------------------------------------------ a turn

  private async runTurn(input: {
    text: string;
    source: "voice" | "text";
    turnStart: number;
    sttMs?: number;
    lang?: string;
    audioSeconds?: number;
  }): Promise<void> {
    const gen = ++this.gen;
    this.turnAbort?.abort();
    const abort = new AbortController();
    this.turnAbort = abort;
    const s = this.deps.getSettings();
    const backend = this.deps.getBackend();
    const tts = this.deps.getTts();
    const assistantId = this.newId();

    this.dispatch({
      type: "user-turn",
      text: input.text,
      source: input.source,
      userId: this.newId(),
      assistantId,
      model: backend.kind === "echo" ? "echo" : s.model,
      backend: backend.kind,
      at: Date.now(),
      sttMs: input.sttMs,
      lang: input.lang,
      audioSeconds: input.audioSeconds,
      silent: !tts,
    });
    if (!tts) this.dispatch({ type: "notice", kind: "info", key: "tts-not-ready" });

    const messages = buildHistory(s.systemPrompt, this.state.messages, s.history);
    if (tts && this.state.handsFree && s.bargeIn && s.echoCancellation) void this.openMic("monitor");

    const timings: TurnTimings = {};
    const setTimings = (t: TurnTimings) => {
      Object.assign(timings, t);
      this.dispatch({ type: "timings", id: assistantId, timings: t });
    };
    const rec = tts ? this.record(assistantId, tts.sampleRate) : null;
    const speaker = tts
      ? new Speaker(
          tts,
          this.deps.audio,
          { speed: s.ttsSpeed, seed: s.ttsSeed, signal: abort.signal },
          (index, startsIn) => {
            if (gen !== this.gen) return;
            if (timings.ttfaMs === undefined) setTimings({ ttfaMs: Math.round(this.now() - input.turnStart + startsIn * 1000) });
            this.later(startsIn * 1000, gen, () => this.dispatch({ type: "speaking", id: assistantId, index }));
          },
          rec?.onChunk,
        )
      : null;
    if (speaker && rec) void speaker.done.then(rec.keep, rec.keep);

    const emit = (sentence: Sentence) => {
      this.dispatch({ type: "sentence", id: assistantId, start: sentence.start, end: sentence.end });
      speaker?.enqueue(sentence);
    };

    const llm = (async () => {
      const ss = new SentenceStream();
      const sent = this.now();
      try {
        for await (const delta of backend.stream(messages, { model: s.model, temperature: s.temperature, maxTokens: s.maxTokens, signal: abort.signal })) {
          if (gen !== this.gen) throw abortError();
          if (timings.ttftMs === undefined) setTimings({ ttftMs: Math.round(this.now() - sent) });
          this.dispatch({ type: "delta", id: assistantId, text: delta });
          for (const sentence of ss.push(delta)) emit(sentence);
        }
        for (const sentence of ss.flush()) emit(sentence);
        this.dispatch({ type: "reply-done", id: assistantId });
      } finally {
        speaker?.close();
      }
    })();

    try {
      await allOrAbort(speaker ? [llm, speaker.done] : [llm], abort);
      if (gen !== this.gen) return;
      await this.deps.audio.finish();
      if (gen !== this.gen) return;
      if (speaker) setTimings({ totalMs: Math.round(this.now() - input.turnStart) });
      this.endTurn(assistantId);
    } catch (e) {
      this.fail(e, gen);
    }
  }

  private endTurn(id: string): void {
    if (this.mic?.mode === "monitor") this.closeMic();
    this.clearTimers();
    this.dispatch({ type: "turn-end", id });
    if (this.state.handsFree && this.state.phase === "listening") void this.openMic("listen");
  }

  /** an error from the current generation: stop everything, toast, idle. Aborts and stale errors are dropped. */
  private fail(e: unknown, gen: number): void {
    if (gen !== this.gen || isAbortError(e)) return;
    this.halt();
    const { message, code } = errorInfo(e);
    this.dispatch({ type: "error", message, ...(code ? { code } : {}) });
    // Hands-free carries on after a passing failure. A permanent one (bad key, no credits, no proxy key)
    // would fail the same way on the next utterance: the toast stays and listening waits for the mic button.
    if (this.state.handsFree && !PERMANENT_ERRORS.has(code ?? "")) void this.startListening();
  }

  /** aborts everything in flight (LLM, STT, TTS, playback, timers; the mic unless `keepMic`) */
  private halt(keepMic = false): void {
    this.gen++;
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.deps.audio.stop();
    this.clearTimers();
    if (!keepMic) this.closeMic();
  }

  private later(ms: number, gen: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (gen === this.gen) fn();
    }, Math.max(0, ms));
    this.timers.add(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
