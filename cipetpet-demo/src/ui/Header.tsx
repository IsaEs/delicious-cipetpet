import type { ReactElement } from "react";
import type { ModelView } from "../voice/cipetpet.ts";
import { useT, type MessageKey } from "./i18n.ts";
import { GearIcon, MonitorIcon, MoonIcon, SunIcon, WaveIcon } from "./icons.tsx";
import type { ThemeChoice } from "./settings.ts";

const MB = 1024 * 1024;

function ModelCard({ name, role, view, sizeMb }: { name: string; role: string; view: ModelView; sizeMb: number }): ReactElement {
  const t = useT();
  let status: string;
  if (view.status === "loading") {
    status =
      view.totalBytes > 0 && view.loadedBytes < view.totalBytes
        ? t("model.downloading", { loaded: (view.loadedBytes / MB).toFixed(1), total: (view.totalBytes / MB).toFixed(1) })
        : view.totalBytes > 0
          ? t("model.preparing")
          : `${t("model.loading")} (~${sizeMb} MB)`;
  } else {
    status = t(`model.${view.status}` as MessageKey);
  }
  const pct = view.status === "ready" ? 100 : view.progress !== null ? Math.round(view.progress * 100) : null;
  return (
    <div className={`model-card is-${view.status}`}>
      <div className="model-card__head">
        <span className="model-card__dot" aria-hidden="true" />
        <span className="model-card__name">{name}</span>
        <span className="model-card__role">{role}</span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label={`${name} ${role}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={status}
      >
        <div className={`progress__bar${pct === null && view.status === "loading" ? " is-indeterminate" : ""}`} style={{ width: pct === null ? undefined : `${pct}%` }} />
      </div>
      <div className="model-card__status">
        <span title={view.error?.message}>{view.status === "ready" && view.detail ? `${status} · ${view.detail}` : status}</span>
        {view.status === "error" && (
          <button type="button" className="link-button" onClick={view.retry}>
            {t("model.retry")}
          </button>
        )}
      </div>
      {view.status === "error" && view.error && <p className="model-card__error">{view.error.message}</p>}
    </div>
  );
}

export interface HeaderProps {
  tts: ModelView;
  stt: ModelView;
  /** the text-to-speech model's name (Antalia-2 Mini / EMA Lightning) */
  ttsName: string;
  ttsMb: number;
  sttMb: number;
  theme: ThemeChoice;
  onTheme(): void;
  onLang(): void;
  onSettings(): void;
}

export function Header({ tts, stt, ttsName, ttsMb, sttMb, theme, onTheme, onLang, onSettings }: HeaderProps): ReactElement {
  const t = useT();
  const loading = tts.status === "loading" || stt.status === "loading";
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
  const ThemeIcon = theme === "light" ? SunIcon : theme === "dark" ? MoonIcon : MonitorIcon;
  return (
    <header className="header">
      <div className="header__top">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <WaveIcon />
          </span>
          <div>
            <h1 className="brand__title">{t("app.title")}</h1>
            <p className="brand__tagline">{t("app.tagline", { tts: ttsName })}</p>
          </div>
        </div>
        <div className="header__actions">
          <button type="button" className="icon-button" onClick={onLang} aria-label={t("header.langLabel")} title={t("header.langLabel")}>
            <span className="icon-button__text">{t("header.lang")}</span>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onTheme}
            aria-label={`${t("header.theme")}: ${t(`theme.${theme}` as MessageKey)}`}
            title={`${t("header.theme")}: ${t(`theme.${theme}` as MessageKey)}`}
          >
            <ThemeIcon />
          </button>
          <button type="button" className="icon-button" onClick={onSettings} aria-label={t("header.settings")} title={t("header.settings")}>
            <GearIcon />
          </button>
        </div>
      </div>
      <div className="models" aria-label="models">
        <ModelCard name={t("model.stt")} role={t("model.sttRole")} view={stt} sizeMb={sttMb} />
        <ModelCard name={ttsName} role={t("model.ttsRole")} view={tts} sizeMb={ttsMb} />
      </div>
      {loading && <p className="header__note">{t("model.firstLoad", { tts: ttsMb, stt: sttMb })}</p>}
      {!isolated && <p className="header__note is-warning">{t("model.notIsolated")}</p>}
    </header>
  );
}
