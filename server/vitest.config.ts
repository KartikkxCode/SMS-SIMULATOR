import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Starting the real server is covered by the browser tests, not unit tests.
      exclude: ["src/index.ts"],
      reporter: ["text-summary", "text"],
      // Just under the measured values, so coverage can't quietly drop.
      thresholds: { lines: 96, statements: 94, functions: 94, branches: 84 },
    },
  },
});
