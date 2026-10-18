// Mirrors cipetpet's DuyuLanguage / precision unions, so pure modules need not import the core.
export type DuyuLanguage = "tr" | "en" | "mix" | "auto";
export type DuyuPrecision = "int8" | "q4";
export const STT_LANGUAGES: DuyuLanguage[] = ["mix", "tr", "en", "auto"];
export const STT_PRECISIONS: DuyuPrecision[] = ["int8", "q4"];
