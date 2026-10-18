import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { DEFAULT_SYSTEM_PROMPT } from "../conversation/prompt.ts";
import type { ModelSource } from "../llm/models.ts";
import type { ServerProvider } from "../llm/providers.ts";
import { STT_LANGUAGES, STT_PRECISIONS, TTS_MODELS, type TtsModelChoice } from "../voice/languages.ts";
import type { ChatTarget } from "./chatTarget.ts";
import { useT, type MessageKey } from "./i18n.ts";
import { CloseIcon } from "./icons.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ProviderFields } from "./ProviderFields.tsx";
import { DEFAULT_SETTINGS, type ApiKeys, type Settings } from "./settings.ts";

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <fieldset className="section">
      <legend className="section__title">{title}</legend>
      {children}
    </fieldset>
  );
}

function Range(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  hint?: string;
  onChange(v: number): void;
}): ReactElement {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {props.label}
        <output htmlFor={id} className="field__value">
          {props.format ? props.format(props.value) : props.value}
        </output>
      </label>
      <input id={id} type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.currentTarget.value))} />
      {props.hint && <p className="field__hint">{props.hint}</p>}
    </div>
  );
}

function Check({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void }): ReactElement {
  const id = useId();
  return (
    <div className={`field field--check${disabled ? " is-disabled" : ""}`}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void }): ReactElement {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.currentTarget.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface SettingsDrawerProps {
  open: boolean;
  onClose(): void;
  settings: Settings;
  update(patch: Partial<Settings>): void;
  /** where chat requests go now (backend, provider, model) */
  target: ChatTarget;
  proxyAvailable: boolean;
  /** the demo server's providers */
  serverProviders: ServerProvider[];
  /** the direct providers' keys */
  keys: ApiKeys;
  /** TTS models whose pack this server is known not to have (from /api/config's pack list) */
  missingTts: TtsModelChoice[];
  workerSupported: boolean;
}

/** where the model picker gets its list for a target */
function modelSource(target: ChatTarget, keys: ApiKeys): ModelSource {
  if (target.kind === "openrouter") return { kind: "openrouter" };
  if (target.backend === "direct" && target.direct) {
    const id = target.direct.id;
    return { kind: "direct", baseUrl: target.direct.baseUrl, getKey: () => keys.get(id) };
  }
  return { kind: "proxy", provider: target.providerId };
}

export function SettingsDrawer(p: SettingsDrawerProps): ReactElement | null {
  const t = useT();
  const s = p.settings;
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const promptId = useId();
  const [addingProvider, setAddingProvider] = useState(false);
  useEffect(() => {
    if (!p.open) setAddingProvider(false); // a half-filled form does not come back with the drawer
  }, [p.open]);
  const tokensId = useId();
  const seedId = useId();

  useEffect(() => {
    if (!p.open) return;
    returnFocus.current = document.activeElement;
    panel.current?.querySelector<HTMLElement>("button, input, select, textarea")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        p.onClose();
        return;
      }
      // keep Tab inside the drawer
      if (e.key === "Tab" && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.hasAttribute("disabled"));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      (returnFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [p.open, p.onClose]);

  if (!p.open) return null;

  const target = p.target;
  const backendOptions: { value: Settings["backend"]; kind: ChatTarget["backend"]; disabled?: boolean; hint: string }[] = [
    { value: "proxy", kind: "proxy", disabled: !p.proxyAvailable, hint: p.proxyAvailable ? t("backend.proxy.hint") : t("backend.proxy.off") },
    { value: "direct", kind: "direct", hint: t("backend.direct.hint") },
    { value: "echo", kind: "echo", hint: t("backend.echo.hint") },
  ];

  return (
    <div className="drawer" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div ref={panel} className="drawer__panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="drawer__head">
          <h2 id="settings-title">{t("settings.title")}</h2>
          <button type="button" className="icon-button" onClick={p.onClose} aria-label={t("settings.close")} title={t("settings.close")}>
            <CloseIcon />
          </button>
        </div>
        <div className="drawer__body">
          <Section title={t("settings.chat")}>
            <div className="field" role="radiogroup" aria-label={t("settings.backend")}>
              <span className="field__label">{t("settings.backend")}</span>
              <div className="segmented">
                {backendOptions.map((o) => (
                  <label key={o.value} className={`segmented__item${target.backend === o.kind ? " is-checked" : ""}${o.disabled ? " is-disabled" : ""}`}>
                    <input
                      type="radio"
                      name="backend"
                      value={o.value}
                      checked={target.backend === o.kind}
                      disabled={o.disabled}
                      onChange={() => p.update({ backend: o.value })}
                    />
                    <span className="segmented__title">{t(`backend.${o.kind}` as MessageKey)}</span>
                    <span className="segmented__hint">{o.hint}</span>
                  </label>
                ))}
              </div>
            </div>

            {target.backend === "proxy" && p.serverProviders.length > 1 && (
              <Select
                label={t("settings.provider")}
                value={target.providerId}
                options={p.serverProviders.map((x) => ({ value: x.id, label: x.name }))}
                onChange={(proxyProvider) => p.update({ proxyProvider })}
              />
            )}
            {target.backend === "proxy" && p.serverProviders.length === 1 && <p className="field__hint">{t("settings.provider.serverOne", { provider: p.serverProviders[0].name })}</p>}

            {target.backend === "direct" && <ProviderFields settings={s} update={p.update} keys={p.keys} adding={addingProvider} setAdding={setAddingProvider} />}

            {target.backend !== "echo" && !(target.backend === "direct" && addingProvider) && (
              <ModelPicker
                key={`${target.modelKey}|${target.direct?.baseUrl ?? ""}`}
                value={s.models[target.modelKey] ?? ""}
                defaultModel={target.defaultModel}
                source={modelSource(target, p.keys)}
                onChange={(model) => p.update({ models: { ...s.models, [target.modelKey]: model.trim() ? model : "" } })}
              />
            )}
            <Range label={t("settings.temperature")} value={s.temperature} min={0} max={1.5} step={0.05} format={(v) => v.toFixed(2)} onChange={(temperature) => p.update({ temperature })} />
            <div className="field">
              <label className="field__label" htmlFor={tokensId}>
                {t("settings.maxTokens")}
              </label>
              <input id={tokensId} className="input input--narrow" type="number" min={16} max={4096} step={16} value={s.maxTokens} onChange={(e) => p.update({ maxTokens: Math.max(16, Math.min(4096, Number(e.currentTarget.value) || 16)) })} />
            </div>
            <div className="field">
              <label className="field__label" htmlFor={promptId}>
                {t("settings.systemPrompt")}
                {s.systemPrompt !== DEFAULT_SYSTEM_PROMPT && (
                  <button type="button" className="link-button" onClick={() => p.update({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}>
                    {t("settings.systemPromptReset")}
                  </button>
                )}
              </label>
              <textarea id={promptId} className="input textarea" rows={6} value={s.systemPrompt} onChange={(e) => p.update({ systemPrompt: e.currentTarget.value })} />
            </div>
          </Section>

          <Section title={t("settings.stt")}>
            <Select label={t("settings.sttLang")} value={s.sttLang} options={STT_LANGUAGES.map((v) => ({ value: v, label: t(`lang.${v}` as MessageKey) }))} onChange={(sttLang) => p.update({ sttLang })} />
            <Select label={t("settings.precision")} value={s.sttPrecision} options={STT_PRECISIONS.map((v) => ({ value: v, label: t(`precision.${v}` as MessageKey) }))} onChange={(sttPrecision) => p.update({ sttPrecision })} />
            <Range label={t("settings.beam")} value={s.sttBeam} min={1} max={8} step={1} hint={t("settings.beam.hint")} onChange={(sttBeam) => p.update({ sttBeam })} />
          </Section>

          <Section title={t("settings.tts")}>
            <Select
              label={t("settings.ttsModel")}
              value={s.ttsModel}
              options={TTS_MODELS.map((v) => ({ value: v, label: `${t(`ttsModel.${v}` as MessageKey)}${p.missingTts.includes(v) ? ` · ${t("settings.ttsModel.notHere")}` : ""}` }))}
              onChange={(ttsModel) => p.update({ ttsModel })}
            />
            <p className={`field__hint${p.missingTts.includes(s.ttsModel) ? " is-warning" : ""}`}>
              {p.missingTts.includes(s.ttsModel) ? t("settings.ttsModel.missing") : t(`ttsModel.${s.ttsModel}.hint` as MessageKey)}
            </p>
            <Range label={t("settings.speed")} value={s.ttsSpeed} min={0.7} max={1.3} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(ttsSpeed) => p.update({ ttsSpeed })} />
            <div className="field">
              <label className="field__label" htmlFor={seedId}>
                {t("settings.seed")}
              </label>
              <input id={seedId} className="input input--narrow" type="number" min={0} step={1} value={s.ttsSeed} onChange={(e) => p.update({ ttsSeed: Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)) })} />
              <p className="field__hint">{t("settings.seed.hint")}</p>
            </div>
          </Section>

          <Section title={t("settings.handsFree")}>
            <Select
              label={t("settings.sensitivity")}
              value={s.sensitivity}
              options={(["low", "medium", "high"] as const).map((v) => ({ value: v, label: t(`sensitivity.${v}` as MessageKey) }))}
              onChange={(sensitivity) => p.update({ sensitivity })}
            />
            <Range label={t("settings.endSilence")} value={s.endSilenceMs} min={400} max={2500} step={100} format={(v) => `${v} ms`} onChange={(endSilenceMs) => p.update({ endSilenceMs })} />
            <Check label={t("settings.echoCancellation")} hint={t("settings.echoCancellation.hint")} checked={s.echoCancellation} onChange={(echoCancellation) => p.update({ echoCancellation })} />
            <Check label={t("settings.bargeIn")} hint={t("settings.bargeIn.hint")} checked={s.bargeIn && s.echoCancellation} disabled={!s.echoCancellation} onChange={(bargeIn) => p.update({ bargeIn })} />
          </Section>

          <Section title={t("settings.performance")}>
            <Check
              label={t("settings.useWorker")}
              hint={p.workerSupported ? t("settings.useWorker.hint") : t("settings.useWorker.unsupported")}
              checked={s.useWorker && p.workerSupported}
              disabled={!p.workerSupported}
              onChange={(useWorker) => p.update({ useWorker })}
            />
          </Section>

          <Section title={t("settings.interface")}>
            <Select label={t("settings.uiLang")} value={s.uiLang} options={[{ value: "tr", label: "Türkçe" }, { value: "en", label: "English" }]} onChange={(uiLang) => p.update({ uiLang })} />
            <Select
              label={t("settings.theme")}
              value={s.theme}
              options={(["system", "light", "dark"] as const).map((v) => ({ value: v, label: t(`theme.${v}` as MessageKey) }))}
              onChange={(theme) => p.update({ theme })}
            />
          </Section>

          <p className="field__hint">{t("settings.privacy")}</p>
          <button
            type="button"
            className="button button--ghost"
            // the endpoints the user added are configuration, not tuning: a reset keeps them (their keys are not settings)
            onClick={() => p.update({ ...DEFAULT_SETTINGS, uiLang: s.uiLang, theme: s.theme, handsFree: s.handsFree, customProviders: s.customProviders })}
          >
            {t("settings.reset")}
          </button>
        </div>
      </div>
    </div>
  );
}
