// THE adapter between this demo and the voice packages. It is the only module that imports "cipetpet" or
// "cipetpet-react"; everything else talks to the plain interfaces in ./types.ts. When those packages change
// their API, this file is the one to reconcile.
//
// * Model loading: cipetpet-react's <CipetpetProvider> (app-wide pack + runtime options, preload) and
//   useAntalia / useDuyu (status, progress, the shared model instance, in-thread or in a Web Worker). The "tts"
//   model is whichever text-to-speech model its pack holds: Antalia-2 Mini or EMA Lightning (the settings pick the pack).
// * Playback: one core StreamPlayer on an AudioContext created / resumed in the first user gesture.
// * Microphone: the core's MicRecorder (16 kHz mono out, RMS level callback for the meter and the VAD).

import { createElement, useMemo, type ReactElement, type ReactNode } from "react";
import { MicRecorder, StreamPlayer } from "cipetpet";
import { CipetpetProvider, useAntalia, useDuyu, type ModelOptions, type SttModel, type TtsModel } from "cipetpet-react";
import type { DuyuPrecision, TtsModelChoice } from "./languages.ts";
import { STT_SAMPLE_RATE, type AudioOut, type MicInput, type MicSession, type SttEngine, type TtsEngine } from "./types.ts";

/** where the server exposes the packs and onnxruntime-web's files (server/server.mjs) */
export const PACKS_URL = "/packs/";
export const ORT_URL = "/ort/";

export const TTS_PACKS: Record<TtsModelChoice, string> = { antalia: "antalia-mini-mixed.cpet", ema: "ema-lightning-fp32.cpet" };
export const ttsPack = (m: TtsModelChoice): string => TTS_PACKS[m];
export const sttPack = (p: DuyuPrecision): string => `duyu-small-${p}.cpet`;
/** approximate download sizes, for the UI ("first load downloads ~23 MB + ~56 MB") */
export const PACK_MB: Record<string, number> = {
  [TTS_PACKS.antalia]: 23,
  [TTS_PACKS.ema]: 34,
  [sttPack("int8")]: 56,
  [sttPack("q4")]: 34,
};

/** the core's worker bundle (built next to the app when the core ships one) */
const WORKER_URL: string | null = typeof __CIPETPET_WORKER_URL__ === "string" ? __CIPETPET_WORKER_URL__ : null;
export const workerSupported = (): boolean => WORKER_URL !== null && typeof Worker !== "undefined";

export interface VoiceConfig {
  /** the text-to-speech model; the pack's header decides which class loads it */
  ttsModel: TtsModelChoice;
  sttPrecision: DuyuPrecision;
  /** run both models in Web Workers (ignored when unsupported) */
  useWorker: boolean;
  /** "sha256-<base64>" per pack file name, from the server's /api/config */
  integrity?: Readonly<Record<string, string>>;
}

function modelOptions(file: string, useWorker: boolean, integrity: string | undefined): ModelOptions {
  return {
    source: PACKS_URL + file,
    // ORT fetches its .mjs / .wasm from here (the pack may embed the binary; the thread glue is still needed)
    wasmPaths: ORT_URL,
    // The pack URLs carry no version and the packs get rebuilt, so a copy in the Cache API is only safe when its
    // digest is known: the library then drops a stale copy and downloads again. Without a digest every visit
    // goes through the HTTP cache, which revalidates (ETag).
    ...(integrity ? { cache: true, integrity } : {}),
    ...(useWorker && WORKER_URL ? { useWorker: true, worker: WORKER_URL } : {}),
  };
}

/** Provides the model configuration to the hooks below and starts both downloads at once. */
export function VoiceProvider({ config, children }: { config: VoiceConfig; children?: ReactNode }): ReactElement {
  const ttsFile = ttsPack(config.ttsModel);
  const ttsDigest = config.integrity?.[ttsFile];
  const sttDigest = config.integrity?.[sttPack(config.sttPrecision)];
  const tts = useMemo(() => modelOptions(ttsFile, config.useWorker, ttsDigest), [ttsFile, config.useWorker, ttsDigest]);
  const stt = useMemo(() => modelOptions(sttPack(config.sttPrecision), config.useWorker, sttDigest), [config.sttPrecision, config.useWorker, sttDigest]);
  // a long dispose delay: switching precision or voice back and forth should not reload the other model
  return createElement(CipetpetProvider, { tts, stt, preload: true, disposeDelayMs: 30_000 }, children);
}

