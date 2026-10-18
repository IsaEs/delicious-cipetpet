// Speech to text: transcribe audio (samples or files) and record from the microphone.

import { useCallback, useEffect, useRef, useState } from "react";
import { MicRecorder, decodeAudio } from "cipetpet";
import type { TranscribeOptions, TranscriptionResult } from "cipetpet";
import type { SttModel } from "./registry.js";
import { useModel, type ModelHandle, type ModelHookOptions } from "./useModel.js";
import { definedOnly, linkSignal, noop, scheduleFrame, throwIfAborted, useLatest } from "./util.js";

/** Duyu-small's input rate */
const STT_SAMPLE_RATE = 16000;

/** Transcription defaults a hook applies to every call (a call's own options win). */
export type TranscribeDefaults = Omit<TranscribeOptions, "signal" | "sampleRate">;

export interface SpeechToTextOptions extends ModelHookOptions, TranscribeDefaults {}

/** Audio transcribe() accepts: 16 kHz-or-`sampleRate` mono samples, or an audio file (WAV parsed directly,
 * other formats through the browser's decoder). */
export type TranscribeInput = Float32Array | Blob | ArrayBuffer | Uint8Array;

/** Microphone options for startRecording(). */
export interface RecordingOptions {
  /** a device from navigator.mediaDevices.enumerateDevices() */
  deviceId?: string;
  /** extra getUserMedia audio constraints */
  constraints?: MediaTrackConstraints;
}

export interface SpeechToTextHandle extends ModelHandle<SttModel> {
  /**
   * Transcribes samples (a Float32Array at `opts.sampleRate`, default 16000) or an audio file (Blob / File /
   * ArrayBuffer / Uint8Array, decoded and resampled to 16 kHz). With useWorker the samples' buffer is
   * transferred to the worker (the array is detached afterwards). Rejects with an AbortError on unmount.
   */
  transcribe(input: TranscribeInput, opts?: TranscribeOptions): Promise<TranscriptionResult>;
  /** Asks for the microphone and starts recording (call it from a user gesture). Also starts loading the
   * model, so it is ready when the recording stops. No-op while already recording. */
  startRecording(opts?: RecordingOptions): Promise<void>;
  /** Stops the microphone and transcribes what was recorded. */
  stopRecording(opts?: TranscribeOptions): Promise<TranscriptionResult>;
  /** Stops the microphone and drops the recording. */
  cancelRecording(): void;
  /** recording (from the startRecording() call, including the permission prompt, until stop / cancel) */
  isRecording: boolean;
  /** a transcription is running */
  isTranscribing: boolean;
  /** microphone level 0..1 (RMS of the latest ~50 ms block), updated at most once per animation frame */
  level: number;
  /** text of the latest transcription, or "" */
  transcript: string;
  /** the latest transcription */
  result: TranscriptionResult | null;
}

