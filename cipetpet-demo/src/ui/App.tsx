import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { VoiceProvider, workerSupported } from "../voice/cipetpet.ts";
import { Conversation } from "./Conversation.tsx";
import { I18nContext, translator } from "./i18n.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";
import { useTheme } from "./theme.ts";
import { useServerConfig } from "./useServerConfig.ts";

export function App(): ReactElement {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  useEffect(() => saveSettings(settings), [settings]);
  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  const server = useServerConfig();
  useTheme(settings.theme);

  const i18n = useMemo(() => ({ lang: settings.uiLang, t: translator(settings.uiLang) }), [settings.uiLang]);
  useEffect(() => {
    document.documentElement.lang = settings.uiLang;
    document.title = i18n.t("app.title");
  }, [settings.uiLang, i18n]);

  const voice = useMemo(
    () => ({ sttPrecision: settings.sttPrecision, useWorker: settings.useWorker && workerSupported(), integrity: server.packs }),
    [settings.sttPrecision, settings.useWorker, server.packs],
  );

  // The model options include the pack digests from /api/config; a change of options reloads the models, so the
  // downloads wait for that one small request (it falls back to "no digests" when there is no demo server).
  if (!server.loaded) return <I18nContext.Provider value={i18n}>{null}</I18nContext.Provider>;

  return (
    <I18nContext.Provider value={i18n}>
      <VoiceProvider config={voice}>
        <Conversation settings={settings} update={update} server={server} />
      </VoiceProvider>
    </I18nContext.Provider>
  );
}
