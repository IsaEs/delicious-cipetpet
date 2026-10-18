import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CipetpetProvider, RecordButton, SpeakButton } from "../src/index.js";
import { fake } from "./fake-core.js";

describe("<SpeakButton>", () => {
  it("is disabled while loading, speaks on click, stops on the second click", async () => {
    fake.autoResolve = false;
    const onEnd = vi.fn();
    render(
      <CipetpetProvider tts={{ source: "/a.cpet" }}>
        <SpeakButton text="Merhaba." className="speak" onEnd={onEnd} />
      </CipetpetProvider>,
    );
    const button = screen.getByRole("button");
    expect(button.className).toBe("speak");
    await waitFor(() => expect(button).toHaveProperty("disabled", true));
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => fake.loads[0].resolve());
    expect(button).toHaveProperty("disabled", false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toBe("Speak");

    fireEvent.click(button);
    expect(fake.players).toHaveLength(1);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    expect(button.textContent).toBe("Stop");
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("false"));
    expect(fake.players[0].stopped).toBeGreaterThan(0);
    expect(onEnd).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(fake.players[1]?.chunks).toHaveLength(1));
    await act(async () => fake.players[1].endPlayback());
    await waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
  });

  it("supports render-function children", async () => {
    render(
      <SpeakButton text="Bir." options={{ source: "/a.cpet" }}>
        {(s) => `tts is ${s.status}`}
      </SpeakButton>,
    );
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("tts is ready"));
  });
});

describe("<RecordButton>", () => {
  it("toggles recording and reports the transcription", async () => {
    const onResult = vi.fn();
    render(<RecordButton options={{ source: "/d.cpet" }} lang="en" onResult={onResult} />);
    const button = screen.getByRole("button");
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    expect(button.textContent).toBe("Record");

    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
    expect(button.textContent).toBe("Stop");
    await waitFor(() => expect(fake.recorders).toHaveLength(1));

    fireEvent.click(button);
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult.mock.calls[0][0]).toMatchObject({ text: "heard 16000@16000#1", lang: "en" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("reports microphone errors through onError", async () => {
    fake.micGate = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    const onError = vi.fn();
    render(<RecordButton options={{ source: "/d.cpet" }} onError={onError} />);
    const button = screen.getByRole("button");
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toMatchObject({ name: "NotAllowedError" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });
});
