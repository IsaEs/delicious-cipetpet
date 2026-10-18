// Model id: free text, plus the provider's list (OpenRouter's public index, the demo server's /api/models, or a direct
// endpoint's GET /models), fetched only when the user opens it.

import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { loadModelsFrom, type ModelList, type ModelSource } from "../llm/models.ts";
import { useT } from "./i18n.ts";

export interface ModelPickerProps {
  value: string;
  /** the provider's default ("" = it has none, a model must be typed or picked) */
  defaultModel: string;
  /** where the list comes from (remount the picker, e.g. with a `key`, when it changes) */
  source: ModelSource;
  onChange(v: string): void;
}

export function ModelPicker({ value, defaultModel, source, onChange }: ModelPickerProps): ReactElement {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ModelList | null>(null);
  const [query, setQuery] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // read when the list is fetched: a new object per render must not re-run the effect (it focuses the search box)
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    if (!open) return;
    let live = true;
    if (!list) loadModelsFrom(sourceRef.current).then((l) => live && setList(l));
    search.current?.focus();
    const onDoc = (e: MouseEvent) => {
      if (panel.current && !panel.current.parentElement?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      live = false;
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open, list]);
  // a list that could not be fetched is asked for again the next time the picker opens (a key typed since, a server
  // started since)
  useEffect(() => {
    if (!open && list && !list.live) setList(null);
  }, [open, list]);

  const shown = useMemo(() => {
    if (!list) return [];
    const q = query.trim().toLowerCase();
    const all = q ? list.models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : list.models;
    return all.slice(0, 200);
  }, [list, query]);

  return (
    <div className="picker">
      <label className="field__label" htmlFor={`${id}-model`}>
        {t("settings.model")}
      </label>
      <div className="picker__row">
        <input
          id={`${id}-model`}
          className="input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder={defaultModel || t("settings.modelRequired")}
          aria-invalid={!value && !defaultModel ? true : undefined}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
        <button type="button" className="button" aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen((o) => !o)}>
          {t("settings.modelBrowse")}
        </button>
      </div>
      <p className={`field__hint${!value && !defaultModel ? " is-warning" : ""}`}>{defaultModel ? t("settings.modelDefault", { model: defaultModel }) : t("settings.modelNone")}</p>
      {open && (
        <div
          ref={panel}
          className="picker__panel"
          id={`${id}-list`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <input
            ref={search}
            className="input"
            type="search"
            aria-label={t("settings.modelSearch")}
            placeholder={t("settings.modelSearch")}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {!list && <p className="field__hint">{t("settings.modelLoading")}</p>}
          {list && !list.live && (
            <p className="field__hint is-warning">{list.error ? t("settings.modelError", { message: list.error }) : t("settings.modelOffline")}</p>
          )}
          <ul className="picker__list" role="listbox" aria-label={t("settings.model")}>
            {shown.map((m) => (
              <li key={m.id} role="option" aria-selected={m.id === (value || defaultModel)}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                >
                  <span className="picker__name">{m.name}</span>
                  <span className="picker__id">
                    {m.id}
                    {m.promptPrice !== undefined && m.completionPrice !== undefined ? ` · $${m.promptPrice}/$${m.completionPrice} /M` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
