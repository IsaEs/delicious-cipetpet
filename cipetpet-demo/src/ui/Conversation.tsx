// The page body: transcript, controls, settings, toasts. Wires the ConversationController to React.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { ConversationController } from "../conversation/controller.ts";
import type { Message } from "../conversation/types.ts";
import { createDirectBackend } from "../llm/direct.ts";
import { createEchoBackend } from "../llm/echo.ts";
import { createProxyBackend } from "../llm/proxy.ts";
import type { BackendKind, ChatBackend } from "../llm/types.ts";
import { createAudioOut, createMicInput, PACK_MB, sttPack, TTS_PACK, useVoiceModels, workerSupported } from "../voice/cipetpet.ts";
import { Composer, LevelMeter, MicButton, StatusPill, StopButton, Switch } from "./Controls.tsx";
import { conversationJson, downloadText } from "./exportConversation.ts";
import { Header } from "./Header.tsx";
import { useT, type MessageKey } from "./i18n.ts";
import { DownloadIcon, InfoIcon, TrashIcon } from "./icons.tsx";
import { SettingsDrawer } from "./SettingsDrawer.tsx";
import { conversationSettings, loadRememberedKey, rememberKey, type Settings } from "./settings.ts";
import { nextTheme } from "./theme.ts";
import { Toasts } from "./Toasts.tsx";
import { Transcript } from "./Transcript.tsx";
import type { ServerConfig } from "./useServerConfig.ts";

export function resolveBackend(choice: Settings["backend"], server: ServerConfig): BackendKind {
  if (choice === "direct" || choice === "echo") return choice;
  // "auto" and "proxy" use the proxy when the server has a key (or while we do not know yet)
  return server.proxy || !server.loaded ? "proxy" : "echo";
}

const isTyping = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(el.tagName));

function useAnnouncer(messages: Message[], t: ReturnType<typeof useT>): string {
  const [text, setText] = useState("");
  const done = useRef(new Set<string>());
  useEffect(() => {
    const last = messages[messages.length - 1];
    const prev = messages[messages.length - 2];
    for (const m of [prev, last]) {
      if (!m || done.current.has(m.id)) continue;
      if (m.role === "user") {
        done.current.add(m.id);
        setText(`${t("msg.you")}: ${m.text}`);
      } else if (m.status !== "pending" && m.status !== "streaming" && m.text) {
        done.current.add(m.id);
        setText(`${t("msg.assistant")}: ${m.text}`);
      }
    }
  }, [messages, t]);
  return text;
}

export interface ConversationProps {
  settings: Settings;
  update(patch: Partial<Settings>): void;
  server: ServerConfig;
}

