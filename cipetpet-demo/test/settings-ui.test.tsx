// @vitest-environment jsdom
// The Settings drawer: adding, editing and removing an OpenAI-compatible endpoint in direct mode, choosing a server
// provider in proxy mode, and the voice model choice.
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatTarget } from "../src/ui/chatTarget.ts";
import { I18nContext, translator } from "../src/ui/i18n.ts";
import { SettingsDrawer } from "../src/ui/SettingsDrawer.tsx";
import { DEFAULT_SETTINGS, useApiKeys, type ApiKeys, type Settings } from "../src/ui/settings.ts";
import type { ServerConfig } from "../src/ui/useServerConfig.ts";

const SERVER: ServerConfig = {
  loaded: true,
  proxy: true,
  defaultModel: "openai/gpt-4o",
  provider: "openrouter",
  providers: [
    { id: "openrouter", name: "OpenRouter", kind: "openrouter", defaultModel: "openai/gpt-4o" },
    { id: "ollama", name: "Ollama (local)", kind: "openai", defaultModel: "llama3.2" },
  ],
  packs: { "antalia-mini-mixed.cpet": "sha256-x" },
};

let latest: Settings;
let keys: ApiKeys;

function Harness({ initial, missingTts = [] }: { initial: Partial<Settings>; missingTts?: ("antalia" | "ema")[] }): ReactElement {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS, uiLang: "en", ...initial });
  latest = settings;
  keys = useApiKeys();
  return (
    <I18nContext.Provider value={{ lang: "en", t: translator("en") }}>
      <SettingsDrawer
        open
        onClose={() => {}}
        settings={settings}
        update={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        target={chatTarget(settings, SERVER)}
        proxyAvailable
        serverProviders={SERVER.providers}
        keys={keys}
        missingTts={missingTts}
        workerSupported={false}
      />
    </I18nContext.Provider>
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("<SettingsDrawer> providers", () => {
  it("adds an OpenAI-compatible endpoint: selected, its model set, its key kept outside the settings", () => {
    render(<Harness initial={{ backend: "direct" }} />);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "__add__" } });
    fireEvent.change(screen.getByLabelText("API base URL"), { target: { value: "https://api.groq.com/openai/v1/chat/completions" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Groq" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "gsk-secret" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "llama-3.3-70b-versatile" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(latest.customProviders).toEqual([{ id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" }]);
    expect(latest.directProvider).toBe("groq");
    expect(latest.models["direct:groq"]).toBe("llama-3.3-70b-versatile");
    expect(JSON.stringify(latest)).not.toContain("gsk-secret");
    expect(keys.get("groq")).toBe("gsk-secret");
    expect(localStorage.getItem("cipetpet-demo:key:groq")).toBeNull(); // not remembered unless asked
    // the provider's own fields and the CORS note are shown for it
    expect(screen.getByLabelText("Groq API key")).toHaveProperty("value", "gsk-secret");
    expect(screen.getByText(/allow this page \(CORS\)/)).toBeTruthy();
  });

  it("refuses an unusable URL, and cancelling adds nothing", () => {
    render(<Harness initial={{ backend: "direct" }} />);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "__add__" } });
    fireEvent.change(screen.getByLabelText("API base URL"), { target: { value: "ftp://nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText(/Enter a valid http\(s\) URL/)).toBeTruthy();
    expect(latest.customProviders).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("API base URL")).toBeNull();
    expect(latest.directProvider).toBe("openrouter");
  });

  it("removes a custom endpoint with its key and model, back to OpenRouter", () => {
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const groq = { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" };
    localStorage.setItem("cipetpet-demo:key:groq", "gsk-remembered");
    render(<Harness initial={{ backend: "direct", directProvider: "groq", customProviders: [groq], models: { "direct:groq": "m" } }} />);
    expect(keys.get("groq")).toBe("gsk-remembered");
    fireEvent.click(screen.getByRole("button", { name: "Remove this provider" }));
    expect(latest.customProviders).toEqual([]);
    expect(latest.directProvider).toBe("openrouter");
    expect(latest.models).toEqual({});
    expect(localStorage.getItem("cipetpet-demo:key:groq")).toBeNull();
  });

  it("proxy mode with several server providers offers them; the model field follows the provider", () => {
    render(<Harness initial={{ backend: "proxy" }} />);
    const model = () => screen.getByLabelText("Model") as HTMLInputElement;
    expect(model().placeholder).toBe("openai/gpt-4o");
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "ollama" } });
    expect(latest.proxyProvider).toBe("ollama");
    expect(model().placeholder).toBe("llama3.2");
    fireEvent.change(model(), { target: { value: "qwen2.5:7b" } });
    expect(latest.models).toEqual({ "proxy:ollama": "qwen2.5:7b" });
  });
});

describe("<SettingsDrawer> voice model", () => {
  it("switches to EMA Lightning, and says when this server has no pack for a model", () => {
    render(<Harness initial={{}} missingTts={["ema"]} />);
    const select = screen.getByLabelText("Voice model") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["Antalia-2 Mini (~23 MB)", "EMA Lightning (~34 MB) · not on this server"]);
    fireEvent.change(select, { target: { value: "ema" } });
    expect(latest.ttsModel).toBe("ema");
    expect(screen.getByText(/This server has no pack for the model/)).toBeTruthy();
  });
});

describe("useApiKeys", () => {
  it("a key typed for one provider does not leak into another", () => {
    const { result } = renderHook(() => useApiKeys());
    act(() => result.current.set("a", "key-a"));
    expect(result.current.get("b")).toBe("");
  });
});
