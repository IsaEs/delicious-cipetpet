// User settings (persisted in localStorage, best effort) and the direct-mode API keys (memory only, unless the
// user explicitly asks to remember one). Keys are never part of the settings object, so they never reach an export.

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SYSTEM_PROMPT } from "../conversation/prompt.ts";
import type { ConversationSettings } from "../conversation/controller.ts";
import { modelKey, normalizeBaseUrl, OPENROUTER_ID, type CustomProvider } from "../llm/providers.ts";
import { vadPreset, type VadSensitivity } from "../voice/vad.ts";
import type { DuyuLanguage, DuyuPrecision, TtsModelChoice } from "../voice/languages.ts";
import type { UiLang } from "./i18n.ts";

export type BackendChoice = "auto" | "proxy" | "direct" | "echo";
export type ThemeChoice = "system" | "light" | "dark";

export interface Settings {
  backend: BackendChoice;
  /** proxy mode: the demo server's provider; "" = the server's default */
  proxyProvider: string;
  /** direct mode: "openrouter" or the id of one of customProviders */
  directProvider: string;
  /** OpenAI-compatible endpoints the user added for direct mode (their keys are kept apart) */
  customProviders: CustomProvider[];
  /** the model per provider, keyed "proxy:<id>" / "direct:<id>"; missing or "" = the provider's default */
  models: Record<string, string>;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  sttLang: DuyuLanguage;
  sttPrecision: DuyuPrecision;
  sttBeam: number;
  ttsModel: TtsModelChoice;
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
  proxyProvider: "",
  directProvider: OPENROUTER_ID,
  customProviders: [],
  models: {},
  temperature: 0.7,
  maxTokens: 300,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  sttLang: "mix",
  sttPrecision: "int8",
  sttBeam: 5,
  ttsModel: "antalia",
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
/** the OpenRouter key keeps the storage name it always had; other providers' keys get their own */
const API_KEY_KEY = "cipetpet-demo:openrouter-key";
const PROVIDER_KEY_PREFIX = "cipetpet-demo:key:";
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const MODEL_KEY = /^(proxy|direct):[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CUSTOM_PROVIDERS = 20;

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
const providerId = (v: unknown, d: string): string => (typeof v === "string" && (v === "" || PROVIDER_ID.test(v)) ? v : d);

function sanitizeProviders(v: unknown): CustomProvider[] {
  if (!Array.isArray(v)) return [];
  const out: CustomProvider[] = [];
  for (const p of v) {
    if (out.length >= MAX_CUSTOM_PROVIDERS) break;
    if (!p || typeof p !== "object") continue;
    const { id, name, baseUrl } = p as Record<string, unknown>;
    if (typeof id !== "string" || !PROVIDER_ID.test(id) || id === OPENROUTER_ID || out.some((o) => o.id === id)) continue;
    const url = typeof baseUrl === "string" ? normalizeBaseUrl(baseUrl) : null;
    if (!url) continue;
    out.push({ id, name: typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : id, baseUrl: url });
  }
  return out;
}

function sanitizeModels(v: unknown, legacyModel: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, m] of Object.entries(v)) {
      if (Object.keys(out).length >= 100) break;
      if (MODEL_KEY.test(k) && typeof m === "string" && m.trim()) out[k] = m.trim().slice(0, 200);
    }
  }
  // settings from before providers: one model, which was an OpenRouter id
  if (typeof legacyModel === "string" && legacyModel.trim()) {
    for (const k of [modelKey("proxy", OPENROUTER_ID), modelKey("direct", OPENROUTER_ID)]) out[k] ??= legacyModel.trim().slice(0, 200);
  }
  return out;
}

/** validates whatever was stored (older versions, hand edits) field by field */
export function sanitizeSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings | "model", unknown>>;
  const d = DEFAULT_SETTINGS;
  const customProviders = sanitizeProviders(o.customProviders);
  const direct = providerId(o.directProvider, d.directProvider);
  return {
    backend: oneOf(o.backend, ["auto", "proxy", "direct", "echo"], d.backend),
    proxyProvider: providerId(o.proxyProvider, d.proxyProvider),
    // a provider that was removed (or never existed) falls back to OpenRouter
    directProvider: direct === OPENROUTER_ID || customProviders.some((p) => p.id === direct) ? direct : d.directProvider,
    customProviders,
    models: sanitizeModels(o.models, o.model),
    temperature: clamp(o.temperature, 0, 2, d.temperature),
    maxTokens: Math.round(clamp(o.maxTokens, 16, 4096, d.maxTokens)),
    systemPrompt: typeof o.systemPrompt === "string" && o.systemPrompt.trim() ? o.systemPrompt.slice(0, 8000) : d.systemPrompt,
    sttLang: oneOf(o.sttLang, ["mix", "tr", "en", "auto"], d.sttLang),
    sttPrecision: oneOf(o.sttPrecision, ["int8", "q4"], d.sttPrecision),
    sttBeam: Math.round(clamp(o.sttBeam, 1, 8, d.sttBeam)),
    ttsModel: oneOf(o.ttsModel, ["antalia", "ema"], d.ttsModel),
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

const storageKeyFor = (provider: string): string => (provider === OPENROUTER_ID ? API_KEY_KEY : PROVIDER_KEY_PREFIX + provider);

/** the remembered key of a direct provider, if the user opted in earlier */
export function loadRememberedKey(provider: string = OPENROUTER_ID): string {
  try {
    return storage()?.getItem(storageKeyFor(provider)) ?? "";
  } catch {
    return "";
  }
}

/** remember = true stores the key in localStorage; false removes any stored copy */
export function rememberKey(key: string, remember: boolean, provider: string = OPENROUTER_ID): void {
  try {
    const s = storage();
    if (remember && key) s?.setItem(storageKeyFor(provider), key);
    else s?.removeItem(storageKeyFor(provider));
  } catch {
    // ignore
  }
}

export interface ApiKeys {
  /** the key of a direct provider ("" when none) */
  get(provider: string): string;
  remembered(provider: string): boolean;
  set(provider: string, key: string): void;
  setRemember(provider: string, remember: boolean): void;
  /** drops the key from memory and from storage */
  forget(provider: string): void;
}

/** The direct providers' keys: in memory, and in localStorage only for the providers the user ticked "remember" for. */
export function useApiKeys(): ApiKeys {
  const [state, setState] = useState<{ keys: Record<string, string>; remember: Record<string, boolean> }>(() => ({ keys: {}, remember: {} }));
  const read = useCallback(
    (provider: string) => (provider in state.keys ? { key: state.keys[provider], remember: !!state.remember[provider] } : { key: loadRememberedKey(provider), remember: loadRememberedKey(provider) !== "" }),
    [state],
  );
  const write = useCallback((provider: string, key: string, remember: boolean) => {
    setState((s) => ({ keys: { ...s.keys, [provider]: key }, remember: { ...s.remember, [provider]: remember } }));
  }, []);
  useEffect(() => {
    for (const provider of Object.keys(state.keys)) rememberKey(state.keys[provider], !!state.remember[provider], provider);
  }, [state]);
  return {
    get: (provider) => read(provider).key,
    remembered: (provider) => read(provider).remember,
    set: (provider, key) => write(provider, key, read(provider).remember),
    setRemember: (provider, remember) => write(provider, read(provider).key, remember),
    forget: (provider) => write(provider, "", false),
  };
}

/** the controller's view of the settings; `model` is the resolved model of the chosen provider */
export function conversationSettings(s: Settings, model: string): ConversationSettings {
  return {
    model,
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
