// User settings (persisted in localStorage, best effort) and the direct-mode API key (memory only, unless the
// user explicitly asks to remember it).

import { DEFAULT_SYSTEM_PROMPT } from "../conversation/prompt.ts";
import type { ConversationSettings } from "../conversation/controller.ts";
import { vadPreset, type VadSensitivity } from "../voice/vad.ts";
import type { DuyuLanguage, DuyuPrecision } from "../voice/languages.ts";
import type { UiLang } from "./i18n.ts";

export type BackendChoice = "auto" | "proxy" | "direct" | "echo";
export type ThemeChoice = "system" | "light" | "dark";

export interface Settings {
  backend: BackendChoice;
  /** "" = the server's default model */
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  sttLang: DuyuLanguage;
  sttPrecision: DuyuPrecision;
  sttBeam: number;
  ttsSpeed: number;
  ttsSeed: number;
  handsFree: boolean;
  sensitivity: VadSensitivity;
  endSilenceMs: number;
  echoCancellation: boolean;
  bargeIn: boolean;
  useWorker: boolean;
  uiLang: UiLang;
  theme: ThemeChoice;
}

export const DEFAULT_SETTINGS: Settings = {
  backend: "auto",
  model: "",
  temperature: 0.7,
  maxTokens: 300,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  sttLang: "mix",
  sttPrecision: "int8",
  sttBeam: 5,
  ttsSpeed: 0.95,
  ttsSeed: 0,
  handsFree: false,
  sensitivity: "medium",
  endSilenceMs: 900,
  echoCancellation: false,
  bargeIn: true,
  useWorker: false,
  uiLang: "tr",
  theme: "system",
};

const SETTINGS_KEY = "cipetpet-demo:settings:v1";
const API_KEY_KEY = "cipetpet-demo:openrouter-key";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked (privacy mode, sandboxed iframe)
  }
}

const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

/** validates whatever was stored (older versions, hand edits) field by field */
export function sanitizeSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  return {
    backend: oneOf(o.backend, ["auto", "proxy", "direct", "echo"], d.backend),
    model: typeof o.model === "string" ? o.model.trim().slice(0, 200) : d.model,
    temperature: clamp(o.temperature, 0, 2, d.temperature),
    maxTokens: Math.round(clamp(o.maxTokens, 16, 4096, d.maxTokens)),
    systemPrompt: typeof o.systemPrompt === "string" && o.systemPrompt.trim() ? o.systemPrompt.slice(0, 8000) : d.systemPrompt,
    sttLang: oneOf(o.sttLang, ["mix", "tr", "en", "auto"], d.sttLang),
    sttPrecision: oneOf(o.sttPrecision, ["int8", "q4"], d.sttPrecision),
    sttBeam: Math.round(clamp(o.sttBeam, 1, 8, d.sttBeam)),
    ttsSpeed: clamp(o.ttsSpeed, 0.6, 1.5, d.ttsSpeed),
    ttsSeed: Math.round(clamp(o.ttsSeed, 0, 2 ** 31 - 1, d.ttsSeed)),
    handsFree: typeof o.handsFree === "boolean" ? o.handsFree : d.handsFree,
    sensitivity: oneOf(o.sensitivity, ["low", "medium", "high"], d.sensitivity),
    endSilenceMs: Math.round(clamp(o.endSilenceMs, 400, 3000, d.endSilenceMs)),
    echoCancellation: typeof o.echoCancellation === "boolean" ? o.echoCancellation : d.echoCancellation,
    bargeIn: typeof o.bargeIn === "boolean" ? o.bargeIn : d.bargeIn,
    useWorker: typeof o.useWorker === "boolean" ? o.useWorker : d.useWorker,
    uiLang: oneOf(o.uiLang, ["tr", "en"], d.uiLang),
    theme: oneOf(o.theme, ["system", "light", "dark"], d.theme),
  };
}

export function loadSettings(): Settings {
  const s = storage();
  let raw: unknown = null;
  try {
    raw = JSON.parse(s?.getItem(SETTINGS_KEY) ?? "null");
  } catch {
    // corrupt: defaults
  }
  const settings = sanitizeSettings(raw);
  if (!raw) {
    // first visit: follow the browser's language for the UI
    const nav = globalThis.navigator?.language ?? "tr";
    settings.uiLang = nav.toLowerCase().startsWith("tr") ? "tr" : "en";
  }
  return settings;
}

export function saveSettings(settings: Settings): void {
  try {
    storage()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // quota / blocked: settings just do not persist
  }
}

/** the remembered key, if the user opted in earlier */
export function loadRememberedKey(): string {
  try {
    return storage()?.getItem(API_KEY_KEY) ?? "";
  } catch {
    return "";
  }
}

/** remember = true stores the key in localStorage; false removes any stored copy */
export function rememberKey(key: string, remember: boolean): void {
  try {
    const s = storage();
    if (remember && key) s?.setItem(API_KEY_KEY, key);
    else s?.removeItem(API_KEY_KEY);
  } catch {
    // ignore
  }
}

/** the controller's view of the settings */
export function conversationSettings(s: Settings, defaultModel: string): ConversationSettings {
  return {
    model: s.model || defaultModel,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    systemPrompt: s.systemPrompt,
    sttLang: s.sttLang,
    sttBeam: s.sttBeam,
    ttsSpeed: s.ttsSpeed,
    ttsSeed: s.ttsSeed,
    vad: { ...vadPreset(s.sensitivity), endSilenceMs: s.endSilenceMs },
    echoCancellation: s.echoCancellation,
    bargeIn: s.bargeIn && s.echoCancellation,
    history: { maxChars: 12000, maxTurns: 12 },
  };
}