export function Conversation({ settings, update, server }: ConversationProps): ReactElement {
  const t = useT();
  const models = useVoiceModels();
  const [drawer, setDrawer] = useState(false);

  // direct mode key: memory only, unless the user ticks "remember"
  const [apiKey, setApiKey] = useState(loadRememberedKey);
  const [remember, setRemember] = useState(() => loadRememberedKey() !== "");
  useEffect(() => rememberKey(apiKey, remember), [apiKey, remember]);

  const backendKind = resolveBackend(settings.backend, server);
  const keyRef = useRef(apiKey);
  keyRef.current = apiKey;
  const backend = useMemo<ChatBackend>(() => {
    if (backendKind === "direct") return createDirectBackend({ getKey: () => keyRef.current });
    if (backendKind === "echo") return createEchoBackend();
    return createProxyBackend();
  }, [backendKind]);

  // the controller reads the latest engines / settings through this ref on every turn
  const live = useRef({ settings, server, backend, tts: models.ttsEngine, stt: models.sttEngine });
  live.current = { settings, server, backend, tts: models.ttsEngine, stt: models.sttEngine };

  const [controller] = useState(
    () =>
      new ConversationController(
        {
          getStt: () => live.current.stt,
          getTts: () => live.current.tts,
          getBackend: () => live.current.backend,
          getSettings: () => conversationSettings(live.current.settings, live.current.server.defaultModel),
          mic: createMicInput(),
          audio: createAudioOut(),
        },
        { handsFree: settings.handsFree },
      ),
  );
  // stop (not dispose): StrictMode runs this cleanup and the effect again on the same controller.
  // A persisted hands-free preference starts armed but paused ("hands-free paused"): the first press of the
  // mic button starts listening. Opening the mic on mount would race the model download (no speech
  // recognition yet) and has no user gesture, so the browser keeps audio suspended.
  useEffect(() => () => controller.stop(), [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const announcement = useAnnouncer(state.messages, t);
  const sttReady = models.sttEngine !== null;
  const ttsReady = models.ttsEngine !== null;

  // keyboard: Space = push-to-talk (outside text fields and buttons), Esc = stop
  useEffect(() => {
    let spaceHeld = false;
    const down = (e: KeyboardEvent) => {
      if (drawer) return;
      if (e.key === "Escape") {
        controller.stop();
        return;
      }
      if (e.code !== "Space" || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (e.repeat || spaceHeld || !sttReady) return;
      spaceHeld = true;
      controller.micDown();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !spaceHeld) return;
      e.preventDefault();
      spaceHeld = false;
      controller.micUp();
    };
    const blur = () => {
      if (spaceHeld) {
        spaceHeld = false;
        controller.micUp();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [controller, drawer, sttReady]);

  const closeDrawer = useCallback(() => setDrawer(false), []);
  const onDismiss = useCallback((id: number) => controller.dismiss(id), [controller]);
  const onSpeakAgain = useCallback((id: string) => controller.speakAgain(id), [controller]);

  const exportJson = () => {
    const model = backendKind === "echo" ? "echo" : settings.model || server.defaultModel;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadText(conversationJson(state.messages, settings, backendKind, model), `cipetpet-conversation-${stamp}.json`);
  };

  const busy = state.phase !== "idle";
  const hint = !sttReady ? t("mic.notReady") : state.handsFree ? t("mic.hintHandsFree") : t("mic.hint");

  return (
    <div className="app">
      <a className="skip-link" href="#composer-input">
        {t("composer.placeholder")}
      </a>
      <Header
        tts={models.tts}
        stt={models.stt}
        ttsMb={PACK_MB[TTS_PACK]}
        sttMb={PACK_MB[sttPack(settings.sttPrecision)]}
        theme={settings.theme}
        onTheme={() => update({ theme: nextTheme(settings.theme) })}
        onLang={() => update({ uiLang: settings.uiLang === "tr" ? "en" : "tr" })}
        onSettings={() => setDrawer(true)}
      />

      {server.loaded && !server.proxy && settings.backend === "auto" && (
        <div className="banner" role="note">
          <InfoIcon />
          <p>{t("banner.noProxy")}</p>
          <button type="button" className="button button--small" onClick={() => setDrawer(true)}>
            {t("banner.openSettings")}
          </button>
        </div>
      )}

      <main className="chat">
        {state.messages.length === 0 ? (
          <section className="empty">
            <h2>{t("empty.title")}</h2>
            <p>{t("empty.body")}</p>
            <p className="empty__try">{t("empty.try")}</p>
            <div className="chips">
              {(["suggest.1", "suggest.2", "suggest.3"] as MessageKey[]).map((k) => (
                <button key={k} type="button" className="chip" onClick={() => controller.sendText(t(k))}>
                  {t(k)}
                </button>
              ))}
            </div>
          </section>
        ) : (
          <>
            <div className="chat__toolbar">
              <button type="button" className="link-button" onClick={exportJson}>
                <DownloadIcon width={16} height={16} />
                {t("toolbar.export")}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  if (globalThis.confirm?.(t("toolbar.clearConfirm")) ?? true) controller.clear();
                }}
              >
                <TrashIcon width={16} height={16} />
                {t("toolbar.clear")}
              </button>
            </div>
            <Transcript messages={state.messages} onSpeakAgain={onSpeakAgain} canSpeak={ttsReady} />
          </>
        )}
      </main>

      <footer className="dock">
        <div className="dock__status">
          <StatusPill phase={state.phase} handsFree={state.handsFree} />
          <LevelMeter subscribe={controller.subscribeLevel} getLevel={controller.getLevel} active={state.phase === "listening"} />
        </div>
        <div className="dock__controls">
          <Switch
            checked={state.handsFree}
            label={t("handsFree")}
            hint={t("handsFree.hint")}
            onChange={(on) => {
              update({ handsFree: on });
              controller.setHandsFree(on);
            }}
          />
          <MicButton phase={state.phase} disabled={!sttReady} onDown={() => controller.micDown()} onUp={() => controller.micUp()} />
          <StopButton onStop={() => controller.stop()} disabled={!busy} />
        </div>
        <p className="dock__hint">{hint}</p>
        <Composer onSend={(text) => controller.sendText(text)} />
      </footer>

      <Toasts notices={state.notices} onDismiss={onDismiss} />
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <SettingsDrawer
        open={drawer}
        onClose={closeDrawer}
        settings={settings}
        update={update}
        effectiveBackend={backendKind}
        proxyAvailable={server.proxy}
        defaultModel={server.defaultModel}
        apiKey={apiKey}
        setApiKey={setApiKey}
        remember={remember}
        setRemember={setRemember}
        workerSupported={workerSupported()}
      />
    </div>
  );
}
