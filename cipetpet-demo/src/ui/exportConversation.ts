// "Export conversation": a JSON file with the messages and the settings that shaped them (never the API key).

import type { Message } from "../conversation/types.ts";
import type { Settings } from "./settings.ts";

export function conversationJson(messages: Message[], settings: Settings, backend: string, model: string, provider = ""): string {
  // the endpoints the user added are left out too: their URLs may point into a private network
  const { uiLang: _u, theme: _t, customProviders: _c, ...shaping } = settings;
  return JSON.stringify(
    {
      app: "cipetpet-demo",
      version: __DEMO_VERSION__,
      exportedAt: new Date().toISOString(),
      backend,
      ...(provider ? { provider } : {}),
      model,
      settings: shaping,
      messages: messages.map((m) =>
        m.role === "user"
          ? { role: m.role, text: m.text, source: m.source, at: new Date(m.at).toISOString(), sttMs: m.sttMs, lang: m.lang, audioSeconds: m.audioSeconds }
          : { role: m.role, text: m.text, status: m.status, model: m.model, backend: m.backend, at: new Date(m.at).toISOString(), timings: m.timings },
      ),
    },
    null,
    2,
  );
}

export function downloadText(text: string, filename: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
