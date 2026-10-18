import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // test/setup.ts replaces "cipetpet" with the fake core (vi.mock); the alias only gives the mock a
      // module id that resolves even before the core package is built.
      cipetpet: fileURLToPath(new URL("./test/cipetpet-placeholder.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