export function useSpeechToText(options: SpeechToTextOptions = {}): SpeechToTextHandle {
  const { lang, mode, beam, tailPad, ctcWeight, ...modelOptions } = options;
  const handle = useModel("stt", modelOptions);
  const { load } = handle;
  const defaultsRef = useLatest(definedOnly<TranscribeDefaults>({ lang, mode, beam, tailPad, ctcWeight }));

  const [transcribeCount, setTranscribeCount] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState<TranscriptionResult | null>(null);

  const mountedRef = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  /** "latest wins": results apply in call order, a slow earlier call never replaces a newer result */
  const callSeq = useRef(0);
  const appliedSeq = useRef(0);

  const recorderRef = useRef<MicRecorder | null>(null);
  const startingRef = useRef<Promise<MicRecorder> | null>(null);
  /** bumps on every start / stop / cancel, so a start that resolves late knows it was cancelled */
  const recordingId = useRef(0);
  const levelRef = useRef(0);
  const cancelFrameRef = useRef<(() => void) | null>(null);

  const safe = useCallback(<T,>(set: (v: T) => void, v: T) => {
    if (mountedRef.current) set(v);
  }, []);

  /** runs one transcription; `getAudio` is called after the count goes up, so isTranscribing covers it */
  const run = useCallback(
    async (
      getAudio: () => Promise<{ audio: Float32Array; sampleRate: number }>,
      opts: TranscribeOptions,
    ): Promise<TranscriptionResult> => {
      const seq = ++callSeq.current;
      const controller = new AbortController();
      const unlink = linkSignal(opts.signal, controller);
      controllers.current.add(controller);
      if (mountedRef.current) setTranscribeCount((c) => c + 1);
      try {
        const modelPromise = load();
        modelPromise.catch(noop); // awaited below; this only stops an unhandled rejection if getAudio throws first
        const { audio, sampleRate } = await getAudio();
        throwIfAborted(controller.signal);
        const model = await modelPromise;
        throwIfAborted(controller.signal);
        const { signal: _signal, sampleRate: _rate, ...callOpts } = opts;
        const r = await model.transcribe(audio, {
          ...defaultsRef.current,
          ...callOpts,
          sampleRate,
          signal: controller.signal,
        });
        throwIfAborted(controller.signal);
        if (mountedRef.current && seq > appliedSeq.current) {
          appliedSeq.current = seq;
          setResult(r);
        }
        return r;
      } finally {
        controllers.current.delete(controller);
        unlink();
        if (mountedRef.current) setTranscribeCount((c) => Math.max(0, c - 1));
      }
    },
    [load, defaultsRef],
  );

  const transcribe = useCallback(
    (input: TranscribeInput, opts: TranscribeOptions = {}): Promise<TranscriptionResult> =>
      run(
        input instanceof Float32Array
          ? async () => ({ audio: input, sampleRate: opts.sampleRate ?? STT_SAMPLE_RATE })
          : () => decodeAudio(input, STT_SAMPLE_RATE),
        opts,
      ),
    [run],
  );

  const stopMeter = useCallback(() => {
    cancelFrameRef.current?.();
    cancelFrameRef.current = null;
    levelRef.current = 0;
  }, []);

  const startRecording = useCallback(
    async (opts: RecordingOptions = {}): Promise<void> => {
      if (recorderRef.current || startingRef.current) return;
      const id = ++recordingId.current;
      safe(setIsRecording, true);
      safe(setLevel, 0);
      load().catch(noop); // warm up while the user speaks; errors show in `status` / `error`

      const onLevel = (rms: number) => {
        if (id !== recordingId.current) return;
        levelRef.current = Math.min(1, Math.max(0, rms));
        if (cancelFrameRef.current) return; // a frame is already scheduled
        cancelFrameRef.current = scheduleFrame(() => {
          cancelFrameRef.current = null;
          if (id === recordingId.current && mountedRef.current) setLevel(levelRef.current);
        });
      };

      const starting = MicRecorder.start({ ...opts, sampleRate: STT_SAMPLE_RATE, onLevel });
      startingRef.current = starting;
      try {
        const rec = await starting;
        if (id !== recordingId.current || !mountedRef.current) {
          rec.cancel(); // cancelled (or unmounted) during the permission prompt
          return;
        }
        recorderRef.current = rec;
      } catch (e) {
        if (id === recordingId.current) {
          recordingId.current++;
          stopMeter();
          safe(setIsRecording, false);
        }
        throw e;
      } finally {
        if (startingRef.current === starting) startingRef.current = null;
      }
    },
    [load, safe, stopMeter],
  );

  const stopRecording = useCallback(
    async (opts: TranscribeOptions = {}): Promise<TranscriptionResult> => {
      if (!recorderRef.current && startingRef.current) {
        // stop pressed during the permission prompt: wait for the start to settle
        await startingRef.current.catch(noop);
      }
      const rec = recorderRef.current;
      if (!rec) throw new Error("cipetpet-react: not recording");
      recorderRef.current = null;
      recordingId.current++;
      stopMeter();
      safe(setIsRecording, false);
      safe(setLevel, 0);
      return run(async () => ({ audio: await rec.stop(), sampleRate: rec.sampleRate }), opts);
    },
    [run, safe, stopMeter],
  );

  const cancelRecording = useCallback(() => {
    recordingId.current++;
    const rec = recorderRef.current;
    recorderRef.current = null;
    startingRef.current = null; // a start still waiting for the permission prompt is void: a new one may begin
    rec?.cancel();
    stopMeter();
    safe(setIsRecording, false);
    safe(setLevel, 0);
  }, [safe, stopMeter]);

  useEffect(() => {
    mountedRef.current = true;
    const pending = controllers.current;
    return () => {
      mountedRef.current = false;
      // the mic goes off and every transcription is aborted
      recordingId.current++;
      recorderRef.current?.cancel();
      recorderRef.current = null;
      cancelFrameRef.current?.();
      cancelFrameRef.current = null;
      for (const c of pending) c.abort();
      pending.clear();
    };
  }, []);

  return {
    ...handle,
    transcribe,
    startRecording,
    stopRecording,
    cancelRecording,
    isRecording,
    isTranscribing: transcribeCount > 0,
    level,
    transcript: result?.text ?? "",
    result,
  };
}
