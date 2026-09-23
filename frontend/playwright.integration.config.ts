import { defineConfig } from "@playwright/test";

process.env.MANAGED_ML_STUB = "1";
export default defineConfig({
  testDir: ".",
  testMatch: ["tests/review.spec.ts", "integration/*.spec.ts"],
  timeout: 60000,
  expect: { timeout: 12000 },
  workers: 1,
  fullyParallel: false,
  outputDir: "test-results/integration",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/integration", open: "never" }],
             ["json", { outputFile: "test-results/integration-results.json" }]],
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 12000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off", // Reproducible without downloading Playwright's separate FFmpeg.
  },
});
