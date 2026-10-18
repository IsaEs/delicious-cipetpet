import { useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import type { Phase } from "../conversation/types.ts";
import { useT, type MessageKey } from "./i18n.ts";
import { MicIcon, SendIcon, StopIcon } from "./icons.tsx";

export function LevelMeter({ subscribe, getLevel, active }: { subscribe(fn: () => void): () => void; getLevel(): number; active: boolean }): ReactElement {
  const t = useT();
  const level = useSyncExternalStore(subscribe, getLevel, () => 0);
  // RMS of speech is ~0.02-0.3: a square-root curve makes quiet speech visible
  const shown = active ? Math.min(1, Math.sqrt(level) * 1.6) : 0;
  const bars = 12;
  const lit = Math.round(shown * bars);
  return (
    <div className={`meter${active ? " is-active" : ""}`} role="meter" aria-label={t("mic.level")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown * 100)}>
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} className={i < lit ? "is-lit" : undefined} style={{ height: `${30 + (i / (bars - 1)) * 70}%` }} />
      ))}
    </div>
  );
}

export function StatusPill({ phase, handsFree }: { phase: Phase; handsFree: boolean }): ReactElement {
  const t = useT();
  const label = phase === "idle" && handsFree ? t("phase.handsFreePaused") : t(`phase.${phase}` as MessageKey);
  return (
    <div className={`status status--${phase}`} role="status" aria-live="polite">
      <span className="status__dot" aria-hidden="true" />
      {label}
    </div>
  );
}

export interface MicButtonProps {
  phase: Phase;
  disabled: boolean;
  onDown(): void;
  onUp(): void;
}

/** hold to talk (release ends the turn) or tap to toggle; pointer and keyboard (Space / Enter) alike */
export function MicButton({ phase, disabled, onDown, onUp }: MicButtonProps): ReactElement {
  const t = useT();
  const down = useRef(false);
  const label =
    disabled ? t("mic.notReady") : phase === "listening" ? t("mic.stop") : phase === "thinking" || phase === "speaking" ? t("mic.interrupt") : t("mic.start");

  const press = () => {
    if (down.current || disabled) return;
    down.current = true;
    onDown();
  };
  const release = () => {
    if (!down.current) return;
    down.current = false;
    onUp();
  };

  return (
    <button
      type="button"
      className={`mic mic--${phase}`}
      aria-label={label}
      title={label}
      aria-pressed={phase === "listening"}
      aria-disabled={disabled}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        press();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          e.stopPropagation();
          press();
        }
      }}
      onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          release();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="mic__ring" aria-hidden="true" />
      {phase === "thinking" || phase === "transcribing" ? <span className="mic__spinner" aria-hidden="true" /> : <MicIcon width={34} height={34} />}
    </button>
  );
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string; disabled?: boolean }): ReactElement {
  return (
    <label className={`switch${disabled ? " is-disabled" : ""}`} title={hint}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      <span className="switch__label">{label}</span>
    </label>
  );
}

export function StopButton({ onStop, disabled }: { onStop(): void; disabled: boolean }): ReactElement {
  const t = useT();
  return (
    <button type="button" className="button button--ghost stop-button" onClick={onStop} disabled={disabled} aria-keyshortcuts="Escape" title={`${t("stop")} (${t("stop.hint")})`}>
      <StopIcon width={18} height={18} />
      <span>{t("stop")}</span>
      <kbd>{t("stop.hint")}</kbd>
    </button>
  );
}

export function Composer({ onSend }: { onSend(text: string): void }): ReactElement {
  const t = useT();
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    onSend(v);
    setText("");
  };
  return (
    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="composer-input">
        {t("composer.label")}
      </label>
      <input
        id="composer-input"
        className="composer__input"
        type="text"
        autoComplete="off"
        enterKeyHint="send"
        maxLength={2000}
        placeholder={t("composer.placeholder")}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      <button type="submit" className="button button--primary composer__send" disabled={!text.trim()} aria-label={t("composer.send")} title={t("composer.send")}>
        <SendIcon width={18} height={18} />
      </button>
    </form>
  );
}
