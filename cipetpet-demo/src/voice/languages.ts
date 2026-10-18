// Mirrors cipetpet's DuyuLanguage / precision unions, so pure modules need not import the core.
export type DuyuLanguage = "tr" | "en" | "mix" | "auto";
export type DuyuPrecision = "int8" | "q4";
export const STT_LANGUAGES: DuyuLanguage[] = ["mix", "tr", "en", "auto"];
export const STT_PRECISIONS: DuyuPrecision[] = ["int8", "q4"];

/** The text-to-speech model: Antalia-2 Mini or EMA Lightning (both Turkish only, 48 kHz). */
export type TtsModelChoice = "antalia" | "ema";
export const TTS_MODELS: TtsModelChoice[] = ["antalia", "ema"];
export const TTS_MODEL_NAMES: Record<TtsModelChoice, string> = { antalia: "Antalia-2 Mini", ema: "EMA Lightning" };
