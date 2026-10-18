// Thin, unstyled buttons on top of the hooks. Every other prop (className, style, aria-*, data-*) is passed
// to the <button>; children may be a render function of the current state.

import { useEffect, useRef, type ButtonHTMLAttributes, type MouseEvent, type ReactElement, type ReactNode } from "react";
import type { SynthesisOptions, TranscribeOptions, TranscriptionResult } from "cipetpet";
import type { ModelStatus } from "./registry.js";
import { useSpeechToText, type RecordingOptions, type SpeechToTextOptions } from "./useSpeechToText.js";
import { useTextToSpeech, type TextToSpeechOptions } from "./useTextToSpeech.js";
import { isAbortError, toError } from "./util.js";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onError">;

export interface SpeakButtonState {
  status: ModelStatus;
  isSpeaking: boolean;
  isSynthesizing: boolean;
}

export interface SpeakButtonProps extends ButtonProps {
  /** what to say */
  text: string;
  /** model + synthesis defaults (source, useWorker, seed, speed …); a provider supplies the rest */
  options?: TextToSpeechOptions;
  /** per-call synthesis options */
  synthesis?: Omit<SynthesisOptions, "signal">;
  /** playback finished (not called when stopped) */
  onEnd?: () => void;
  onError?: (error: Error) => void;
  /** default: "Speak" / "Stop" */
  children?: ReactNode | ((state: SpeakButtonState) => ReactNode);
}

/** Press to speak `text`, press again to stop. Disabled while the model loads or when there is no text. */
export function SpeakButton({
  text,
  options,
  synthesis,
  onEnd,
  onError,
  children,
  onClick,
  disabled,
  type = "button",
  ...rest
}: SpeakButtonProps): ReactElement {
  const tts = useTextToSpeech(options);
  // bumps on every speak / stop / unmount, so onEnd fires only for a speak that played to the end
  const runRef = useRef(0);
  useEffect(
    () => () => {
      runRef.current++;
    },
    [],
  );
  const busy = tts.isSpeaking || tts.isSynthesizing;
  const state: SpeakButtonState = { status: tts.status, isSpeaking: tts.isSpeaking, isSynthesizing: tts.isSynthesizing };

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    const id = ++runRef.current;
    if (busy) {
      tts.stop();
      return;
    }
    // speak() is called synchronously inside the click, so the AudioContext may start
    tts.speak(text, synthesis).then(
      () => {
        if (id === runRef.current) onEnd?.();
      },
      (err: unknown) => {
        if (id === runRef.current && !isAbortError(err)) onError?.(toError(err));
      },
    );
  };

  return (
    <button
      {...rest}
      type={type}
      onClick={handleClick}
      disabled={disabled || (!busy && (tts.status === "loading" || text.trim() === ""))}
      aria-pressed={busy}
      aria-busy={tts.status === "loading" || tts.isSynthesizing}
      data-status={tts.status}
    >
      {typeof children === "function" ? children(state) : (children ?? (busy ? "Stop" : "Speak"))}
    </button>
  );
}

export interface RecordButtonState {
  status: ModelStatus;
  isRecording: boolean;
  isTranscribing: boolean;
  /** microphone level 0..1 */
  level: number;
}

export interface RecordButtonProps extends ButtonProps {
  /** called with each transcription */
  onResult?: (result: TranscriptionResult) => void;
  onError?: (error: Error) => void;
  /** language of the speech (default: the hook's / whatever is spoken) */
  lang?: TranscribeOptions["lang"];
  /** model + transcription defaults (source, useWorker, mode, beam …); a provider supplies the rest */
  options?: SpeechToTextOptions;
  /** microphone options */
  recording?: RecordingOptions;
  /** default: "Record" / "Stop" / "Transcribing…" */
  children?: ReactNode | ((state: RecordButtonState) => ReactNode);
}

/** A toggle: press to start recording, press again to stop and transcribe. Disabled while the model loads
 * (unless recording) and while transcribing. */
export function RecordButton({
  onResult,
  onError,
  lang,
  options,
  recording,
  children,
  onClick,
  disabled,
  type = "button",
  ...rest
}: RecordButtonProps): ReactElement {
  const stt = useSpeechToText(options);
  const state: RecordButtonState = {
    status: stt.status,
    isRecording: stt.isRecording,
    isTranscribing: stt.isTranscribing,
    level: stt.level,
  };
  const report = (err: unknown) => {
    if (!isAbortError(err)) onError?.(toError(err));
  };

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    if (stt.isRecording) {
      stt.stopRecording(lang ? { lang } : undefined).then((r) => onResult?.(r), report);
    } else {
      stt.startRecording(recording).catch(report);
    }
  };

  const label = stt.isRecording ? "Stop" : stt.isTranscribing ? "Transcribing…" : "Record";
  return (
    <button
      {...rest}
      type={type}
      onClick={handleClick}
      disabled={disabled || (!stt.isRecording && (stt.status === "loading" || stt.isTranscribing))}
      aria-pressed={stt.isRecording}
      aria-busy={stt.status === "loading" || stt.isTranscribing}
      data-status={stt.status}
    >
      {typeof children === "function" ? children(state) : (children ?? label)}
    </button>
  );
}
