import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Same aliases as scripts/build.mjs. Only the UI smoke test reaches the adapter (src/voice/cipetpet.ts),
    // and it replaces it with vi.mock, so the sibling sources are never executed by the test suite.
    alias: {
      cipetpet: here("../cipetpet/src/index.ts"),
      "cipetpet-react": here("../cipetpet-react/src/index.ts"),
    },
  },
  define: {
    __CIPETPET_WORKER_URL__: "null",
    __DEMO_VERSION__: JSON.stringify("test"),
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    testTimeout: 15000,
  },
});
