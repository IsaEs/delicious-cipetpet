import { createContext, useContext } from "react";
import type { ModelKind, ModelOptions } from "./registry.js";

/** Defaults the hooks inherit from <CipetpetProvider>. A hook's own options win, field by field. */
export interface CipetpetConfig {
  /** text-to-speech model (useTextToSpeech / useAntalia / <SpeakButton>) */
  tts?: ModelOptions;
  /** speech-recognition model (useSpeechToText / useDuyu / <RecordButton>) */
  stt?: ModelOptions;
  /** ms a model stays loaded after the last component using it unmounts (default 1000) */
  disposeDelayMs?: number;
}

export const CipetpetContext = createContext<CipetpetConfig | null>(null);
CipetpetContext.displayName = "CipetpetContext";

/** The nearest provider's configuration, or null outside a provider. */
export function useCipetpetConfig(): CipetpetConfig | null {
  return useContext(CipetpetContext);
}

export function configFor(ctx: CipetpetConfig | null, kind: ModelKind): ModelOptions | undefined {
  return ctx ? ctx[kind] : undefined;
}
