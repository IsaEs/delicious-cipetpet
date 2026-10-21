// @vitest-environment jsdom
// The reply's footer: "Download audio" shows once the controller keeps the reply's speech, and asks for that reply.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/conversation/types.ts";
import { I18nContext, translator } from "../src/ui/i18n.ts";
import { Transcript } from "../src/ui/Transcript.tsx";

const reply = (over: Partial<AssistantMessage>): AssistantMessage => ({
  id: "a1",
  role: "assistant",
  text: "Merhaba!",
  status: "done",
  sentences: [{ start: 0, end: 8 }],
  speaking: null,
  timings: {},
  model: "m",
  backend: "proxy",
  at: 0,
  ...over,
});

function show(m: AssistantMessage, onDownload = vi.fn()) {
  render(
    <I18nContext.Provider value={{ lang: "en", t: translator("en") }}>
      <Transcript messages={[m]} onSpeakAgain={() => {}} onDownload={onDownload} canSpeak />
    </I18nContext.Provider>,
  );
  return onDownload;
}

afterEach(() => cleanup());

describe("<Transcript> download", () => {
  it("offers the reply's audio once it is kept, and downloads that reply's", () => {
    const onDownload = show(reply({ audioSeconds: 2.4 }));
    const button = screen.getByRole("button", { name: "Download audio" });
    expect(button.getAttribute("title")).toBe("Save the spoken reply as WAV (2.4 s)");
    fireEvent.click(button);
    expect(onDownload).toHaveBeenCalledWith("a1");
  });

  it("no button without kept audio, or while the reply is still coming", () => {
    show(reply({}));
    expect(screen.queryByRole("button", { name: "Download audio" })).toBeNull();
    cleanup();
    show(reply({ audioSeconds: 1, status: "streaming" }));
    expect(screen.queryByRole("button", { name: "Download audio" })).toBeNull();
  });
});
