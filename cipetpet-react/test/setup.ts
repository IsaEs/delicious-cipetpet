import { afterEach, beforeEach, vi } from "vitest";

// Every test runs against the fake core (no inference, no Web Audio, no microphone). Mocked here, in the
// setup file, so that it applies before any module of the package imports "cipetpet".
vi.mock("cipetpet", () => import("./fake-core.js"));

import { fake } from "./fake-core.js";
import { clearModelCache, modelRegistry, DEFAULT_DISPOSE_DELAY_MS } from "../src/registry.js";

beforeEach(() => {
  fake.reset();
  modelRegistry.defaultDisposeDelayMs = DEFAULT_DISPOSE_DELAY_MS;
});

afterEach(async () => {
  // jsdom tests unmount what they rendered (testing-library's auto cleanup needs vitest globals)
  if (typeof document !== "undefined") {
    const { cleanup } = await import("@testing-library/react");
    cleanup();
  }
  clearModelCache();
  vi.useRealTimers();
});
