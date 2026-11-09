import { defineConfig, devices } from "@playwright/test";

// Each test file starts its own copy of the built app (and any mock APIs) on free ports.
export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 2,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1200, height: 900 },
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    // Use an already-installed Chromium if given (otherwise run `npx playwright install chromium` once).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
});
