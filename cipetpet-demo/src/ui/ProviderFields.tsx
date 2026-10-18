// Settings for the direct backend: which provider (OpenRouter or an OpenAI-compatible endpoint the user added), its
// base URL and its API key. Keys never go into the settings object: they live in ApiKeys (memory, or localStorage
// for the providers the user ticked "remember" for).

import { useEffect, useId, useState, type ReactElement } from "react";
import { directProviders, insecureUrl, modelKey, newProviderId, normalizeBaseUrl, OPENROUTER_ID, type CustomProvider } from "../llm/providers.ts";
import { useT } from "./i18n.ts";
import { AlertIcon } from "./icons.tsx";
import type { ApiKeys, Settings } from "./settings.ts";

const ADD = "__add__";

function Check({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange(v: boolean): void }): ReactElement {
  const id = useId();
  return (
    <div className="field field--check">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** The form that adds an OpenAI-compatible endpoint. */
function AddProvider({ taken, onAdd, onCancel }: { taken: string[]; onAdd(p: CustomProvider, key: string, model: string): void; onCancel(): void }): ReactElement {
  const t = useT();
  const id = useId();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [tried, setTried] = useState(false);
  const baseUrl = normalizeBaseUrl(url);
  const submit = () => {
    setTried(true);
    if (!baseUrl) return;
    const shown = name.trim() || new URL(baseUrl).host;
    onAdd({ id: newProviderId(shown, taken), name: shown.slice(0, 60), baseUrl }, key.trim(), model.trim());
  };
  return (
    <div
      className="provider-form"
      role="group"
      aria-label={t("settings.provider.addTitle")}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          submit();
        }
      }}
    >
      <p className="field__label">{t("settings.provider.addTitle")}</p>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-url`}>
          {t("settings.provider.baseUrl")}
        </label>
        <input
          id={`${id}-url`}
          className="input"
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://api.openai.com/v1"
          value={url}
          aria-invalid={tried && !baseUrl ? true : undefined}
          onChange={(e) => setUrl(e.currentTarget.value)}
        />
        <p className={`field__hint${tried && !baseUrl ? " is-warning" : ""}`}>{tried && !baseUrl ? t("settings.provider.baseUrl.invalid") : t("settings.provider.baseUrl.hint")}</p>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-name`}>
          {t("settings.provider.name")}
        </label>
        <input id={`${id}-name`} className="input" type="text" autoComplete="off" placeholder={baseUrl ? new URL(baseUrl).host : "OpenAI, Groq, Ollama…"} value={name} onChange={(e) => setName(e.currentTarget.value)} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-key`}>
          {t("settings.apiKey")}
        </label>
        <input id={`${id}-key`} className="input" type="password" autoComplete="off" spellCheck={false} placeholder={t("settings.apiKey.optional")} value={key} onChange={(e) => setKey(e.currentTarget.value)} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-model`}>
          {t("settings.model")}
        </label>
        <input id={`${id}-model`} className="input" type="text" autoComplete="off" spellCheck={false} placeholder="gpt-4o-mini, llama3.2…" value={model} onChange={(e) => setModel(e.currentTarget.value)} />
        <p className="field__hint">{t("settings.provider.modelLater")}</p>
      </div>
      <div className="provider-form__actions">
        <button type="button" className="button" onClick={submit}>
          {t("settings.provider.save")}
        </button>
        <button type="button" className="button button--ghost" onClick={onCancel}>
          {t("settings.provider.cancel")}
        </button>
      </div>
    </div>
  );
}

/** A custom endpoint's name and base URL, edited in place (an invalid URL is not saved). */
function EditProvider({ provider, onChange }: { provider: CustomProvider; onChange(p: CustomProvider): void }): ReactElement {
  const t = useT();
  const id = useId();
  const [url, setUrl] = useState(provider.baseUrl);
  useEffect(() => setUrl(provider.baseUrl), [provider.baseUrl]);
  const valid = normalizeBaseUrl(url);
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-name`}>
          {t("settings.provider.name")}
        </label>
        <input
          id={`${id}-name`}
          className="input"
          type="text"
          autoComplete="off"
          value={provider.name}
          onChange={(e) => onChange({ ...provider, name: e.currentTarget.value.slice(0, 60) })}
          onBlur={(e) => !e.currentTarget.value.trim() && onChange({ ...provider, name: provider.id })}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-url`}>
          {t("settings.provider.baseUrl")}
        </label>
        <input
          id={`${id}-url`}
          className="input"
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          value={url}
          aria-invalid={!valid ? true : undefined}
          onChange={(e) => setUrl(e.currentTarget.value)}
          onBlur={() => (valid ? valid !== provider.baseUrl && onChange({ ...provider, baseUrl: valid }) : setUrl(provider.baseUrl))}
        />
        {!valid && <p className="field__hint is-warning">{t("settings.provider.baseUrl.invalid")}</p>}
      </div>
    </>
  );
}