export type ModelStatus = "idle" | "loading" | "ready" | "error";

export interface ModelView {
  status: ModelStatus;
  /** 0..1, null when unknown */
  progress: number | null;
  loadedBytes: number;
  totalBytes: number;
  error: Error | null;
  retry(): void;
  /** "wasm · 4 threads" etc. once loaded */
  detail: string | null;
}

export interface VoiceModels {
  tts: ModelView;
  stt: ModelView;
  ttsEngine: TtsEngine | null;
  sttEngine: SttEngine | null;
}

function view(h: ReturnType<typeof useAntalia> | ReturnType<typeof useDuyu>): ModelView {
  const p = h.progress;
  const info = h.model?.info;
  return {
    status: h.status,
    progress: p && p.total > 0 ? Math.min(1, p.loaded / p.total) : null,
    loadedBytes: p?.loaded ?? 0,
    totalBytes: p?.total ?? 0,
    error: h.error,
    retry: () => {
      h.retry().catch(() => {});
    },
    detail: info ? `${info.variant} · ${info.backend}${info.threads > 1 ? ` · ${info.threads} threads` : ""}` : null,
  };
}

function ttsEngine(model: TtsModel): TtsEngine {
  return {
    sampleRate: model.info.sampleRate,
    async *stream(text, req) {
      for await (const chunk of model.stream(text, { speed: req.speed, seed: req.seed, signal: req.signal })) yield chunk.audio;
    },
  };
}

function sttEngine(model: SttModel): SttEngine {
  return {
    async transcribe(audio, req) {
      const r = await model.transcribe(audio, { sampleRate: STT_SAMPLE_RATE, lang: req.lang, beam: req.beam, signal: req.signal });
      return { text: r.text, lang: r.lang, computeMs: r.stats.computeMs };
    },
  };
}

/** both models' loading state and, once ready, the engines the conversation controller uses */
export function useVoiceModels(): VoiceModels {
  const tts = useAntalia();
  const stt = useDuyu();
  const ttsModel = tts.status === "ready" ? tts.model : null;
  const sttModel = stt.status === "ready" ? stt.model : null;
  const ttsE = useMemo(() => (ttsModel ? ttsEngine(ttsModel) : null), [ttsModel]);
  const sttE = useMemo(() => (sttModel ? sttEngine(sttModel) : null), [sttModel]);
  return { tts: view(tts), stt: view(stt), ttsEngine: ttsE, sttEngine: sttE };
}

// ------------------------------------------------------------------------------------------ playback

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** StreamPlayer's lead time for an idle queue (its first chunk starts this long after the push) */
const LEAD_SECONDS = 0.05;

export function createAudioOut(): AudioOut {
  let ctx: AudioContext | null = null;
  let player: StreamPlayer | null = null;

  const context = (): AudioContext => {
    if (!ctx || ctx.state === "closed") {
      const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
      const Ctx = g.AudioContext ?? g.webkitAudioContext;
      if (!Ctx) throw new Error("This browser has no Web Audio API: speech output is unavailable");
      ctx = new Ctx({ latencyHint: "interactive" });
      player = null;
    }
    return ctx;
  };

  return {
    unlock() {
      try {
        const c = context();
        if (c.state === "suspended") c.resume().catch(() => {});
      } catch {
        // reported on the first push
      }
    },
    push(chunk, sampleRate) {
      const c = context();
      if (!player || player.sampleRate !== sampleRate) {
        player?.stop();
        player = new StreamPlayer(sampleRate, c);
      }
      const startsIn = player.buffered > 0 ? player.buffered : LEAD_SECONDS;
      player.push(chunk);
      return startsIn;
    },
    finish() {
      return player ? player.finish() : Promise.resolve();
    },
    stop() {
      player?.stop();
    },
  };
}

// ------------------------------------------------------------------------------------------ microphone

export function createMicInput(): MicInput {
  return {
    async open({ onLevel, echoCancellation }): Promise<MicSession> {
      const rec = await MicRecorder.start({
        sampleRate: STT_SAMPLE_RATE,
        onLevel,
        // the core records unprocessed audio (what Duyu was trained on); echo cancellation is only asked for
        // when hands-free barge-in needs it
        ...(echoCancellation ? { constraints: { echoCancellation: true } } : {}),
      });
      return {
        get duration() {
          return rec.duration;
        },
        stop: () => rec.stop(),
        cancel: () => rec.cancel(),
      };
    },
  };
}
