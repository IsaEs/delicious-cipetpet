// Text to speech: speak() streams sentence chunks into a gapless player, synthesize() returns the audio.

import { useCallback, useEffect, useRef, useState } from "react";
import { StreamPlayer, encodeWav } from "cipetpet";
import type { SpeechChunk, SynthesisOptions, SynthesisResult, SynthesisTimings } from "cipetpet";
import type { TtsModel } from "./registry.js";
import { useModel, type ModelHandle, type ModelHookOptions } from "./useModel.js";
import { definedOnly, linkSignal, noop, now, throwIfAborted, useLatest } from "./util.js";

/** Antalia-2 Mini's output rate (the player is created before the model is loaded, so it cannot ask it) */
const TTS_SAMPLE_RATE = 48000;

/** Synthesis defaults a hook applies to every call (a call's own options win). */
export type SynthesisDefaults = Omit<SynthesisOptions, "signal">;

export interface TextToSpeechOptions extends ModelHookOptions, SynthesisDefaults {
  /** play through this AudioContext instead of one the hook creates (and closes on unmount) */
  audioContext?: AudioContext;
}

export interface TextToSpeechHandle extends ModelHandle<TtsModel> {
  /**
   * Synthesises `text` and plays it while it is being synthesised (playback starts after the first
   * sentence). Resolves when playback ends, or when it is stopped / replaced by another speak() (a
   * cancelled speak resolves, it does not reject). Rejects on a load or synthesis error.
   *
   * Call it from a user gesture (a click handler): the AudioContext is created / resumed synchronously at
   * the start of the call, which browsers require for audio to play.
   */
  speak(text: string, opts?: SynthesisOptions): Promise<void>;
  /** Synthesises the whole text without playing it. Rejects with an AbortError when stopped. */
  synthesize(text: string, opts?: SynthesisOptions): Promise<SynthesisResult>;
  /** Aborts every synthesis in flight and stops playback. */
  stop(): void;
  /** the model text for `text` (the normaliser's output) */
  normalize(text: string): Promise<string>;
  /** a synthesis (speak or synthesize) is running */
  isSynthesizing: boolean;
  /** speak() audio is playing */
  isSpeaking: boolean;
  /** the latest finished synthesis (from speak() or synthesize()) */
  result: SynthesisResult | null;
  /** result.modelText, or "" */
  modelText: string;
  /** a 16-bit WAV of `result` (default: the latest result). Throws when there is none. */
  getWavBlob(result?: SynthesisResult): Blob;
}

interface SpeakRun {
  id: number;
  controller: AbortController;
  player: StreamPlayer;
}

const ZERO_TIMINGS: SynthesisTimings = { normalize: 0, text: 0, cond: 0, flow: 0, vocoder: 0, istft: 0, post: 0 };

/** speak() only sees chunks; this builds the SynthesisResult the chunks add up to (stats are wall clock). */
function joinChunks(chunks: SpeechChunk[], sampleRate: number, computeMs: number): SynthesisResult {
  let length = 0;
  for (const c of chunks) length += c.audio.length;
  const audio = new Float32Array(length);
  const timings: SynthesisTimings = { ...ZERO_TIMINGS };
  let o = 0;
  for (const c of chunks) {
    audio.set(c.audio, o);
    o += c.audio.length;
    for (const k of Object.keys(timings) as (keyof SynthesisTimings)[]) timings[k] += c.timings[k] ?? 0;
  }
  const seconds = length / sampleRate;
  return {
    audio,
    sampleRate,
    modelText: chunks.map((c) => c.text).filter(Boolean).join(" "),
    stats: { computeMs, seconds, chunks: chunks.length, rtf: seconds > 0 ? computeMs / 1000 / seconds : 0, timings },
  };
}

