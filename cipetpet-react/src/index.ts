"use client";
// cipetpet-react: React hooks and components for cipetpet (Turkish TTS + STT in the browser).
// The "use client" directive marks this entry as a client module for React Server Components frameworks
// (Next.js app router): import it from server components freely, it renders on the client.

export { CipetpetProvider } from "./provider.js";
export type { CipetpetProviderProps } from "./provider.js";
export { useCipetpetConfig } from "./context.js";
export type { CipetpetConfig } from "./context.js";

export { useModel, useAntalia, useDuyu } from "./useModel.js";
export type { ModelHandle, ModelHookOptions } from "./useModel.js";
export { useTextToSpeech } from "./useTextToSpeech.js";
export type { SynthesisDefaults, TextToSpeechHandle, TextToSpeechOptions } from "./useTextToSpeech.js";
export { useSpeechToText } from "./useSpeechToText.js";
export type {
  RecordingOptions,
  SpeechToTextHandle,
  SpeechToTextOptions,
  TranscribeDefaults,
  TranscribeInput,
} from "./useSpeechToText.js";

export { SpeakButton, RecordButton } from "./components.js";
export type { RecordButtonProps, RecordButtonState, SpeakButtonProps, SpeakButtonState } from "./components.js";

export { ModelRegistry, modelRegistry, modelKey, clearModelCache, DEFAULT_DISPOSE_DELAY_MS } from "./registry.js";
export type {
  AcquireOptions,
  AntaliaWorker,
  DuyuWorker,
  ModelConfig,
  ModelKind,
  ModelLease,
  ModelOf,
  ModelOptions,
  ModelSnapshot,
  ModelStatus,
  SttModel,
  TtsModel,
  WorkerOptions,
  WorkerSource,
} from "./registry.js";

// cipetpet's own types, for convenience (type-only: nothing of the core is pulled in by these)
export type {
  AntaliaMini,
  AntaliaPrecision,
  Backend,
  DuyuLanguage,
  DuyuPrecision,
  DuyuSmall,
  LoadOptions,
  ModelInfo,
  PackProgress,
  PackSource,
  RuntimeOptions,
  SpeechChunk,
  SynthesisOptions,
  SynthesisResult,
  SynthesisTimings,
  TranscribeOptions,
  TranscriptionResult,
} from "cipetpet";
