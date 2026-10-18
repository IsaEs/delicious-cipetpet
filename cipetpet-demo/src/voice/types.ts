// What the conversation engine needs from the voice side, as plain interfaces. src/voice/cipetpet.ts
// implements them on top of cipetpet / cipetpet-react; tests use fakes.

import type { DuyuLanguage } from "./languages.ts";

export interface TranscribeRequest {
  lang: DuyuLanguage;
  beam: number;
  signal?: AbortSignal;
}

export interface Transcript {
  text: string;
  /** language the model detected / used: "tr" | "en" | "mix" */
  lang: string;
  /** model compute time, when the engine reports it */
  computeMs?: number;
}

/** speech to text (Duyu-small); audio is 16 kHz mono */
export interface SttEngine {
  transcribe(audio: Float32Array, req: TranscribeRequest): Promise<Transcript>;
}

export interface SpeakRequest {
  speed: number;
  seed: number;
  signal?: AbortSignal;
}

/** text to speech (Antalia-2 Mini): yields audio chunks as they are ready */
export interface TtsEngine {
  readonly sampleRate: number;
  stream(text: string, req: SpeakRequest): AsyncIterable<Float32Array>;
}

/** gapless playback queue */
export interface AudioOut {
  /** creates / resumes the playback context; call it from a user gesture (the first mic press) */
  unlock(): void;
  /** queues a chunk after everything queued; returns the seconds from now until it starts playing */
  push(chunk: Float32Array, sampleRate: number): number;
  /** resolves when everything queued so far has played (or stop() was called) */
  finish(): Promise<void>;
  /** stops at once and drops the queue */
  stop(): void;
}

export interface MicSession {
  /** seconds captured so far */
  readonly duration: number;
  /** stops capturing and returns the audio: 16 kHz mono */
  stop(): Promise<Float32Array>;
  /** stops capturing and drops the audio */
  cancel(): void;
}

export interface MicOpenOptions {
  /** ~20 RMS readings a second, 0..1 */
  onLevel(rms: number): void;
  /** ask the browser for echo cancellation (needed for barge-in while the assistant speaks) */
  echoCancellation: boolean;
}

export interface MicInput {
  open(opts: MicOpenOptions): Promise<MicSession>;
}

export const STT_SAMPLE_RATE = 16000;
