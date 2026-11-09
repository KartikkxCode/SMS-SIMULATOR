import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/main.tsx", "src/**/*.test.{ts,tsx}"],
        reporter: ["text-summary", "text"],
        // The wizard screens are exercised by the browser suite (npm run e2e); this guards the unit-tested parts.
        thresholds: { lines: 20, statements: 22, functions: 19, branches: 15 },
      },
    },
  }),
);