export function useTextToSpeech(options: TextToSpeechOptions = {}): TextToSpeechHandle {
  const { seed, steps, cfg, speed, temperature, raw, audioContext, ...modelOptions } = options;
  const handle = useModel("tts", modelOptions);
  const { load } = handle;

  const defaultsRef = useLatest(definedOnly<SynthesisDefaults>({ seed, steps, cfg, speed, temperature, raw }));
  const audioContextRef = useLatest(audioContext);
  const sampleRateRef = useLatest(handle.model?.info.sampleRate ?? TTS_SAMPLE_RATE);

  const [synthCount, setSynthCount] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [result, setResult] = useState<SynthesisResult | null>(null);

  const mountedRef = useRef(false);
  const speakRef = useRef<SpeakRun | null>(null);
  const speakSeq = useRef(0);
  const synthControllers = useRef(new Set<AbortController>());
  /** an AudioContext this hook created (closed on unmount) */
  const ownContextRef = useRef<AudioContext | null>(null);
  const resultRef = useRef<SynthesisResult | null>(null);
  /** results apply in call order: a slow early call never replaces a later call's result */
  const resultSeq = useRef(0);
  const appliedSeq = useRef(0);

  const publishResult = useCallback((seq: number, r: SynthesisResult) => {
    if (!mountedRef.current || seq <= appliedSeq.current) return;
    appliedSeq.current = seq;
    resultRef.current = r;
    setResult(r);
  }, []);

  const begin = useCallback(() => {
    if (mountedRef.current) setSynthCount((c) => c + 1);
  }, []);
  const end = useCallback(() => {
    if (mountedRef.current) setSynthCount((c) => Math.max(0, c - 1));
  }, []);

  /** cancels the current speak() (if any) */
  const cancelSpeak = useCallback(() => {
    const run = speakRef.current;
    if (!run) return;
    speakRef.current = null;
    run.controller.abort();
    run.player.stop();
    if (mountedRef.current) setIsSpeaking(false);
  }, []);

  const stop = useCallback(() => {
    cancelSpeak();
    for (const c of synthControllers.current) c.abort();
    synthControllers.current.clear();
  }, [cancelSpeak]);

  /** synchronous, so it runs inside the user gesture that called speak() */
  const createPlayer = useCallback((): StreamPlayer => {
    let ctx: AudioContext | null = audioContextRef.current ?? ownContextRef.current;
    if (ctx && ctx.state === "closed") {
      if (ctx === ownContextRef.current) ownContextRef.current = null;
      ctx = audioContextRef.current && audioContextRef.current.state !== "closed" ? audioContextRef.current : null;
    }
    const player = ctx ? new StreamPlayer(TTS_SAMPLE_RATE, ctx) : new StreamPlayer(TTS_SAMPLE_RATE);
    if (!ctx) ownContextRef.current = player.context;
    // resume() must be *called* during the gesture; it need not be awaited
    if (player.context.state === "suspended") player.context.resume().catch(noop);
    return player;
  }, [audioContextRef]);

  const speak = useCallback(
    async (text: string, opts: SynthesisOptions = {}): Promise<void> => {
      cancelSpeak();
      const id = ++speakSeq.current;
      const seq = ++resultSeq.current;
      const controller = new AbortController();
      const unlink = linkSignal(opts.signal, controller);
      let player: StreamPlayer;
      try {
        player = createPlayer();
      } catch (e) {
        unlink();
        throw e;
      }
      speakRef.current = { id, controller, player };
      const isCurrent = () => speakRef.current?.id === id && mountedRef.current;

      begin();
      let synthesizing = true;
      const endSynthesis = () => {
        if (synthesizing) {
          synthesizing = false;
          end();
        }
      };

      try {
        const model = await load();
        throwIfAborted(controller.signal);
        const { signal: _signal, ...callOpts } = opts;
        const chunks: SpeechChunk[] = [];
        const t0 = now();
        for await (const chunk of model.stream(text, { ...defaultsRef.current, ...callOpts, signal: controller.signal })) {
          if (controller.signal.aborted) break;
          player.push(chunk.audio);
          chunks.push(chunk);
          if (chunks.length === 1 && isCurrent()) setIsSpeaking(true);
        }
        endSynthesis();
        if (controller.signal.aborted) return;
        publishResult(seq, joinChunks(chunks, sampleRateRef.current, now() - t0));
        // resolves when the queue drains, or at once when stop() / a newer speak() stops this player
        await player.finish();
      } catch (e) {
        if (controller.signal.aborted) return; // cancelled: not an error
        throw e;
      } finally {
        endSynthesis();
        unlink();
        if (speakRef.current?.id === id) {
          speakRef.current = null;
          if (mountedRef.current) setIsSpeaking(false);
        }
      }
    },
    [cancelSpeak, createPlayer, begin, end, load, defaultsRef, sampleRateRef, publishResult],
  );

  const synthesize = useCallback(
    async (text: string, opts: SynthesisOptions = {}): Promise<SynthesisResult> => {
      const seq = ++resultSeq.current;
      const controller = new AbortController();
      const unlink = linkSignal(opts.signal, controller);
      synthControllers.current.add(controller);
      begin();
      try {
        const model = await load();
        throwIfAborted(controller.signal);
        const { signal: _signal, ...callOpts } = opts;
        const r = await model.synthesize(text, { ...defaultsRef.current, ...callOpts, signal: controller.signal });
        throwIfAborted(controller.signal);
        publishResult(seq, r);
        return r;
      } finally {
        synthControllers.current.delete(controller);
        unlink();
        end();
      }
    },
    [begin, end, load, defaultsRef, publishResult],
  );

  const normalize = useCallback(
    async (text: string): Promise<string> => {
      const model = await load();
      return await model.normalize(text);
    },
    [load],
  );

  const getWavBlob = useCallback((r?: SynthesisResult): Blob => {
    const res = r ?? resultRef.current;
    if (!res) throw new Error("cipetpet-react: nothing synthesised yet");
    const bytes = encodeWav(res.audio, res.sampleRate) as Uint8Array<ArrayBuffer>;
    return new Blob([bytes], { type: "audio/wav" });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const controllers = synthControllers.current;
    return () => {
      // unmount (or StrictMode's simulated one): abort everything, never set state again
      mountedRef.current = false;
      const run = speakRef.current;
      speakRef.current = null;
      if (run) {
        run.controller.abort();
        run.player.stop();
      }
      for (const c of controllers) c.abort();
      controllers.clear();
      const ctx = ownContextRef.current;
      ownContextRef.current = null;
      if (ctx && ctx.state !== "closed") ctx.close().catch(noop);
    };
  }, []);

  return {
    ...handle,
    speak,
    synthesize,
    stop,
    normalize,
    isSynthesizing: synthCount > 0,
    isSpeaking,
    result,
    modelText: result?.modelText ?? "",
    getWavBlob,
  };
}