export interface ProviderFieldsProps {
  settings: Settings;
  update(patch: Partial<Settings>): void;
  keys: ApiKeys;
  /** the "add an endpoint" form is open (the drawer hides the model picker meanwhile) */
  adding: boolean;
  setAdding(adding: boolean): void;
}

export function ProviderFields({ settings: s, update, keys, adding, setAdding }: ProviderFieldsProps): ReactElement {
  const t = useT();
  const selectId = useId();
  const keyId = useId();
  const all = directProviders(s.customProviders);
  const current = all.find((p) => p.id === s.directProvider) ?? all[0];
  const custom = s.customProviders.find((p) => p.id === current.id);
  const key = keys.get(current.id);

  const add = (p: CustomProvider, newKey: string, model: string) => {
    if (newKey) keys.set(p.id, newKey);
    update({
      customProviders: [...s.customProviders, p],
      directProvider: p.id,
      ...(model ? { models: { ...s.models, [modelKey("direct", p.id)]: model } } : {}),
    });
    setAdding(false);
  };
  const remove = (id: string) => {
    keys.forget(id);
    const { [modelKey("direct", id)]: _dropped, ...models } = s.models;
    update({ customProviders: s.customProviders.filter((p) => p.id !== id), directProvider: OPENROUTER_ID, models });
  };

  return (
    <div className="provider-fields">
      <div className="field">
        <label className="field__label" htmlFor={selectId}>
          {t("settings.provider")}
        </label>
        <select
          id={selectId}
          className="input"
          value={adding ? ADD : current.id}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v === ADD) return setAdding(true);
            setAdding(false);
            update({ directProvider: v });
          }}
        >
          {all.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === OPENROUTER_ID ? p.name : `${p.name} (${t("settings.provider.compatible")})`}
            </option>
          ))}
          <option value={ADD}>{t("settings.provider.add")}</option>
        </select>
      </div>

      {adding ? (
        <AddProvider taken={all.map((p) => p.id)} onAdd={add} onCancel={() => setAdding(false)} />
      ) : (
        <>
          {custom && <EditProvider provider={custom} onChange={(p) => update({ customProviders: s.customProviders.map((x) => (x.id === p.id ? p : x)) })} />}
          <div className="field key-field">
            <label className="field__label" htmlFor={keyId}>
              {t("settings.apiKeyFor", { provider: current.name })}
            </label>
            <input
              id={keyId}
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={current.kind === "openrouter" ? "sk-or-…" : t("settings.apiKey.optional")}
              value={key}
              onChange={(e) => keys.set(current.id, e.currentTarget.value.trim())}
            />
            <p className="callout callout--warning">
              <AlertIcon width={16} height={16} />
              <span>{t("settings.apiKeyWarning")}</span>
            </p>
            {custom && insecureUrl(custom.baseUrl) && key && (
              <p className="callout callout--warning">
                <AlertIcon width={16} height={16} />
                <span>{t("settings.provider.insecure")}</span>
              </p>
            )}
            {custom && <p className="field__hint">{t("settings.provider.cors")}</p>}
            <Check label={t("settings.rememberKey")} hint={t("settings.rememberKeyOff")} checked={keys.remembered(current.id)} onChange={(on) => keys.setRemember(current.id, on)} />
            <div className="provider-form__actions">
              {key && (
                <button type="button" className="link-button" onClick={() => keys.forget(current.id)}>
                  {t("settings.forgetKey")}
                </button>
              )}
              {custom && (
                <button
                  type="button"
                  className="link-button link-button--danger"
                  onClick={() => {
                    if (globalThis.confirm?.(t("settings.provider.removeConfirm", { provider: custom.name })) ?? true) remove(custom.id);
                  }}
                >
                  {t("settings.provider.remove")}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
